import { randomBytes } from "node:crypto";
import type { MarketQuoteData } from "./market-data.js";

const TAIFEX_API_URL =
  "https://mis.taifex.com.tw/futures/api/getSearchResult";
const TAIFEX_SOCKET_URL = "wss://mis.taifex.com.tw/futures/rt";
const TAIFEX_DAILY_REPORT_URL =
  "https://www.taifex.com.tw/cht/3/futDailyMarketReport";
const SYMBOLS_CACHE_MS = 60 * 60 * 1000;
const DAILY_REPORT_CACHE_MS = 15 * 60 * 1000;
const DAILY_REPORT_LOOKBACK_DAYS = 7;
const SOCKET_HEARTBEAT_TIMEOUT_MS = 90_000;
const SOCKET_CONNECT_TIMEOUT_MS = 10_000;
const INITIAL_SNAPSHOT_TIMEOUT_MS = 1_500;
const SOCKET_QUOTE_IDLE_RECONNECT_MS = 30_000;
const REALTIME_AGE_MS = 90_000;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

type FuturesSearchRow = {
  CID?: unknown;
  SymbolType?: unknown;
  SymbolID?: unknown;
};

type FuturesSearchPayload = {
  RtCode?: unknown;
  RtMsg?: unknown;
  RtData?: unknown;
};

type TaifexQuoteMessage = {
  type?: unknown;
  quote?: {
    symbol?: unknown;
    values?: Record<string, unknown>;
    trueValues?: Record<string, unknown>;
  };
};

type TaifexFuturesTick = {
  symbol: string;
  price: number;
  referencePrice: number | null;
  asOf: Date;
  expiryDate: string;
};

type FuturesSession = "day" | "night";

type DailyReportQuoteCacheEntry = {
  expiresAt: number;
  promise: Promise<MarketQuoteData | null>;
};

let cachedSymbols: string[] = [];
let symbolsCachedAt = 0;
let symbolsRequest: Promise<string[]> | null = null;
let futuresSocket: WebSocket | null = null;
let subscribedSymbols: string[] = [];
let lastSocketFrameAt = 0;
let lastQuoteAdvanceAt = 0;
let socketOpenedAt = 0;
let socketConnectionAttempt: Promise<void> | null = null;
const latestQuotes = new Map<string, TaifexFuturesTick>();
let initialQuoteSymbols = new Set<string>();
const initialSnapshotWaiters = new Set<() => void>();
const dailyReportQuoteCache = new Map<
  FuturesSession,
  DailyReportQuoteCacheEntry
>();

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTaipeiTimestamp(
  dateValue: unknown,
  timeValue: unknown,
  symbol: string,
): Date | null {
  const date = String(dateValue ?? "");
  const time = String(timeValue ?? "").padStart(6, "0");
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return null;

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));
  const nightSessionCrossedMidnight =
    symbol.endsWith("-M") && hour < 5;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const timestamp =
    Date.UTC(
      year,
      month - 1,
      day + (nightSessionCrossedMidnight ? 1 : 0),
      hour,
      minute,
      second,
    ) - TAIPEI_OFFSET_MS;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function taipeiDateKey(timestamp = Date.now()): string {
  return new Date(timestamp + TAIPEI_OFFSET_MS)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
}

function shiftDateKey(dateKey: string, days: number): string {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
}

