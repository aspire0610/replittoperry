import { clerkClient, type User } from "@clerk/express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { logger } from "./lib/logger.js";

const APP_METADATA_KEY = "twStockDashboard";
const STREAM_URL = "wss://api.fugle.tw/marketdata/v1.0/stock/streaming";
const POLL_INTERVAL_MS = 60_000;
const MARKET_ZONE = "Asia/Taipei";
const TAIWAN_INDEX_SYMBOL = "IX0001";

type Alert = {
  id: string;
  symbol: string;
  name: string;
  condition: "above" | "below";
  targetPrice: number;
  enabled: boolean;
};
type LineSettings = {
  lineUserId?: string;
  alerts?: Alert[];
  openingNotice?: boolean;
};
type QuoteTick = { symbol: string; price: number; asOf: Date };
type LinkedUser = { user: User; settings: LineSettings; symbols: Set<string> };

const latestTicks = new Map<string, QuoteTick>();
const openingTicks = new Map<string, { date: string; tick: QuoteTick }>();
const subscribedSymbols = new Set<string>();
const lastOpeningNotice = new Map<string, string>();
const sentAlerts = new Set<string>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let stopped = false;
let users: LinkedUser[] = [];
let latestIndex: { price: number; asOf: Date } | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;

function settingsFor(user: User): LineSettings {
  const root = user.privateMetadata[APP_METADATA_KEY];
  if (!root || typeof root !== "object" || Array.isArray(root)) return {};
  const settings = (root as Record<string, unknown>).lineNotifications;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  return settings as LineSettings;
}

function toTaiwanDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e14 ? value / 1000 : value > 1e11 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTick(raw: unknown): QuoteTick | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as {
    event?: unknown;
    channel?: unknown;
    data?: Record<string, unknown>;
  };
  if (message.event !== "data" || message.channel !== "aggregates" || !message.data) return null;
  const data = message.data;
  if (data.isTrial === true || data.lastTrial) return null;
  const symbol = typeof data.symbol === "string" ? data.symbol.toUpperCase() : "";
  const trade = data.lastTrade && typeof data.lastTrade === "object"
    ? data.lastTrade as Record<string, unknown>
    : {};
  const price = Number(trade.price ?? data.lastPrice);
  const asOf = parseTimestamp(trade.time ?? data.lastTime ?? data.time);
  if (
    !/^[A-Z0-9]{2,6}$/.test(symbol) ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !asOf ||
    Date.now() - asOf.getTime() > 180_000 ||
    asOf.getTime() > Date.now() + 30_000
  ) return null;
  return { symbol, price, asOf };
}

function sharedWorkerToken(): Buffer | null {
  const apiKey = process.env.FUGLE_API_KEY?.trim();
  return apiKey
    ? createHmac("sha256", apiKey).update("tw-stock-dashboard-realtime-relay-v1").digest()
    : null;
}

function authorizeRelay(request: import("node:http").IncomingMessage): boolean {
  const expected = sharedWorkerToken();
  const authorization = request.headers.authorization;
  if (!expected || typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const received = Buffer.from(authorization.slice(7), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function startRealtimeRelay(): void {
  if (httpServer) return;
  httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" || url.pathname === "/api/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    const isRelayPath = url.pathname === "/internal/realtime" || url.pathname === "/api/internal/realtime";
    if (!isRelayPath || request.method !== "GET" || !authorizeRelay(request)) {
      response.writeHead(isRelayPath ? 401 : 404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const symbol = (url.searchParams.get("symbol") ?? "").replace(/\.(TW|TWO)$/i, "").toUpperCase();
    const quote = symbol === TAIWAN_INDEX_SYMBOL || symbol === "TAIEX"
      ? latestIndex
      : latestTicks.get(symbol);
    if (!quote) {
      response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "quote unavailable" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ symbol, price: quote.price, asOf: quote.asOf.toISOString() }));
  });
  const port = Number(process.env.PORT ?? 8081);
  httpServer.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "LINE worker realtime relay listening");
  });
}

