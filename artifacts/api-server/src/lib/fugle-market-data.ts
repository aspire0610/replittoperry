import type { MarketQuoteData, StockQuoteData } from "./market-data.js";
import { createHmac } from "node:crypto";

const FUGLE_QUOTE_URL =
  "https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/";
const FUGLE_CANDLES_URL =
  "https://api.fugle.tw/marketdata/v1.0/stock/intraday/candles/";
const FUGLE_STREAM_URL =
  "wss://api.fugle.tw/marketdata/v1.0/stock/streaming";
const FUGLE_FUTOPT_STREAM_URL =
  "wss://api.fugle.tw/marketdata/v1.1/futopt/streaming";
const INDEX_SYMBOL = "IX0001";
const FUTURES_SYMBOL = "TXF1!";
const INDEX_FRESHNESS_MS = 90_000;
const INDEX_WAIT_MS = 6_000;
const FUTURES_FRESHNESS_MS = 90_000;
const FUTURES_WAIT_MS = 6_000;
const FUTURES_ALIAS_REFRESH_MS = 6 * 60 * 60 * 1000;
const STREAM_HEARTBEAT_TIMEOUT_MS = 90_000;
const FUGLE_STOCK_HISTORY_MAX_CONCURRENT = 3;
const FUGLE_STOCK_HISTORY_MAX_ATTEMPTS = 3;
const FUGLE_STOCK_HISTORY_MAX_RETRY_AFTER_MS = 10_000;
let activeFugleStockHistoryRequests = 0;
const fugleStockHistoryWaiters: Array<() => void> = [];

async function withFugleStockHistorySlot<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (activeFugleStockHistoryRequests >= FUGLE_STOCK_HISTORY_MAX_CONCURRENT) {
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = fugleStockHistoryWaiters.indexOf(waiter);
        if (index >= 0) fugleStockHistoryWaiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      fugleStockHistoryWaiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } else {
    activeFugleStockHistoryRequests += 1;
  }

  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return await operation();
  } finally {
    const next = fugleStockHistoryWaiters.shift();
    if (next) next();
    else activeFugleStockHistoryRequests -= 1;
  }
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fugleRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(header) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : null;
}

type FugleQuotePayload = {
  name?: unknown;
  companyName?: unknown;
  stockName?: unknown;
  lastPrice?: unknown;
  previousClose?: unknown;
  change?: unknown;
  changePercent?: unknown;
  lastUpdated?: unknown;
  lastTrade?: { time?: unknown; price?: unknown };
  openPrice?: unknown;
  highPrice?: unknown;
  lowPrice?: unknown;
  total?: { tradeVolume?: unknown };
};

type FugleStreamMessage = {
  event?: string;
  channel?: string;
  id?: string;
  data?: {
    apikey?: string;
    state?: string;
    message?: string;
    symbol?: string;
    index?: unknown;
    time?: unknown;
    type?: string;
    exchange?: string;
    lastPrice?: unknown;
    closePrice?: unknown;
    previousClose?: unknown;
    change?: unknown;
    changePercent?: unknown;
    lastUpdated?: unknown;
    lastTrade?: { time?: unknown; price?: unknown };
    isTrial?: boolean;
  };
};

type FugleIndexTick = {
  price: number;
  asOf: Date;
};

export type FugleTaiexIntradayCandle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type FugleTaiexIntradayData = {
  date: string;
  bars: FugleTaiexIntradayCandle[];
};

