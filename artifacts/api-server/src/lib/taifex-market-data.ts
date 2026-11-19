import { randomBytes } from "node:crypto";
import type { MarketQuoteData } from "./market-data.js";
import { withFuturesDailyHistoryBudget } from "./futures-daily-history-budget.js";

const TAIFEX_API_URL =
  "https://mis.taifex.com.tw/futures/api/getSearchResult";
const TAIFEX_SOCKET_URL = "wss://mis.taifex.com.tw/futures/rt";
const TAIFEX_DAILY_REPORT_URL =
  "https://www.taifex.com.tw/cht/3/futDailyMarketReport";
const SYMBOLS_CACHE_MS = 60 * 60 * 1000;
const DAILY_REPORT_CACHE_MS = 15 * 60 * 1000;
const DAILY_REPORT_LOOKBACK_DAYS = 7;
const DAILY_HISTORY_CACHE_MS = 6 * 60 * 60 * 1000;
const DAILY_HISTORY_RETRY_CACHE_MS = 5 * 60 * 1000;
const DAILY_HISTORY_LOOKBACK_DAYS = 45;
const DAILY_HISTORY_REQUIRED_BARS = 15;
const DAILY_HISTORY_BATCH_SIZE = 5;
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

export type TaifexMinuteBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type TaifexFuturesDailyBar = {
  date: string;
  contractMonth: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type TaifexFuturesDailyHistory = {
  status: "available" | "insufficient" | "unavailable";
  bars: TaifexFuturesDailyBar[];
  atr14: number | null;
  atr14By4: number | null;
  asOf: string | null;
  source: string;
};

export type TaifexFuturesDayIntraday = {
  status: "live" | "warming_up" | "closed" | "unavailable";
  symbol: string | null;
  date: string;
  bars: TaifexMinuteBar[];
  k: number | null;
  d: number | null;
  signal: "bullish_cross" | "bearish_cross" | "no_cross" | "insufficient";
  price: number | null;
  change: number | null;
  changePercent: number | null;
  asOf: Date | null;
  source: string;
  dailyHistory: TaifexFuturesDailyHistory;
};

type FuturesSession = "day" | "night";
type StoredDayBars = { date: string; bars: TaifexMinuteBar[] };

type DailyReportQuoteCacheEntry = {
  expiresAt: number;
  promise: Promise<MarketQuoteData | null>;
};

type DailyHistoryCacheEntry = {
  expiresAt: number;
  promise: Promise<TaifexFuturesDailyHistory>;
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
const dayBarsBySymbol = new Map<string, StoredDayBars>();
let initialQuoteSymbols = new Set<string>();
const initialSnapshotWaiters = new Set<() => void>();
const dailyReportQuoteCache = new Map<
  FuturesSession,
  DailyReportQuoteCacheEntry
>();
let dailyHistoryCache: DailyHistoryCacheEntry | null = null;

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

function isTaipeiDaySessionTimestamp(timestamp: number): boolean {
  const taipei = new Date(timestamp + TAIPEI_OFFSET_MS);
  const weekday = taipei.getUTCDay();
  const minutes = taipei.getUTCHours() * 60 + taipei.getUTCMinutes();
  return weekday >= 1 && weekday <= 5 && minutes >= 8 * 60 + 45 && minutes < 13 * 60 + 45;
}

function recordDayBar(symbol: string, price: number, asOf: Date): void {
  if (!symbol.endsWith("-F") || !isTaipeiDaySessionTimestamp(asOf.getTime())) return;
  const date = taipeiDateKey(asOf.getTime());
  const stored = dayBarsBySymbol.get(symbol);
  const bars = stored?.date === date ? stored.bars : [];
  const minute = new Date(Math.floor(asOf.getTime() / 60_000) * 60_000).toISOString();
  const last = bars.at(-1);
  if (last?.time === minute) {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  } else if (!last || new Date(last.time).getTime() < new Date(minute).getTime()) {
    bars.push({ time: minute, open: price, high: price, low: price, close: price });
    if (bars.length > 400) bars.splice(0, bars.length - 400);
  }
  dayBarsBySymbol.set(symbol, { date, bars });
}

export function calculateTaifexIntradayKd(bars: TaifexMinuteBar[]): {
  k: number | null;
  d: number | null;
  signal: TaifexFuturesDayIntraday["signal"];
} {
  if (bars.length < 9) return { k: null, d: null, signal: "insufficient" };
  let k = 50;
  let d = 50;
  let previousK: number | null = null;
  let previousD: number | null = null;
  for (let index = 8; index < bars.length; index += 1) {
    const window = bars.slice(index - 8, index + 1);
    const high = Math.max(...window.map((bar) => bar.high));
    const low = Math.min(...window.map((bar) => bar.low));
    const close = bars[index]!.close;
    const rsv = high === low ? 50 : ((close - low) / (high - low)) * 100;
    previousK = k;
    previousD = d;
    k = (2 * k + rsv) / 3;
    d = (2 * d + k) / 3;
  }
  if (bars.length < 11 || previousK === null || previousD === null) {
    return { k, d, signal: "insufficient" };
  }
  const signal = previousK <= previousD && k > d
    ? "bullish_cross"
    : previousK >= previousD && k < d
      ? "bearish_cross"
      : "no_cross";
  return { k, d, signal };
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

function unavailableDailyHistory(
  status: TaifexFuturesDailyHistory["status"],
  bars: TaifexFuturesDailyBar[] = [],
  source = "TAIFEX 官方 TX 日盤歷史暫不可用",
): TaifexFuturesDailyHistory {
  return {
    status,
    bars,
    atr14: null,
    atr14By4: null,
    asOf: bars.at(-1)?.date ?? null,
    source,
  };
}

export function parseTaifexDailyFuturesBar(
  html: string,
  queryDate: string,
): TaifexFuturesDailyBar | null {
  const headingIndex = html.indexOf("一般交易時段行情表");
  if (headingIndex < 0) return null;
  const headingContext = html.slice(Math.max(0, headingIndex - 120), headingIndex);
  const reportDate = [...headingContext.matchAll(/(\d{4})\/(\d{2})\/(\d{2})/g)].at(-1);
  if (!reportDate) return null;
  const date = `${reportDate[1]}-${reportDate[2]}-${reportDate[3]}`;
  if (date.replaceAll("-", "") !== queryDate) return null;

  const table = html.match(
    /<table\b[^>]*class="[^"]*table-sticky[^"]*"[^>]*>([\s\S]*?)<\/table>/i,
  )?.[1];
  const tableBody = table?.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!tableBody) return null;

  const candidates: TaifexFuturesDailyBar[] = [];
  for (const row of tableBody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (cell) => cell[1]!,
    );
    if (cells.length < 9 || dailyReportText(cells[0]!) !== "TX") continue;
    const contractMonth = dailyReportText(cells[1]!).match(/^\d{6}$/)?.[0];
    const [open, high, low, close] = cells.slice(2, 6).map(parseDailyReportNumber);
    const volume = parseDailyReportNumber(cells[8]!);
    if (
      !contractMonth ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null ||
      volume <= 0 ||
      ![open, high, low, close].every((price) => price > 0) ||
      low > Math.min(open, close) ||
      high < Math.max(open, close) ||
      low > high
    ) {
      continue;
    }
    candidates.push({ date, contractMonth, open, high, low, close });
  }

  // The active front month is the earliest-expiring TX contract with a
  // completed, traded OHLC row. This matches the dashboard's front-month focus.
  candidates.sort((left, right) =>
    left.contractMonth.localeCompare(right.contractMonth),
  );
  return candidates[0] ?? null;
}

export function calculateTaifexDailyAtr14(
  bars: TaifexFuturesDailyBar[],
): number | null {
  const ordered = [...bars].sort((left, right) => left.date.localeCompare(right.date));
  if (ordered.length < DAILY_HISTORY_REQUIRED_BARS) return null;
  const recent = ordered.slice(-DAILY_HISTORY_REQUIRED_BARS);
  const trueRanges = recent.slice(1).map((bar, index) => {
    const previous = recent[index]!;
    const range = bar.high - bar.low;
    // Do not treat the unadjusted spread between expiring and new contracts
    // as market volatility on the front-month roll date.
    if (bar.contractMonth !== previous.contractMonth) return range;
    return Math.max(
      range,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    );
  });
  if (
    trueRanges.length !== 14 ||
    trueRanges.some((range) => !Number.isFinite(range) || range <= 0)
  ) {
    return null;
  }
  return trueRanges.reduce((sum, range) => sum + range, 0) / 14;
}

async function startDailyReportSession(): Promise<string> {
  const response = await fetch(TAIFEX_DAILY_REPORT_URL, {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`TAIFEX 每日行情頁回應 HTTP ${response.status}`);
  }
  const initialPage = await response.text();
  if (!initialPage.includes("myform")) {
    throw new Error("TAIFEX 每日行情頁格式與預期不同");
  }
  return (response.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*[^;,=]+=)/)
    .map((value) => value.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

async function fetchDailyReportHtml(
  queryDate: string,
  marketCode: string,
  cookie: string,
): Promise<string> {
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
  const response = await fetch(TAIFEX_DAILY_REPORT_URL, {
    method: "POST",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://www.taifex.com.tw",
      Referer: TAIFEX_DAILY_REPORT_URL,
      "User-Agent": "Mozilla/5.0",
      Cookie: cookie,
    },
    body,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`TAIFEX 每日行情查詢回應 HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchTaifexDailyFuturesHistoryUncached(): Promise<TaifexFuturesDailyHistory> {
  const cookie = await startDailyReportSession();
  const today = taipeiDateKey();
  const bars: TaifexFuturesDailyBar[] = [];
  const failedDates = new Set<string>();

  for (
    let offset = 1;
    offset <= DAILY_HISTORY_LOOKBACK_DAYS && bars.length < DAILY_HISTORY_REQUIRED_BARS;
    offset += DAILY_HISTORY_BATCH_SIZE
  ) {
    const dates = Array.from(
      { length: Math.min(DAILY_HISTORY_BATCH_SIZE, DAILY_HISTORY_LOOKBACK_DAYS - offset + 1) },
      (_, index) => shiftDateKey(today, -(offset + index)),
    );
    const results = await Promise.allSettled(
      dates.map(async (date) => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const html = await fetchDailyReportHtml(date, "0", cookie);
            return parseTaifexDailyFuturesBar(html, date);
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (result.value) bars.push(result.value);
      } else {
        failedDates.add(dates[index]!);
      }
    });
  }

  const ordered = bars
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-DAILY_HISTORY_REQUIRED_BARS);
  if (ordered.length < DAILY_HISTORY_REQUIRED_BARS) {
    return unavailableDailyHistory(
      "insufficient",
      ordered,
      `TAIFEX 官方 TX 日盤歷史不足：取得 ${ordered.length}/${DAILY_HISTORY_REQUIRED_BARS} 根完整日 K`,
    );
  }
  const oldestRequiredDate = ordered[0]!.date.replaceAll("-", "");
  const missingRecentDates = [...failedDates].filter((date) => date >= oldestRequiredDate);
  if (missingRecentDates.length > 0) {
    return unavailableDailyHistory(
      "insufficient",
      ordered,
      `TAIFEX 官方 TX 日盤歷史有 ${missingRecentDates.length} 個日期查詢失敗，ATR14 暫不計算`,
    );
  }
  const atr14 = calculateTaifexDailyAtr14(ordered);
  if (atr14 === null) {
    return unavailableDailyHistory(
      "insufficient",
      ordered,
      "TAIFEX 官方 TX 日盤歷史欄位未通過 ATR14 驗證",
    );
  }
  return {
    status: "available",
    bars: ordered,
    atr14,
    atr14By4: atr14 / 4,
    asOf: ordered.at(-1)!.date,
    source: "TAIFEX 官方期貨每日交易行情 · 臺股期貨 TX 一般交易時段；每日取最早到期且有完整 OHLC 的契約",
  };
}

export function fetchTaifexFuturesDailyHistory(): Promise<TaifexFuturesDailyHistory> {
  if (dailyHistoryCache && dailyHistoryCache.expiresAt > Date.now()) {
    return dailyHistoryCache.promise;
  }
  const promise = fetchTaifexDailyFuturesHistoryUncached().catch((error: unknown) =>
    unavailableDailyHistory(
      "unavailable",
      [],
      `TAIFEX 官方 TX 日盤歷史暫不可用：${error instanceof Error ? error.message : "查詢失敗"}`,
    ),
  );
  const entry: DailyHistoryCacheEntry = {
    expiresAt: Date.now() + DAILY_HISTORY_CACHE_MS,
    promise,
  };
  dailyHistoryCache = entry;
  void promise.then((history) => {
    if (dailyHistoryCache !== entry) return;
    if (history.status !== "available") {
      dailyHistoryCache = {
        expiresAt: Date.now() + DAILY_HISTORY_RETRY_CACHE_MS,
        promise,
      };
    }
  });
  return promise;
}

async function fetchDailyReportQuote(
  session: FuturesSession,
): Promise<MarketQuoteData | null> {
  const cookie = await startDailyReportSession();
  const currentDate = taipeiDateKey();
  const marketCode = session === "day" ? "0" : "1";

  for (let offset = 0; offset < DAILY_REPORT_LOOKBACK_DAYS; offset += 1) {
    const queryDate = shiftDateKey(currentDate, -offset);
    const quote = parseDailyReportQuote(
      await fetchDailyReportHtml(queryDate, marketCode, cookie),
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
    recordDayBar(symbol, price, asOf);
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

export async function fetchTaifexFuturesDayIntraday(): Promise<TaifexFuturesDayIntraday> {
  const dailyHistoryPromise = fetchTaifexFuturesDailyHistory();
  const symbols = await getFuturesSymbols();
  const connected = await ensureFuturesStream(symbols);
  if (connected) await waitForInitialSnapshot();

  const tick = selectFrontMonthQuote("day");
  const date = taipeiDateKey();
  const bars = tick && dayBarsBySymbol.get(tick.symbol)?.date === date
    ? [...(dayBarsBySymbol.get(tick.symbol)?.bars ?? [])]
    : [];
  const currentSession = isTaipeiDaySessionTimestamp(Date.now());
  const freshTick = Boolean(tick && Date.now() - tick.asOf.getTime() <= REALTIME_AGE_MS);
  const status: TaifexFuturesDayIntraday["status"] = !currentSession
    ? "closed"
    : !freshTick
      ? "unavailable"
      : bars.length < 11
        ? "warming_up"
        : "live";
  const kd = calculateTaifexIntradayKd(bars);
  const dailyHistory = await withFuturesDailyHistoryBudget(
    dailyHistoryPromise,
    unavailableDailyHistory(
      "unavailable",
      [],
      "TAIFEX 官方 TX 日盤歷史仍在查詢；即時觀測先行回傳",
    ),
  );
  return {
    status,
    symbol: tick?.symbol ?? null,
    date,
    bars,
    ...kd,
    price: tick?.price ?? null,
    change: tick?.referencePrice == null || !tick ? null : tick.price - tick.referencePrice,
    changePercent: tick?.referencePrice == null || !tick || tick.referencePrice <= 0
      ? null
      : ((tick.price - tick.referencePrice) / tick.referencePrice) * 100,
    asOf: tick?.asOf ?? null,
    source: "TAIFEX MIS 即時成交累積；僅含伺服器啟動／連線後觀測到的日盤成交",
    dailyHistory,
  };
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