function dailyReportText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDailyReportNumber(value: string): number | null {
  const normalized = dailyReportText(value).replaceAll(",", "");
  if (!normalized || normalized === "-") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDailyReportChange(value: string): number | null {
  const normalized = dailyReportText(value).replaceAll(",", "");
  const numberText = normalized.match(/-?\d+(?:\.\d+)?/)?.[0];
  if (!numberText) return null;
  const parsed = Number(numberText);
  if (!Number.isFinite(parsed)) return null;
  if (normalized.includes("▼")) return -Math.abs(parsed);
  if (normalized.includes("▲")) return Math.abs(parsed);
  return parsed;
}

function parseDailyReportQuote(
  html: string,
  session: FuturesSession,
  queryDate: string,
): MarketQuoteData | null {
  const sessionHeading =
    session === "day" ? "一般交易時段行情表" : "盤後交易時段行情表";
  const headingIndex = html.indexOf(sessionHeading);
  if (headingIndex < 0) return null;

  const headingContext = html.slice(Math.max(0, headingIndex - 120), headingIndex);
  const headingDates = [...headingContext.matchAll(/(\d{4})\/(\d{2})\/(\d{2})/g)];
  const reportDate = headingDates.at(-1);
  const reportDateKey = reportDate
    ? `${reportDate[1]}${reportDate[2]}${reportDate[3]}`
    : queryDate;

  const table = html.match(
    /<table\b[^>]*class="[^"]*table-sticky[^"]*"[^>]*>([\s\S]*?)<\/table>/i,
  )?.[1];
  const tableBody = table?.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!tableBody) return null;

  const rows = [...tableBody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const row of rows) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (cell) => cell[1]!,
    );
    if (cells.length < 8 || dailyReportText(cells[0]!) !== "TX") continue;

    const contractMonth = dailyReportText(cells[1]!).match(/\d{6}/)?.[0];
    const price = parseDailyReportNumber(cells[5]!);
    if (!contractMonth || price === null || price <= 0) continue;

    const change = parseDailyReportChange(cells[6]!);
    const changePercent = parseDailyReportChange(cells[7]!);
    const label = session === "day" ? "日盤" : "夜盤";
    const date = `${reportDateKey.slice(0, 4)}-${reportDateKey.slice(4, 6)}-${reportDateKey.slice(6, 8)}`;
    return {
      key: session === "day" ? "futures_day" : "futures_night",
      name: `臺指期${label}`,
      ticker: session === "day" ? "TXF-F" : "TXF-M",
      price,
      change,
      changePercent,
      source: `TAIFEX 官方日行情 · ${label}最近收盤價`,
      // The report supplies the trading date, not the exact time of the last trade.
      asOf: new Date(`${date}T00:00:00+08:00`),
      available: true,
      error: null,
    };
  }
  return null;
}