async function listLinkedUsers(): Promise<LinkedUser[]> {
  const result: LinkedUser[] = [];
  let offset = 0;
  while (offset < 5000) {
    const page = await clerkClient.users.getUserList({ limit: 500, offset });
    for (const user of page.data) {
      const settings = settingsFor(user);
      if (!settings.lineUserId) continue;
      const root = user.privateMetadata[APP_METADATA_KEY];
      const watchlist = root && typeof root === "object" && !Array.isArray(root)
        ? (root as Record<string, unknown>).watchlist
        : [];
      const symbols = new Set<string>();
      if (Array.isArray(watchlist)) {
        for (const item of watchlist) {
          if (item && typeof item === "object" && typeof (item as { symbol?: unknown }).symbol === "string") {
            symbols.add((item as { symbol: string }).symbol.replace(/\.(TW|TWO)$/i, "").toUpperCase());
          }
        }
      }
      for (const alert of settings.alerts ?? []) {
        if (alert.enabled) symbols.add(alert.symbol.replace(/\.(TW|TWO)$/i, "").toUpperCase());
      }
      result.push({ user, settings, symbols });
    }
    if (page.data.length < 500) break;
    offset += page.data.length;
  }
  return result;
}

async function pushText(userId: string, text: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`LINE push API returned HTTP ${response.status}`);
}

async function saveSettings(user: User, settings: LineSettings): Promise<void> {
  const current = user.privateMetadata[APP_METADATA_KEY];
  const root = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  await clerkClient.users.updateUserMetadata(user.id, {
    privateMetadata: { [APP_METADATA_KEY]: { ...root, lineNotifications: settings } },
  });
}

async function handleTick(tick: QuoteTick): Promise<void> {
  latestTicks.set(tick.symbol, tick);
  const day = toTaiwanDate(tick.asOf);
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(tick.asOf);
  const minuteOfDay =
    Number(timeParts.find((part) => part.type === "hour")?.value) * 60 +
    Number(timeParts.find((part) => part.type === "minute")?.value);
  if (minuteOfDay >= 9 * 60 && minuteOfDay < 9 * 60 + 10) {
    const previous = openingTicks.get(tick.symbol);
    if (!previous || previous.date !== day) openingTicks.set(tick.symbol, { date: day, tick });
  }
  for (const account of users) {
    if (!account.symbols.has(tick.symbol)) continue;
    const hit = (account.settings.alerts ?? []).find((alert) =>
      alert.enabled &&
      alert.symbol.replace(/\.(TW|TWO)$/i, "").toUpperCase() === tick.symbol &&
      (alert.condition === "above" ? tick.price >= alert.targetPrice : tick.price <= alert.targetPrice),
    );
    if (!hit) continue;
    const dedupeKey = `${account.user.id}:${hit.id}`;
    if (sentAlerts.has(dedupeKey)) continue;
    sentAlerts.add(dedupeKey);
    try {
      const next = {
        ...account.settings,
        alerts: (account.settings.alerts ?? []).map((alert) =>
          alert.id === hit.id ? { ...alert, enabled: false } : alert,
        ),
      };
      await saveSettings(account.user, next);
      account.settings = next;
      await pushText(
        account.settings.lineUserId!,
        `價格提醒｜${hit.name}（${tick.symbol}）\n現價 ${tick.price.toLocaleString("zh-TW")}，已${hit.condition === "above" ? "達到或高於" : "達到或低於"}設定價 ${hit.targetPrice.toLocaleString("zh-TW")}。\n行情時間 ${tick.asOf.toLocaleString("zh-TW", { timeZone: MARKET_ZONE, hour12: false })}`,
      );
      logger.info({ userId: account.user.id, symbol: tick.symbol, alertId: hit.id }, "LINE price alert sent");
    } catch (error) {
      sentAlerts.delete(dedupeKey);
      logger.error({ err: error, userId: account.user.id, symbol: tick.symbol }, "Unable to send LINE price alert");
    }
  }
}