export type FugleStockDailyBar = {
  date: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type PendingIndexWaiter = {
  resolve: (tick: FugleIndexTick) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type FugleFuturesTick = {
  price: number;
  change: number | null;
  changePercent: number | null;
  asOf: Date;
  symbol: string;
  session: "day" | "night";
};

type PendingFuturesWaiter = {
  resolve: (tick: FugleFuturesTick) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let stream: WebSocket | null = null;
let authenticated = false;
let connectionAttempt: Promise<void> | null = null;
let latestIndexTick: FugleIndexTick | null = null;
let lastIndexHeartbeatAt = 0;
const indexWaiters = new Set<PendingIndexWaiter>();
let futuresStream: WebSocket | null = null;
let futuresAuthenticated = false;
let futuresConnectionAttempt: Promise<void> | null = null;
let futuresStreamOpenedAt = 0;
let lastFuturesHeartbeatAt = 0;
let latestFuturesTick: FugleFuturesTick | null = null;
const futuresWaiters = new Set<PendingFuturesWaiter>();

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateFromFugleTimestamp(value: unknown): Date | null {
  if (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const text = value.trim();
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const timestamp = finiteNumber(value);
  if (timestamp === null) return null;
  const magnitude = Math.abs(timestamp);
  const epochMilliseconds =
    magnitude >= 100_000_000_000_000_000
      ? timestamp / 1_000_000
      : magnitude >= 100_000_000_000_000
        ? timestamp / 1_000
        : magnitude >= 100_000_000_000
          ? timestamp
          : magnitude >= 1_000_000_000
            ? timestamp * 1_000
            : null;
  if (epochMilliseconds === null) return null;

  const date = new Date(epochMilliseconds);
  const year = date.getUTCFullYear();
  return Number.isNaN(date.getTime()) || year < 2000 || year > 2100
    ? null
    : date;
}

export function parseFugleTaiexIntradayCandles(
  payload: unknown,
): FugleTaiexIntradayData {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Fugle 加權指數分時回傳格式錯誤");
  }

  const response = payload as Record<string, unknown>;
  const date = typeof response.date === "string" ? response.date : "";
  if (
    response.type !== "INDEX" ||
    response.exchange !== "TWSE" ||
    response.symbol !== INDEX_SYMBOL ||
    String(response.timeframe) !== "1" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    throw new Error("Fugle 加權指數分時代碼或週期不符");
  }
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error("Fugle 尚未提供加權指數一分鐘分時資料");
  }

  const bars = response.data.map((rawBar): FugleTaiexIntradayCandle => {
    if (typeof rawBar !== "object" || rawBar === null) {
      throw new Error("Fugle 加權指數分時包含無效 K 線");
    }
    const bar = rawBar as Record<string, unknown>;
    const rawTime = typeof bar.date === "string" ? bar.date : "";
    const time = dateFromFugleTimestamp(rawTime);
    const open = finiteNumber(bar.open);
    const high = finiteNumber(bar.high);
    const low = finiteNumber(bar.low);
    const close = finiteNumber(bar.close);
    const volume = bar.volume === null ? null : finiteNumber(bar.volume);
    const localClock = rawTime.slice(11, 16);
    if (
      !rawTime.startsWith(`${date}T`) ||
      !time ||
      time.getUTCSeconds() !== 0 ||
      localClock < "09:00" ||
      localClock > "13:30" ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      (volume === null && bar.volume !== null) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      high < low ||
      open < low - 0.01 ||
      open > high + 0.01 ||
      close < low - 0.01 ||
      close > high + 0.01 ||
      (volume !== null && volume < 0)
    ) {
      throw new Error("Fugle 加權指數分時包含不合理的時間或價格");
    }
    return { time, open, high, low, close, volume };
  });

  bars.sort((left, right) => left.time.getTime() - right.time.getTime());
  if (
    !bars.length ||
    response.data.length !== new Set(bars.map((bar) => bar.time.getTime())).size
  ) {
    throw new Error("Fugle 加權指數分時時間重複或無法排序");
  }
  const openingTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(bars[0].time);
  if (openingTime !== "09:00") {
    throw new Error("Fugle 加權指數分時未包含 09:00 開盤資料");
  }

  return { date, bars };
}

function parseStreamMessage(raw: unknown): FugleStreamMessage | null {
  try {
    return JSON.parse(String(raw)) as FugleStreamMessage;
  } catch {
    return null;
  }
}

function isFresh(tick: FugleIndexTick | null): tick is FugleIndexTick {
  return Boolean(
    tick &&
      Date.now() - tick.asOf.getTime() <= INDEX_FRESHNESS_MS &&
      tick.asOf.getTime() <= Date.now() + 60_000,
  );
}

function notifyIndexWaiters(tick: FugleIndexTick): void {
  for (const waiter of indexWaiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve(tick);
  }
  indexWaiters.clear();
}

function failIndexWaiters(error: Error): void {
  for (const waiter of indexWaiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
  indexWaiters.clear();
}

function sendStreamMessage(socket: WebSocket, message: object): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function openIndexStream(apiKey: string): Promise<void> {
  if (authenticated && stream?.readyState === WebSocket.OPEN) {
    if (Date.now() - lastIndexHeartbeatAt < STREAM_HEARTBEAT_TIMEOUT_MS) {
      return Promise.resolve();
    }
    const staleStream = stream;
    stream = null;
    authenticated = false;
    staleStream.close();
  }
  if (connectionAttempt) return connectionAttempt;

  const attempt = new Promise<void>((resolve, reject) => {
    let settled = false;
    let subscribed = false;
    let timeout: ReturnType<typeof setTimeout>;
    const socket = new WebSocket(FUGLE_STREAM_URL);
    stream = socket;
    authenticated = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    timeout = setTimeout(() => {
      finish(new Error("Fugle 指數 WebSocket 認證逾時"));
      socket.close();
    }, INDEX_WAIT_MS);

    socket.addEventListener("open", () => {
      sendStreamMessage(socket, {
        event: "auth",
        data: { apikey: apiKey },
      });
    });

    socket.addEventListener("message", (event) => {
      const message = parseStreamMessage(event.data);
      if (!message) return;

      if (message.event === "heartbeat" || message.event === "pong") {
        lastIndexHeartbeatAt = Date.now();
        return;
      }

      if (message.event === "authenticated") {
        authenticated = true;
        lastIndexHeartbeatAt = Date.now();
        sendStreamMessage(socket, {
          event: "subscribe",
          data: { channel: "indices", symbol: INDEX_SYMBOL },
        });
        subscribed = true;
        finish();
        return;
      }

      if (message.event === "error") {
        const error = new Error(
          message.data?.message ?? "Fugle 指數 WebSocket 回報錯誤",
        );
        finish(error);
        socket.close();
        return;
      }

      if (
        message.event !== "data" ||
        !subscribed ||
        message.channel !== "indices" ||
        message.data?.symbol !== INDEX_SYMBOL
      ) {
        return;
      }

      const price = finiteNumber(message.data.index);
      const asOf = dateFromFugleTimestamp(message.data.time);
      if (price === null || price <= 0 || !asOf) return;

      latestIndexTick = { price, asOf };
      notifyIndexWaiters(latestIndexTick);
    });

    socket.addEventListener("error", () => {
      const error = new Error("Fugle 指數 WebSocket 連線失敗");
      finish(error);
      failIndexWaiters(error);
      socket.close();
    });

    socket.addEventListener("close", () => {
      if (stream === socket) {
        stream = null;
        authenticated = false;
        lastIndexHeartbeatAt = 0;
      }
      const error = new Error("Fugle 指數 WebSocket 已中斷");
      finish(error);
      failIndexWaiters(error);
    });
  });

  connectionAttempt = attempt;
  void attempt.then(
    () => {
      if (connectionAttempt === attempt) connectionAttempt = null;
    },
    () => {
      if (connectionAttempt === attempt) connectionAttempt = null;
    },
  );
  return attempt;
}

async function waitForIndexTick(): Promise<FugleIndexTick> {
  const apiKey = process.env.FUGLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("尚未設定 FUGLE_API_KEY，無法連線 Fugle 指數行情。");
  }

  if (isFresh(latestIndexTick)) return latestIndexTick;
  await openIndexStream(apiKey);
  if (isFresh(latestIndexTick)) return latestIndexTick;

  return new Promise<FugleIndexTick>((resolve, reject) => {
    const waiter: PendingIndexWaiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        indexWaiters.delete(waiter);
        reject(new Error("Fugle 尚未推送新鮮的 TAIEX 指數資料"));
      }, INDEX_WAIT_MS),
    };
    indexWaiters.add(waiter);
  });
}