async function fetchDailyReportQuote(
  session: FuturesSession,
): Promise<MarketQuoteData | null> {
  const reportUrl = TAIFEX_DAILY_REPORT_URL;
  const pageResponse = await fetch(reportUrl, {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!pageResponse.ok) {
    throw new Error(`TAIFEX 每日行情頁回應 HTTP ${pageResponse.status}`);
  }

  const initialPage = await pageResponse.text();
  if (!initialPage.includes("myform")) {
    throw new Error("TAIFEX 每日行情頁格式與預期不同");
  }
  const setCookie = pageResponse.headers.get("set-cookie") ?? "";
  const cookie = setCookie
    .split(/,(?=\s*[^;,=]+=)/)
    .map((value) => value.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
  const currentDate = taipeiDateKey();
  const marketCode = session === "day" ? "0" : "1";

  for (let offset = 0; offset < DAILY_REPORT_LOOKBACK_DAYS; offset += 1) {
    const queryDate = shiftDateKey(currentDate, -offset);
    const body = new URLSearchParams({
      queryType: "2",
      marketCode,
      dateaddcnt: "",
      commodity_id: "TX",
      commodity_id2: "",
      queryDate: `${queryDate.slice(0, 4)}/${queryDate.slice(4, 6)}/${queryDate.slice(6, 8)}`,
      MarketCode: marketCode,
      commodity_idt: "TX",
    });
    const response = await fetch(reportUrl, {
      method: "POST",
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://www.taifex.com.tw",
        Referer: reportUrl,
        "User-Agent": "Mozilla/5.0",
        Cookie: cookie,
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`TAIFEX 每日行情查詢回應 HTTP ${response.status}`);
    }
    const quote = parseDailyReportQuote(
      await response.text(),
      session,
      queryDate,
    );
    if (quote) return quote;
  }
  return null;
}

export function fetchTaifexDailyFuturesQuote(
  session: FuturesSession,
): Promise<MarketQuoteData | null> {
  const cached = dailyReportQuoteCache.get(session);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = fetchDailyReportQuote(session);
  const entry = { expiresAt: Date.now() + DAILY_REPORT_CACHE_MS, promise };
  dailyReportQuoteCache.set(session, entry);
  void promise.catch(() => {
    if (dailyReportQuoteCache.get(session) === entry) {
      dailyReportQuoteCache.delete(session);
    }
  });
  return promise;
}

async function fetchFuturesSymbols(): Promise<string[]> {
  const response = await fetch(TAIFEX_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://mis.taifex.com.tw",
      Referer: "https://mis.taifex.com.tw/futures/",
    },
    body: JSON.stringify({
      MarketType: "1",
      SymbolType: "F",
      KindID: "1",
      CID: "",
      ExpireMonth: "",
      KeyWord: "臺指期",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`TAIFEX 合約清單回應 HTTP ${response.status}`);
  }

  let payload: FuturesSearchPayload;
  try {
    payload = (await response.json()) as FuturesSearchPayload;
  } catch {
    throw new Error("TAIFEX 回傳無法辨識的臺指期合約清單");
  }
  if (String(payload.RtCode) !== "0" || !Array.isArray(payload.RtData)) {
    throw new Error(
      typeof payload.RtMsg === "string" && payload.RtMsg
        ? `TAIFEX 合約清單：${payload.RtMsg}`
        : "TAIFEX 目前沒有可用的臺指期合約清單",
    );
  }

  const symbols = [
    ...new Set(
      (payload.RtData as FuturesSearchRow[])
        .filter(
          (row) =>
            row.CID === "TXF" &&
            row.SymbolType === "F" &&
            typeof row.SymbolID === "string" &&
            /^TXF[A-Z]\d-[FM]$/.test(row.SymbolID),
        )
        .map((row) => row.SymbolID as string),
    ),
  ].sort();

  if (symbols.length === 0) {
    throw new Error("TAIFEX 合約清單中沒有可訂閱的臺指期");
  }
  return symbols;
}

async function getFuturesSymbols(): Promise<string[]> {
  if (
    cachedSymbols.length > 0 &&
    Date.now() - symbolsCachedAt < SYMBOLS_CACHE_MS
  ) {
    return cachedSymbols;
  }
  if (symbolsRequest) return symbolsRequest;

  const request = fetchFuturesSymbols()
    .then((symbols) => {
      cachedSymbols = symbols;
      symbolsCachedAt = Date.now();
      return symbols;
    })
    .catch((error: unknown) => {
      if (cachedSymbols.length > 0) return cachedSymbols;
      throw error;
    });
  symbolsRequest = request;
  try {
    return await request;
  } finally {
    if (symbolsRequest === request) symbolsRequest = null;
  }
}

function selectFrontMonthQuote(
  session: "day" | "night",
): TaifexFuturesTick | null {
  const now = Date.now();
  const today = taipeiDateKey(now);
  const eligible = [...latestQuotes.values()].filter((tick) => {
    const age = now - tick.asOf.getTime();
    return (
      tick.expiryDate >= today &&
      age >= -60_000 &&
      tick.symbol.endsWith(session === "day" ? "-F" : "-M")
    );
  });
  if (eligible.length === 0) return null;

  eligible.sort((left, right) => {
    const byExpiry = left.expiryDate.localeCompare(right.expiryDate);
    return byExpiry || right.asOf.getTime() - left.asOf.getTime();
  });
  return eligible[0]!;
}

function toSessionQuote(
  tick: TaifexFuturesTick | null,
  session: "day" | "night",
): MarketQuoteData {
  const label = session === "day" ? "日盤" : "夜盤";
  if (!tick) {
    return {
      key: session === "day" ? "futures_day" : "futures_night",
      name: `臺指期${label}`,
      ticker: session === "day" ? "TXF-F" : "TXF-M",
      price: null,
      change: null,
      changePercent: null,
      source: "TAIFEX MIS",
      asOf: null,
      available: false,
      error: `TAIFEX MIS 尚無可用的臺指期${label}成交快照。`,
    };
  }

  const change =
    tick.referencePrice === null ? null : tick.price - tick.referencePrice;
  const changePercent =
    tick.referencePrice === null || tick.referencePrice <= 0 || change === null
      ? null
      : (change / tick.referencePrice) * 100;
  const quoteAge = Date.now() - tick.asOf.getTime();
  const quoteType =
    quoteAge >= -60_000 && quoteAge <= REALTIME_AGE_MS
      ? "即時"
      : "最後成交";
  return {
    key: session === "day" ? "futures_day" : "futures_night",
    name: `臺指期${label}`,
    ticker: tick.symbol,
    price: tick.price,
    change,
    changePercent,
    source: `TAIFEX MIS · ${label}${quoteType}`,
    asOf: tick.asOf,
    available: true,
    error: null,
  };
}

function handleQuoteMessage(message: TaifexQuoteMessage): void {
  if (message.type !== "quote" || !message.quote) return;
  const symbol = message.quote.symbol;
  if (typeof symbol !== "string" || !subscribedSymbols.includes(symbol)) return;
  initialQuoteSymbols.add(symbol);
  if (initialQuoteSymbols.size >= subscribedSymbols.length) {
    for (const resolve of initialSnapshotWaiters) resolve();
    initialSnapshotWaiters.clear();
  }

  const values = message.quote.trueValues ?? message.quote.values;
  if (!values) return;

  // TAIFEX's public rtCore dictionary maps 125=CLastPrice, 129=CRefPrice,
  // 143=CTime, 144=CDate, and 222=CExpireDate.
  const previous = latestQuotes.get(symbol);
  const price = finiteNumber(values["125"]);
  const referencePrice =
    finiteNumber(values["129"]) ?? previous?.referencePrice ?? null;
  const asOf = parseTaipeiTimestamp(values["144"], values["143"], symbol);
  // Incremental ticks may omit static contract metadata; retain it from the
  // initial snapshot so valid price/time updates are not discarded.
  const receivedExpiryDate = String(values["222"] ?? "");
  const expiryDate = /^\d{8}$/.test(receivedExpiryDate)
    ? receivedExpiryDate
    : previous?.expiryDate ?? "";
  if (
    price === null ||
    price <= 0 ||
    !asOf ||
    !/^\d{8}$/.test(expiryDate)
  ) {
    return;
  }

  if (
    !previous ||
    asOf.getTime() > previous.asOf.getTime() ||
    price !== previous.price
  ) {
    lastQuoteAdvanceAt = Date.now();
  }
  if (!previous || asOf.getTime() >= previous.asOf.getTime()) {
    latestQuotes.set(symbol, { symbol, price, referencePrice, asOf, expiryDate });
  }

}

function handleSockJsFrame(frame: string, socket: WebSocket): void {
  lastSocketFrameAt = Date.now();
  if (frame === "o") {
    socketOpenedAt = Date.now();
    socket.send(
      JSON.stringify([
        JSON.stringify({ type: "subscribe", symbols: subscribedSymbols }),
      ]),
    );
    return;
  }
  if (frame === "h") return;

  if (frame.startsWith("a")) {
    let messages: unknown;
    try {
      messages = JSON.parse(frame.slice(1));
    } catch {
      return;
    }
    if (!Array.isArray(messages)) return;
    for (const rawMessage of messages) {
      if (typeof rawMessage !== "string") continue;
      try {
        handleQuoteMessage(JSON.parse(rawMessage) as TaifexQuoteMessage);
      } catch {
        // Ignore malformed individual quotes while keeping the public stream alive.
      }
    }
    return;
  }

  if (frame.startsWith("c")) {
    socket.close();
  }
}

function openFuturesStream(symbols: string[]): Promise<void> {
  if (socketConnectionAttempt) return socketConnectionAttempt;

  for (const symbol of latestQuotes.keys()) {
    if (!symbols.includes(symbol)) latestQuotes.delete(symbol);
  }
  subscribedSymbols = symbols;
  initialQuoteSymbols = new Set();
  lastQuoteAdvanceAt = 0;
  socketOpenedAt = 0;

  const attempt = new Promise<void>((resolve, reject) => {
    let settled = false;
    const sessionId = randomBytes(12).toString("hex");
    const socket = new WebSocket(
      `${TAIFEX_SOCKET_URL}/000/${sessionId}/websocket`,
    );
    futuresSocket = socket;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      finish(new Error("TAIFEX MIS 即時行情連線逾時"));
      socket.close();
    }, SOCKET_CONNECT_TIMEOUT_MS);

    socket.addEventListener("message", (event) => {
      const frame = String(event.data);
      handleSockJsFrame(frame, socket);
      if (frame === "o") finish();
    });

    socket.addEventListener("error", () => {
      const error = new Error("TAIFEX MIS 即時行情連線失敗");
      finish(error);
      if (futuresSocket === socket) {
        futuresSocket = null;
        lastSocketFrameAt = 0;
        lastQuoteAdvanceAt = 0;
        socketOpenedAt = 0;
      }
    });

    socket.addEventListener("close", () => {
      if (futuresSocket === socket) {
        futuresSocket = null;
        lastSocketFrameAt = 0;
        lastQuoteAdvanceAt = 0;
        socketOpenedAt = 0;
      }
      finish(new Error("TAIFEX MIS 即時行情連線中斷"));
    });
  });

  socketConnectionAttempt = attempt;
  void attempt.then(
    () => {
      if (socketConnectionAttempt === attempt) socketConnectionAttempt = null;
    },
    () => {
      if (socketConnectionAttempt === attempt) socketConnectionAttempt = null;
    },
  );
  return attempt;
}