function sendStreamMessage(message: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connectStream(): void {
  const apiKey = process.env.FUGLE_API_KEY?.trim();
  if (!apiKey) throw new Error("FUGLE_API_KEY is required for the LINE notification worker");
  if (stopped || socket) return;
  const current = new WebSocket(STREAM_URL);
  socket = current;
  current.addEventListener("open", () => {
    sendStreamMessage({ event: "auth", data: { apikey: apiKey } });
    heartbeatTimer = setInterval(() => {
      sendStreamMessage({ event: "ping", data: { state: "line-notification-worker" } });
    }, 30_000);
  });
  current.addEventListener("message", (event) => {
    let message: unknown;
    try { message = JSON.parse(String(event.data)); }
    catch { return; }
    if (message && typeof message === "object" && (message as { event?: unknown }).event === "authenticated") {
      sendStreamMessage({ event: "subscribe", data: { channel: "indices", symbol: TAIWAN_INDEX_SYMBOL } });
      for (const account of users) {
        for (const symbol of account.symbols) {
          if (subscribedSymbols.has(symbol)) continue;
          subscribedSymbols.add(symbol);
          sendStreamMessage({ event: "subscribe", data: { channel: "aggregates", symbol } });
        }
      }
      logger.info({ symbols: subscribedSymbols.size }, "Fugle stock stream authenticated");
      return;
    }
    if (message && typeof message === "object" && (message as { event?: unknown }).event === "error") {
      logger.error({ response: (message as { data?: unknown }).data }, "Fugle stock stream returned an error");
      return;
    }
    if (
      message && typeof message === "object" &&
      (message as { event?: unknown }).event === "data" &&
      (message as { channel?: unknown }).channel === "indices"
    ) {
      const data = (message as { data?: Record<string, unknown> }).data;
      const price = Number(data?.index);
      const asOf = parseTimestamp(data?.time);
      if (
        data?.symbol === TAIWAN_INDEX_SYMBOL && Number.isFinite(price) && price > 0 && asOf &&
        Date.now() - asOf.getTime() <= 180_000 && asOf.getTime() <= Date.now() + 30_000
      ) latestIndex = { price, asOf };
      return;
    }
    const tick = parseTick(message);
    if (tick) void handleTick(tick);
  });
  current.addEventListener("close", (event) => {
    if (socket === current) socket = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    logger.warn({ code: event.code, reason: event.reason }, "Fugle stock stream closed");
    if (!stopped) {
      subscribedSymbols.clear();
      reconnectTimer = setTimeout(connectStream, 5000);
    }
  });
  current.addEventListener("error", () => {
    logger.warn("Fugle stock stream connection error");
    current.close();
  });
}

async function sendOpeningNotices(): Promise<void> {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(part("weekday"))) return;
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  const today = toTaiwanDate(now);
  const isOpen = minute >= 9 * 60 && minute < 9 * 60 + 10;
  if (!isOpen) return;

  for (const account of users) {
    if (!account.settings.lineUserId || !account.settings.openingNotice) continue;
    if (lastOpeningNotice.get(account.user.id) === today) continue;
    const lines = [...account.symbols]
      .map((symbol) => openingTicks.get(symbol)?.tick)
      .filter((tick): tick is QuoteTick => {
        if (!tick || toTaiwanDate(tick.asOf) !== today) return false;
        return tick.asOf.getTime() >= new Date(`${today}T09:00:00+08:00`).getTime() &&
          tick.asOf.getTime() < new Date(`${today}T09:10:00+08:00`).getTime();
      })
      .map((tick) => `${tick.symbol} ${tick.price.toLocaleString("zh-TW")} · ${tick.asOf.toLocaleTimeString("zh-TW", { timeZone: MARKET_ZONE, hour12: false })}`);
    if (lines.length === 0) continue;
    lastOpeningNotice.set(account.user.id, today);
    try { await pushText(account.settings.lineUserId, `台股開盤首筆成交（${today}）\n${lines.join("\n")}\n成交時間以個別行情標示；未取得即時成交的標的略過。`); }
    catch (error) {
      lastOpeningNotice.delete(account.user.id);
      logger.error({ err: error, userId: account.user.id }, "Unable to send LINE opening notice");
    }
  }
}

export async function startLineNotificationWorker(): Promise<void> {
  if (!process.env.CLERK_SECRET_KEY) throw new Error("CLERK_SECRET_KEY is required for the LINE notification worker");
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required for the LINE notification worker");
  stopped = false;
  users = await listLinkedUsers();
  startRealtimeRelay();
  connectStream();
  pollTimer = setInterval(() => {
    void (async () => {
      try {
        users = await listLinkedUsers();
        for (const account of users) {
          for (const symbol of account.symbols) {
            if (subscribedSymbols.has(symbol)) continue;
            subscribedSymbols.add(symbol);
            sendStreamMessage({ event: "subscribe", data: { channel: "aggregates", symbol } });
          }
        }
        await sendOpeningNotices();
      } catch (error) {
        logger.error({ err: error }, "LINE notification worker cycle failed");
      }
    })();
  }, POLL_INTERVAL_MS);
  logger.info({ linkedUsers: users.length }, "LINE notification worker started");
}

function stopWorker(): void {
  stopped = true;
  if (pollTimer) clearInterval(pollTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
  httpServer?.close();
}

process.once("SIGINT", stopWorker);
process.once("SIGTERM", stopWorker);

void startLineNotificationWorker().catch((error) => {
  logger.fatal({ err: error }, "LINE notification worker failed to start");
  process.exitCode = 1;
});