export async function fetchFugleTaiexIndexTick(): Promise<FugleIndexTick> {
  const workerUrl = process.env.LINE_WORKER_URL?.trim();
  if (workerUrl) {
    const apiKey = process.env.FUGLE_API_KEY?.trim();
    if (!apiKey) throw new Error("尚未設定 FUGLE_API_KEY，無法驗證即時行情 Worker。");
    let response: Response;
    try {
      const token = createHmac("sha256", apiKey)
        .update("tw-stock-dashboard-realtime-relay-v1")
        .digest("hex");
      response = await fetch(`${workerUrl.replace(/\/+$/, "")}/internal/realtime?symbol=${INDEX_SYMBOL}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error("即時行情 Worker 暫時無法連線");
    }
    if (!response.ok) {
      throw new Error(`即時行情 Worker 回應 HTTP ${response.status}`);
    }
    const payload = await response.json() as { symbol?: unknown; price?: unknown; asOf?: unknown };
    const price = finiteNumber(payload.price);
    const asOf = dateFromFugleTimestamp(payload.asOf);
    if (payload.symbol !== INDEX_SYMBOL || price === null || price <= 0 || !asOf) {
      throw new Error("即時行情 Worker 回傳無效的加權指數資料");
    }
    if (Date.now() - asOf.getTime() > INDEX_FRESHNESS_MS || asOf.getTime() > Date.now() + 30_000) {
      throw new Error("即時行情 Worker 的加權指數資料已過期");
    }
    return { price, asOf };
  }
  return waitForIndexTick();
}

export async function fetchFugleTaiexIntradayCandles(): Promise<FugleTaiexIntradayData> {
  const apiKey = process.env.FUGLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("尚未設定 FUGLE_API_KEY，無法取得加權指數分時資料。");
  }

  const url = new URL(`${FUGLE_CANDLES_URL}${INDEX_SYMBOL}`);
  url.searchParams.set("timeframe", "1");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "X-API-KEY": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Fugle 加權指數分時暫時無法連線");
  }
  if (!response.ok) {
    throw new Error(`Fugle 加權指數分時回應 HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Fugle 回傳無法辨識的加權指數分時資料");
  }
  return parseFugleTaiexIntradayCandles(payload);
}

export async function fetchFugleTaiexHistoricalIntradayCandles(
  date: string,
): Promise<FugleTaiexIntradayData> {
  const apiKey = process.env.FUGLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("尚未設定 FUGLE_API_KEY，無法取得加權指數歷史分時資料。");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("加權指數歷史分時日期格式錯誤");
  }

  const url = new URL(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${INDEX_SYMBOL}`);
  url.searchParams.set("timeframe", "1");
  url.searchParams.set("from", date);
  url.searchParams.set("to", date);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "X-API-KEY": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Fugle 加權指數歷史分時暫時無法連線");
  }
  if (!response.ok) {
    throw new Error(`Fugle 加權指數歷史分時回應 HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Fugle 回傳無法辨識的加權指數歷史分時資料");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Fugle 加權指數歷史分時回傳格式錯誤");
  }
  const historical = payload as Record<string, unknown>;
  if (
    historical.symbol !== INDEX_SYMBOL ||
    historical.exchange !== "TWSE" ||
    String(historical.timeframe) !== "1" ||
    (historical.type !== undefined && historical.type !== "INDEX") ||
    !Array.isArray(historical.data)
  ) {
    throw new Error("Fugle 加權指數歷史分時代碼或週期不符");
  }
  for (const rawBar of historical.data) {
    if (typeof rawBar !== "object" || rawBar === null) {
      throw new Error("Fugle 加權指數歷史分時包含無效 K 線");
    }
    const candleDate = (rawBar as Record<string, unknown>).date;
    if (typeof candleDate !== "string" || !candleDate.startsWith(`${date}T`)) {
      throw new Error("Fugle 加權指數歷史分時日期與要求不符");
    }
  }

  // Fugle's historical endpoint omits the top-level session date and may omit
  // the optional security type, unlike the intraday endpoint.
  const result = parseFugleTaiexIntradayCandles({
    type: "INDEX",
    exchange: historical.exchange,
    symbol: historical.symbol,
    timeframe: historical.timeframe,
    date,
    data: historical.data,
  });
  if (result.date !== date) {
    throw new Error("Fugle 加權指數歷史分時日期與要求不符");
  }
  return result;
}