async function ensureFuturesStream(symbols: string[]): Promise<boolean> {
  const sameSymbols =
    symbols.length === subscribedSymbols.length &&
    symbols.every((symbol, index) => symbol === subscribedSymbols[index]);
  const lastActivityAt = lastSocketFrameAt;
  const lastQuoteActivityAt = Math.max(lastQuoteAdvanceAt, socketOpenedAt);
  if (
    futuresSocket?.readyState === WebSocket.OPEN &&
    sameSymbols &&
    lastActivityAt > 0 &&
    Date.now() - lastActivityAt < SOCKET_HEARTBEAT_TIMEOUT_MS &&
    lastQuoteActivityAt > 0 &&
    Date.now() - lastQuoteActivityAt < SOCKET_QUOTE_IDLE_RECONNECT_MS
  ) {
    return false;
  }

  const oldSocket = futuresSocket;
  futuresSocket = null;
  if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) oldSocket.close();
  await openFuturesStream(symbols);
  return true;
}

function waitForInitialSnapshot(): Promise<void> {
  if (initialQuoteSymbols.size >= subscribedSymbols.length) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      initialSnapshotWaiters.delete(finish);
      resolve();
    };
    const timeout = setTimeout(finish, INITIAL_SNAPSHOT_TIMEOUT_MS);
    initialSnapshotWaiters.add(finish);
  });
}

export async function fetchTaifexFuturesQuotes(): Promise<MarketQuoteData[]> {
  const symbols = await getFuturesSymbols();
  const connected = await ensureFuturesStream(symbols);
  if (connected) await waitForInitialSnapshot();

  const dayQuote = toSessionQuote(selectFrontMonthQuote("day"), "day");
  const nightQuote = toSessionQuote(selectFrontMonthQuote("night"), "night");
  if (!dayQuote.available && !nightQuote.available) {
    throw new Error("TAIFEX MIS 尚未提供有效的臺指期合約快照");
  }
  return [dayQuote, nightQuote];
}

export async function fetchTaifexFuturesQuote(): Promise<MarketQuoteData> {
  const quotes = await fetchTaifexFuturesQuotes();
  const freshestQuote = quotes
    .filter((quote) => quote.available && quote.asOf)
    .sort((left, right) => right.asOf!.getTime() - left.asOf!.getTime())[0];
  if (!freshestQuote) {
    throw new Error("TAIFEX MIS 尚未提供有效的臺指期合約快照");
  }
  return freshestQuote;
}