export async function fetchFugleTaiexHistoricalDailyBars(
  from: string,
  to: string,
): Promise<Array<{ date: string; open: number; high: number; low: number; close: number }>> {
  const apiKey = process.env.FUGLE_API_KEY?.trim();
  if (!apiKey) throw new Error("尚未設定 Fugle 歷史行情備援來源。");
  const chunks = splitFugleDailyHistoryRange(from, to);
  const byDate = new Map<string, { date: string; open: number; high: number; low: number; close: number }>();

  for (const chunk of chunks) {
    const url = new URL(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${INDEX_SYMBOL}`);
    url.searchParams.set("timeframe", "D");
    url.searchParams.set("from", chunk.from);
    url.searchParams.set("to", chunk.to);
    url.searchParams.set("fields", "open,high,low,close");
    url.searchParams.set("sort", "asc");
    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(url, {
          headers: { Accept: "application/json", "X-API-KEY": apiKey },
          signal: AbortSignal.timeout(12_000),
        });
      } catch {
        if (attempt === 2) throw new Error("Fugle 加權指數歷史日線暫時無法連線");
      }
      if (response?.ok || (response && response.status !== 429) || attempt === 2) break;
      const retryAfter = Number(response?.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1_000, 5_000)
        : 500 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!response?.ok) {
      throw new Error(`Fugle 加權指數歷史日線回應 HTTP ${response?.status ?? "unknown"}`);
    }
    const payload = await response.json() as {
      symbol?: unknown;
      type?: unknown;
      exchange?: unknown;
      timeframe?: unknown;
      data?: unknown;
    };
    if (
      payload.symbol !== INDEX_SYMBOL ||
      payload.type !== "INDEX" ||
      payload.exchange !== "TWSE" ||
      payload.timeframe !== "D" ||
      !Array.isArray(payload.data)
    ) throw new Error("Fugle 加權指數歷史日線代碼、交易所或週期不符");

    for (const raw of payload.data) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const date = typeof item.date === "string" ? item.date.slice(0, 10) : "";
      const open = finiteNumber(item.open);
      const high = finiteNumber(item.high);
      const low = finiteNumber(item.low);
      const close = finiteNumber(item.close);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < chunk.from || date > chunk.to ||
        open === null || high === null || low === null || close === null ||
        open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
        low > Math.min(open, close) || high < Math.max(open, close)
      ) continue;
      byDate.set(date, { date, open, high, low, close });
    }
  }
  const bars = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (bars.length < 2) throw new Error("Fugle 加權指數歷史日線不足兩個交易日");
  return bars;
}

function isFreshFuturesTick(
  tick: FugleFuturesTick | null,
): tick is FugleFuturesTick {
  return Boolean(
    tick &&
      Date.now() - tick.asOf.getTime() <= FUTURES_FRESHNESS_MS &&
      tick.asOf.getTime() <= Date.now() + 60_000,
  );
}

function notifyFuturesWaiters(tick: FugleFuturesTick): void {
  for (const waiter of futuresWaiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve(tick);
  }
  futuresWaiters.clear();
}

function failFuturesWaiters(error: Error): void {
  for (const waiter of futuresWaiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
  futuresWaiters.clear();
}

function openFuturesStream(apiKey: string): Promise<void> {
  if (futuresAuthenticated && futuresStream?.readyState === WebSocket.OPEN) {
    const streamAge = Date.now() - futuresStreamOpenedAt;
    const heartbeatFresh =
      Date.now() - lastFuturesHeartbeatAt < STREAM_HEARTBEAT_TIMEOUT_MS;
    const dataFresh = isFreshFuturesTick(latestFuturesTick);
    if (
      streamAge < FUTURES_ALIAS_REFRESH_MS &&
      heartbeatFresh &&
      (dataFresh || streamAge < 180_000)
    ) {
      return Promise.resolve();
    }

    const staleStream = futuresStream;
    futuresStream = null;
    futuresAuthenticated = false;
    staleStream.close();
  }
  if (futuresConnectionAttempt) return futuresConnectionAttempt;

  const attempt = new Promise<void>((resolve, reject) => {
    let settled = false;
    let subscribed = false;
    let timeout: ReturnType<typeof setTimeout>;
    const socket = new WebSocket(FUGLE_FUTOPT_STREAM_URL);
    futuresStream = socket;
    futuresAuthenticated = false;
    futuresStreamOpenedAt = Date.now();
    latestFuturesTick = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    timeout = setTimeout(() => {
      finish(new Error("Fugle 期貨 WebSocket 認證逾時"));
      socket.close();
    }, FUTURES_WAIT_MS);

    socket.addEventListener("open", () => {
      sendStreamMessage(socket, {
        event: "auth",
        data: { apikey: apiKey },
      });
    });

    socket.addEventListener("message", (event) => {
      const message = parseStreamMessage(event.data);
      if (!message) return;

      if (message.event === "heartbeat" || message.event === "pong") {
        lastFuturesHeartbeatAt = Date.now();
        return;
      }

      if (message.event === "authenticated") {
        futuresAuthenticated = true;
        lastFuturesHeartbeatAt = Date.now();
        sendStreamMessage(socket, {
          event: "subscribe",
          data: {
            channel: "aggregates",
            symbol: FUTURES_SYMBOL,
            afterHours: false,
          },
        });
        sendStreamMessage(socket, {
          event: "subscribe",
          data: {
            channel: "aggregates",
            symbol: FUTURES_SYMBOL,
            afterHours: true,
          },
        });
        subscribed = true;
        finish();
        return;
      }

      if (message.event === "error") {
        const error = new Error(
          message.data?.message ?? "Fugle 期貨 WebSocket 回報錯誤",
        );
        if (!futuresAuthenticated) {
          finish(error);
          socket.close();
        }
        return;
      }

      if (
        message.event !== "data" ||
        !subscribed ||
        message.channel !== "aggregates" ||
        message.data?.exchange !== "TAIFEX" ||
        !message.data.type?.startsWith("FUTURE") ||
        message.data.isTrial === true
      ) {
        return;
      }

      const symbol = message.data.symbol?.toUpperCase();
      const price =
        finiteNumber(message.data.lastPrice) ??
        finiteNumber(message.data.closePrice);
      const previousClose = finiteNumber(message.data.previousClose);
      const asOf =
        dateFromFugleTimestamp(message.data.lastUpdated) ??
        dateFromFugleTimestamp(message.data.lastTrade?.time) ??
        dateFromFugleTimestamp(message.data.time);
      if (!symbol?.startsWith("TXF") || price === null || price <= 0 || !asOf) {
        return;
      }

      const change =
        finiteNumber(message.data.change) ??
        (previousClose === null ? null : price - previousClose);
      const changePercent =
        finiteNumber(message.data.changePercent) ??
        (previousClose === null || previousClose <= 0 || change === null
          ? null
          : (change / previousClose) * 100);
      const tick: FugleFuturesTick = {
        price,
        change,
        changePercent,
        asOf,
        symbol,
        session: message.data.type.endsWith("_AH") ? "night" : "day",
      };
      if (!latestFuturesTick || tick.asOf > latestFuturesTick.asOf) {
        latestFuturesTick = tick;
        notifyFuturesWaiters(tick);
      }
    });

    socket.addEventListener("error", () => {
      const error = new Error("Fugle 期貨 WebSocket 連線失敗");
      finish(error);
      failFuturesWaiters(error);
      socket.close();
    });

    socket.addEventListener("close", () => {
      if (futuresStream === socket) {
        futuresStream = null;
        futuresAuthenticated = false;
        lastFuturesHeartbeatAt = 0;
      }
      const error = new Error("Fugle 期貨 WebSocket 已中斷");
      finish(error);
      failFuturesWaiters(error);
    });
  });

  futuresConnectionAttempt = attempt;
  void attempt.then(
    () => {
      if (futuresConnectionAttempt === attempt) futuresConnectionAttempt = null;
    },
    () => {
      if (futuresConnectionAttempt === attempt) futuresConnectionAttempt = null;
    },
  );
  return attempt;
}

async function waitForFuturesTick(): Promise<FugleFuturesTick> {
  const apiKey = process.env.FUGLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("尚未設定 FUGLE_API_KEY，無法連線 Fugle 期貨行情。");
  }

  if (isFreshFuturesTick(latestFuturesTick)) return latestFuturesTick;
  await openFuturesStream(apiKey);
  if (isFreshFuturesTick(latestFuturesTick)) return latestFuturesTick;

  return new Promise<FugleFuturesTick>((resolve, reject) => {
    const waiter: PendingFuturesWaiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        futuresWaiters.delete(waiter);
        reject(new Error("Fugle 尚未推送新鮮的臺指期資料"));
      }, FUTURES_WAIT_MS),
    };
    futuresWaiters.add(waiter);
  });
}

export async function fetchFugleFuturesQuote(): Promise<MarketQuoteData> {
  const tick = await waitForFuturesTick();
  const sessionLabel = tick.session === "night" ? "夜盤" : "日盤";
  return {
    key: tick.session === "night" ? "futures_night" : "futures_day",
    name: `臺指期${sessionLabel}`,
    ticker: tick.symbol,
    price: tick.price,
    change: tick.change,
    changePercent: tick.changePercent,
    source: `Fugle MarketData · TXF1!（${sessionLabel}）`,
    asOf: tick.asOf,
    available: true,
    error: null,
  };
}

export async function fetchFugleStockQuote(
  symbol: string,
): Promise<StockQuoteData> {
  const apiKey = process.env.FUGLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("尚未設定 FUGLE_API_KEY，無法取得 Fugle 個股報價。");
  }

  const stockCode = symbol.trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
  const url = `${FUGLE_QUOTE_URL}${encodeURIComponent(stockCode)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "X-API-KEY": apiKey },
      signal: AbortSignal.timeout(7_000),
    });
  } catch {
    throw new Error("Fugle 個股報價暫時無法連線");
  }
  if (!response.ok) {
    throw new Error(`Fugle 個股報價回應 HTTP ${response.status}`);
  }

  let payload: FugleQuotePayload;
  try {
    payload = (await response.json()) as FugleQuotePayload;
  } catch {
    throw new Error("Fugle 回傳無法辨識的個股報價");
  }

  const lastTradePrice = finiteNumber(payload.lastTrade?.price);
  const lastPrice = finiteNumber(payload.lastPrice);
  const price = [lastTradePrice, lastPrice].find(
    (value): value is number => value !== null && value > 0,
  ) ?? null;
  const previousClose = finiteNumber(payload.previousClose);
  const tradeAsOf = dateFromFugleTimestamp(payload.lastTrade?.time);
  const asOf =
    tradeAsOf ?? dateFromFugleTimestamp(payload.lastUpdated);
  if (
    price === null ||
    price <= 0 ||
    previousClose === null ||
    previousClose <= 0 ||
    !asOf
  ) {
    const missing = [
      price === null || price <= 0 ? "成交價" : null,
      previousClose === null || previousClose <= 0 ? "昨收" : null,
      !asOf ? "可辨認的報價時間" : null,
    ].filter((field): field is string => field !== null);
    throw new Error(`Fugle 個股行情缺少必要欄位：${missing.join("、")}`);
  }

  const change = finiteNumber(payload.change) ?? price - previousClose;
  const changePercent =
    finiteNumber(payload.changePercent) ??
    (change / previousClose) * 100;
  const name = [
    payload.stockName,
    payload.companyName,
    payload.name,
  ].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  )?.trim() ?? null;

  return {
    name,
    price,
    previousClose,
    change,
    changePercent,
    volume: finiteNumber(payload.total?.tradeVolume) === null
      ? null
      : finiteNumber(payload.total?.tradeVolume)! * 1_000,
    openPrice: finiteNumber(payload.openPrice),
    highPrice: finiteNumber(payload.highPrice),
    lowPrice: finiteNumber(payload.lowPrice),
    source: tradeAsOf
      ? "Fugle MarketData · 成交時間"
      : "Fugle MarketData · 報價更新時間",
    asOf,
    available: true,
    error: null,
  };
}

export async function fetchFugleStockHistoricalDailyBars(
  symbol: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<{ exchange: "TWSE" | "TPEx"; bars: FugleStockDailyBar[] }> {
  const apiKey = process.env.FUGLE_API_KEY?.trim();
  if (!apiKey) throw new Error("尚未設定 Fugle 歷史行情備援來源。");
  const stockCode = symbol.trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  if (
    !/^[A-Z0-9]{4,6}$/.test(stockCode) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    !Number.isFinite(fromTime) ||
    !Number.isFinite(toTime) ||
    fromTime > toTime ||
    toTime - fromTime >= 365 * 86_400_000
  ) throw new Error("Fugle 歷史日Ｋ查詢參數無效或區間達一年");

  const url = new URL(
    `https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${encodeURIComponent(stockCode)}`,
  );
  url.searchParams.set("timeframe", "D");
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("fields", "open,high,low,close,volume");
  url.searchParams.set("sort", "asc");
  const response = await withFugleStockHistorySlot(async () => {
    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt < FUGLE_STOCK_HISTORY_MAX_ATTEMPTS; attempt += 1) {
      lastResponse = null;
      try {
        lastResponse = await fetch(url, {
          headers: { Accept: "application/json", "X-API-KEY": apiKey },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (attempt === FUGLE_STOCK_HISTORY_MAX_ATTEMPTS - 1) {
          throw new Error("Fugle 個股歷史日Ｋ暫時無法連線", { cause: error });
        }
        await delayWithSignal(750 * 2 ** attempt, signal);
        continue;
      }

      if (lastResponse.ok || lastResponse.status !== 429) break;
      const retryAfterMs = fugleRetryAfterMs(lastResponse);
      if (
        attempt === FUGLE_STOCK_HISTORY_MAX_ATTEMPTS - 1 ||
        (retryAfterMs !== null && retryAfterMs > FUGLE_STOCK_HISTORY_MAX_RETRY_AFTER_MS)
      ) break;
      const delayMs = retryAfterMs ?? Math.min(750 * 2 ** attempt, 6_000);
      await delayWithSignal(delayMs, signal);
    }
    if (!lastResponse?.ok) {
      throw new Error(`Fugle 個股歷史日Ｋ回應 HTTP ${lastResponse?.status ?? "unknown"}`);
    }
    return lastResponse;
  }, signal);
  const payload = await response.json() as {
    symbol?: unknown;
    exchange?: unknown;
    timeframe?: unknown;
    data?: unknown;
  };
  if (
    payload.symbol !== stockCode ||
    (payload.exchange !== "TWSE" && payload.exchange !== "TPEx") ||
    payload.timeframe !== "D" ||
    !Array.isArray(payload.data)
  ) throw new Error("Fugle 個股歷史日Ｋ代碼、交易所或週期不符");

  const bars = payload.data.flatMap((raw): FugleStockDailyBar[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const item = raw as Record<string, unknown>;
    const date = typeof item.date === "string" ? item.date : "";
    const open = finiteNumber(item.open);
    const high = finiteNumber(item.high);
    const low = finiteNumber(item.low);
    const close = finiteNumber(item.close);
    const volume = finiteNumber(item.volume);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < from || date > to ||
      open === null || high === null || low === null || close === null || volume === null ||
      open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 ||
      low > Math.min(open, close) || high < Math.max(open, close)
    ) return [];
    return [{
      date,
      timestamp: Date.parse(`${date}T05:30:00.000Z`),
      open,
      high,
      low,
      close,
      volume,
    }];
  }).sort((left, right) => left.date.localeCompare(right.date));
  if (!bars.length) throw new Error("Fugle 個股歷史日Ｋ沒有有效交易資料");
  return { exchange: payload.exchange, bars };
}

export function splitFugleDailyHistoryRange(from: string, to: string): Array<{ from: string; to: string }> {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end
  ) throw new Error("Fugle 歷史日Ｋ查詢日期無效");

  const dayMs = 86_400_000;
  const maxSpanDays = 360;
  const chunks: Array<{ from: string; to: string }> = [];
  for (let cursor = start; cursor <= end;) {
    const chunkEnd = Math.min(end, cursor + maxSpanDays * dayMs);
    chunks.push({
      from: new Date(cursor).toISOString().slice(0, 10),
      to: new Date(chunkEnd).toISOString().slice(0, 10),
    });
    cursor = chunkEnd + dayMs;
  }
  return chunks;
}

const fugleStockDailyRangeCache = new Map<string, {
  expiresAt: number;
  promise: Promise<{ exchange: "TWSE" | "TPEx"; bars: FugleStockDailyBar[] }>;
}>();

export async function fetchFugleStockHistoricalDailyRange(
  symbol: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<{ exchange: "TWSE" | "TPEx"; bars: FugleStockDailyBar[] }> {
  const key = `${symbol.trim().toUpperCase()}:${from}:${to}`;
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (signal) {
    const chunks = splitFugleDailyHistoryRange(from, to);
    let exchange: "TWSE" | "TPEx" | null = null;
    const byDate = new Map<string, FugleStockDailyBar>();
    for (const chunk of chunks) {
      const result = await fetchFugleStockHistoricalDailyBars(symbol, chunk.from, chunk.to, signal);
      if (exchange !== null && result.exchange !== exchange) {
        throw new Error("Fugle 歷史日Ｋ分段回傳不同交易所，已拒絕合併");
      }
      exchange = result.exchange;
      for (const bar of result.bars) byDate.set(bar.date, bar);
    }
    const bars = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
    if (!exchange || !bars.length) throw new Error("Fugle 個股歷史日Ｋ沒有完整可用資料");
    return { exchange, bars };
  }
  const cached = fugleStockDailyRangeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
  const chunks = splitFugleDailyHistoryRange(from, to);
  let exchange: "TWSE" | "TPEx" | null = null;
  const byDate = new Map<string, FugleStockDailyBar>();
  for (const chunk of chunks) {
    const result = await fetchFugleStockHistoricalDailyBars(symbol, chunk.from, chunk.to);
    if (exchange !== null && result.exchange !== exchange) {
      throw new Error("Fugle 歷史日Ｋ分段回傳不同交易所，已拒絕合併");
    }
    exchange = result.exchange;
    for (const bar of result.bars) byDate.set(bar.date, bar);
  }
  const bars = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (!exchange || !bars.length) throw new Error("Fugle 個股歷史日Ｋ沒有完整可用資料");
  return { exchange, bars };
  })();
  fugleStockDailyRangeCache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1_000, promise });
  try {
    if (fugleStockDailyRangeCache.size > 500) {
      for (const [cacheKey, value] of fugleStockDailyRangeCache) {
        if (value.expiresAt <= Date.now()) fugleStockDailyRangeCache.delete(cacheKey);
      }
    }
    return await promise;
  } catch (error) {
    if (fugleStockDailyRangeCache.get(key)?.promise === promise) {
      fugleStockDailyRangeCache.delete(key);
    }
    throw error;
  }
}

export function toFugleTaiexMarketQuote(
  tick: FugleIndexTick,
  previousClose: number | null,
): MarketQuoteData {
  const change =
    previousClose === null ? null : tick.price - previousClose;
  return {
    key: "taiex",
    name: "加權指數",
    ticker: "^TWII",
    price: tick.price,
    change,
    changePercent:
      previousClose === null || previousClose <= 0 || change === null
        ? null
        : (change / previousClose) * 100,
    source: `Fugle MarketData · indices/${INDEX_SYMBOL}`,
    asOf: tick.asOf,
    available: true,
    error: null,
  };
}