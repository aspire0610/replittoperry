import {
  fetchFugleFuturesQuote,
  fetchFugleStockQuote,
  fetchFugleStockHistoricalDailyRange,
  fetchFugleTaiexHistoricalDailyBars,
  fetchFugleTaiexIndexTick,
  fetchFugleTaiexHistoricalIntradayCandles,
  fetchFugleTaiexIntradayCandles,
  toFugleTaiexMarketQuote,
} from "./fugle-market-data.js";
import {
  fetchTaifexDailyFuturesQuote,
  fetchTaifexFuturesQuotes,
} from "./taifex-market-data.js";
import { isTaiwanMarketClosed } from "./twse-holiday-calendar.js";
import { parseTwseMiIndexDailyClose } from "./official-twse-mi-index.js";
import { fetchOfficialJson } from "./official-json-fetch.js";
import { parseTpexDailyMarket } from "./quant-market-parse.js";
import {
  getMarketWideScanHistoryWindow,
  hasAlignedRecentHistoryBars,
} from "./market-wide-scan-history-window.js";
import { logger } from "./logger.js";

const STOCK_QUOTE_MAX_AGE_MS = 90_000;
const FUTURES_QUOTE_BUDGET_MS = 14_000;
const EXCHANGE_MONTH_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CONCURRENT_EXCHANGE_HISTORY_REQUESTS = 6;
const MAX_EXCHANGE_HISTORY_RETRY_AFTER_MS = 15_000;
let activeExchangeHistoryRequests = 0;
const exchangeHistoryWaiters: Array<() => void> = [];
const exchangeMonthCache = new Map<string, {
  loadedAt: number;
  promise: Promise<string[][]>;
}>();

async function withExchangeHistoryRequestSlot<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (activeExchangeHistoryRequests >= MAX_CONCURRENT_EXCHANGE_HISTORY_REQUESTS) {
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = exchangeHistoryWaiters.indexOf(waiter);
        if (index >= 0) exchangeHistoryWaiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      exchangeHistoryWaiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } else {
    activeExchangeHistoryRequests += 1;
  }

  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return await operation();
  } finally {
    const next = exchangeHistoryWaiters.shift();
    if (next) next();
    else activeExchangeHistoryRequests -= 1;
  }
}

function retryAfterMilliseconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : null;
}

type SupportedRange = "1mo" | "3mo" | "6mo" | "1y" | "3y" | "5y";
const HISTORY_RANGE_CALENDAR_DAYS: Record<SupportedRange, number> = {
  "1mo": 31,
  "3mo": 93,
  "6mo": 186,
  "1y": 366,
  "3y": 1_096,
  "5y": 1_826,
};
const MIN_HISTORY_BARS_BY_RANGE: Record<SupportedRange, number> = {
  "1mo": 15,
  "3mo": 45,
  "6mo": 90,
  "1y": 180,
  // Keep the generic 3-year view intact; market-wide scans use a separately
  // validated 24-month-plus-warmup window.
  "3y": 600,
  "5y": 1_000,
};

type YahooBar = {
  date: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};
type YahooChartRange = SupportedRange | "5d";
const yahooDailyBarCache = new Map<string, {
  expiresAt: number;
  promise: Promise<YahooBar[]>;
}>();
let yahooRequestTail: Promise<void> = Promise.resolve();
let yahooRateLimitedUntil = 0;

async function withYahooRequestSlot<T>(operation: () => Promise<T>): Promise<T> {
  const previous = yahooRequestTail;
  let release = () => {};
  yahooRequestTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    if (Date.now() < yahooRateLimitedUntil) {
      throw new Error("Yahoo Finance 暫時限制行情查詢");
    }
    return await operation();
  } finally {
    release();
  }
}

type TwseQuoteRow = {
  c?: string;
  n?: string;
  z?: string;
  y?: string;
  d?: string;
  t?: string;
  tlong?: string;
  ex?: string;
  o?: string;
  h?: string;
  l?: string;
  v?: string;
  trade?: {
    z?: string;
    t?: string;
    v?: number;
  };
};

type TwseQuotePayload = {
  msgArray?: TwseQuoteRow[];
};

type NasdaqQuotePayload = {
  data?: {
    companyName?: string;
    exchange?: string;
    primaryData?: {
      lastSalePrice?: string;
      netChange?: string;
      percentageChange?: string;
      lastTradeTimestamp?: string;
      isRealTime?: boolean;
    };
  } | null;
  status?: {
    bCodeMessage?: Array<{ errorMessage?: string }>;
  };
};

type ExchangeDailyResponse = {
  stat?: string;
  data?: string[][];
  tables?: Array<{ data?: string[][] }>;
};

type TwseStockCatalogRow = {
  Date?: string;
  Code?: string;
  Name?: string;
};

type TpexStockCatalogRow = {
  Date?: string;
  SecuritiesCompanyCode?: string;
  CompanyName?: string;
};

type TwseDailyCloseRow = {
  Date?: string;
  Code?: string;
  Name?: string;
  ClosingPrice?: string;
  Change?: string;
  TradeVolume?: string;
  TradeValue?: string;
};

type TpexDailyCloseRow = {
  Date?: string;
  SecuritiesCompanyCode?: string;
  CompanyName?: string;
  Close?: string;
  Change?: string;
  TradingShares?: string;
  TransactionAmount?: string;
};

type ExchangeDay = {
  date: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  tradedValue?: number | null;
};

export type MarketWideRecentStockHistory = {
  source: string;
  barsBySymbol: Map<string, ExchangeDay[]>;
};

export class MarketDataError extends Error {
  readonly status: 400 | 404 | 429 | 502 | 503 | 504;

  constructor(message: string, status: 400 | 404 | 429 | 502 | 503 | 504) {
    super(message);
    this.name = "MarketDataError";
    this.status = status;
  }
}

export type MarketQuoteData = {
  key:
    | "taiex"
    | "futures_day"
    | "futures_night"
    | "us_tsm_adr"
    | "us_sox";
  name: string;
  ticker: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  source: string | null;
  asOf: Date | null;
  available: boolean;
  error: string | null;
};

export type HistoryData = {
  ticker: string;
  source: string;
  range: SupportedRange;
  asOf: Date;
  bars: YahooBar[];
};

export type MarketIntradayBarData = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type MarketIntradayHistoryData = {
  ticker: string;
  date: string;
  timeframe: "1m";
  sessionType: "live" | "historical";
  source: string;
  previousClose: number;
  asOf: Date;
  bars: MarketIntradayBarData[];
};

export type StockHistoryData = HistoryData & {
  symbol: string;
  currency: string | null;
};

export type StockQuoteData = {
  name: string | null;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  /** Cumulative session volume, normalized to shares. */
  volume?: number | null;
  openPrice?: number | null;
  highPrice?: number | null;
  lowPrice?: number | null;
  source: string;
  asOf: Date | null;
  available: boolean;
  error: string | null;
};

export type StockCatalogInstrumentData = {
  symbol: string;
  ticker: string;
  name: string;
  exchange: "twse" | "tpex";
  exchangeName: "上市" | "上櫃";
};

export type StockCatalogData = {
  asOf: string;
  instruments: StockCatalogInstrumentData[];
};

export type OfficialDailyClose = {
  symbol: string;
  name: string;
  exchange: "twse" | "tpex";
  close: number;
  change: number | null;
  volume: number | null;
  tradedValue: number | null;
};

export type OfficialDailyCloseData = {
  asOf: string;
  quotes: OfficialDailyClose[];
};

export type OfficialMarketScanSnapshot = {
  asOf: string;
  quotes: OfficialDailyClose[];
  availableExchanges: Array<"TWSE" | "TPEx">;
  unavailableExchanges: Array<"TWSE" | "TPEx">;
  source?: string;
};

export type MarketSummaryData = {
  ticker: string;
  source: string;
  asOf: Date;
  currentPrice: number;
  change: number;
  changePercent: number;
  dailyCloseDate: string;
  dailyCloseSource: string;
  dailyClosePrice: number;
  dailyCloseChange: number;
  dailyCloseChangePercent: number;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  support20?: number | null;
  resistance20?: number | null;
  score: number | null;
  status: "bullish" | "neutral" | "bearish" | "insufficient";
  factors: Array<{
    key: string;
    label: string;
    passed: boolean | null;
    observedValue: number | null;
    threshold: number | null;
  }>;
};

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
const US_MARKET_INDICATOR_CACHE_TTL_MS = 45_000;
type UsMarketIndicatorConfig = {
  key: MarketQuoteData["key"];
  name: string;
  ticker: string;
  nasdaqAssetClass: "stocks" | "index";
};
const usMarketIndicatorConfigs: UsMarketIndicatorConfig[] = [
  {
    key: "us_tsm_adr",
    name: "台積電 ADR",
    ticker: "TSM",
    nasdaqAssetClass: "stocks",
  },
  {
    key: "us_sox",
    name: "費城半導體指數",
    ticker: "SOX",
    nasdaqAssetClass: "index",
  },
];
const usPremarketIndexConfigs: UsMarketIndicatorConfig[] = [
  {
    key: "us_sox",
    name: "納斯達克綜合指數",
    ticker: "COMP",
    nasdaqAssetClass: "index",
  },
];
export type UsPremarketIndex = Omit<MarketQuoteData, "key">;
const usMarketIndicatorCache = new Map<
  string,
  { expiresAt: number; promise: Promise<MarketQuoteData> }
>();
const exchangeResponseCache = new Map<
  string,
  { expiresAt: number; promise: Promise<unknown> }
>();
const TAIEX_INTRADAY_CACHE_TTL_MS = 15_000;
let taiexIntradayCache:
  | { expiresAt: number; promise: Promise<MarketIntradayHistoryData> }
  | null = null;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function exchangeNumber(value: string | undefined): number | null {
  if (!value || value === "--" || value === "-") return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function finMindHttpError(response: Response, label: string): Promise<Error> {
  let detail = "";
  try {
    const body = await response.clone().json() as { msg?: unknown };
    if (typeof body.msg === "string") detail = body.msg.slice(0, 180);
  } catch {
    // Keep the status-only error if FinMind does not return JSON.
  }
  return new Error(`${label} HTTP ${response.status}${detail ? `：${detail}` : ""}`);
}

function numericText(value: string | undefined): number | null {
  if (!value || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchExchangeJson<T>(
  url: URL,
  cacheTtlMs = 90_000,
  sourceName = "臺灣證券交易所",
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (signal) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new MarketDataError(`${sourceName}回應 HTTP ${response.status}`, 502);
    return await response.json() as T;
  }
  const key = url.toString();
  const cached = exchangeResponseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise as Promise<T>;
  }

  const promise = (async (): Promise<T> => {
    let response: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = null;
      try {
        response = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(10_000),
        });
        if (
          response.ok ||
          (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) ||
          attempt === 3
        ) {
          break;
        }
      } catch (error) {
        if (attempt === 3) {
          throw new MarketDataError(
            `${sourceName}暫時無法連線：${error instanceof Error ? error.message : "連線失敗"}`,
            502,
          );
        }
      }
      const retryAfter = response?.status === 429 && response
        ? retryAfterMilliseconds(response)
        : null;
      if (retryAfter !== null && retryAfter > MAX_EXCHANGE_HISTORY_RETRY_AFTER_MS) break;
      const delayMs = retryAfter ?? (
        response?.status === 429 ? Math.min(1_000 * 2 ** attempt, 8_000) : 300 * (attempt + 1)
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!response) {
      throw new MarketDataError(`${sourceName}暫時無法連線`, 502);
    }
    if (!response.ok) {
      throw new MarketDataError(
        `${sourceName}回應 HTTP ${response.status}`,
        502,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new MarketDataError(`${sourceName}回傳無法辨識的資料`, 502);
    }
  })();

  exchangeResponseCache.set(key, {
    expiresAt: Date.now() + cacheTtlMs,
    promise,
  });
  if (exchangeResponseCache.size > 500) {
    for (const [cacheKey, value] of exchangeResponseCache) {
      if (value.expiresAt <= Date.now()) exchangeResponseCache.delete(cacheKey);
    }
  }

  try {
    return await promise;
  } catch (error) {
    exchangeResponseCache.delete(key);
    throw error;
  }
}

const STOCK_CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function rocCompactDateToIso(value: string | undefined): string | null {
  const match = value?.match(/^(\d{3}|\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const yearValue = Number(match[1]);
  const year = match[1]!.length === 3 ? yearValue + 1911 : yearValue;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeCatalogRows(
  rows: Array<TwseStockCatalogRow | TpexStockCatalogRow>,
  exchange: "twse" | "tpex",
): StockCatalogInstrumentData[] {
  const instruments = new Map<string, StockCatalogInstrumentData>();
  for (const row of rows) {
    const symbol =
      exchange === "twse"
        ? (row as TwseStockCatalogRow).Code?.trim().toUpperCase()
        : (row as TpexStockCatalogRow).SecuritiesCompanyCode?.trim().toUpperCase();
    const name =
      exchange === "twse"
        ? (row as TwseStockCatalogRow).Name?.trim()
        : (row as TpexStockCatalogRow).CompanyName?.trim();
    if (!symbol || !name || !/^[A-Z0-9]{4,6}$/.test(symbol)) continue;
    instruments.set(symbol, {
      symbol,
      ticker: `${symbol}.${exchange === "twse" ? "TW" : "TWO"}`,
      name,
      exchange,
      exchangeName: exchange === "twse" ? "上市" : "上櫃",
    });
  }
  return [...instruments.values()];
}

export async function getStockCatalog(): Promise<StockCatalogData> {
  const twseUrl = new URL(
    "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
  );
  const tpexUrl = new URL(
    "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes",
  );
  const [twseRows, tpexRows] = await Promise.all([
    fetchExchangeJson<TwseStockCatalogRow[]>(
      twseUrl,
      STOCK_CATALOG_CACHE_TTL_MS,
      "TWSE",
    ),
    fetchExchangeJson<TpexStockCatalogRow[]>(
      tpexUrl,
      STOCK_CATALOG_CACHE_TTL_MS,
      "TPEx",
    ),
  ]);

  if (!Array.isArray(twseRows) || twseRows.length === 0) {
    throw new MarketDataError("TWSE 官方上市證券清單目前沒有資料", 502);
  }
  if (!Array.isArray(tpexRows) || tpexRows.length === 0) {
    throw new MarketDataError("TPEx 官方上櫃證券清單目前沒有資料", 502);
  }

  const instruments = [
    ...normalizeCatalogRows(twseRows, "twse"),
    ...normalizeCatalogRows(tpexRows, "tpex"),
  ].sort((left, right) => {
    const exchangeOrder = left.exchange.localeCompare(right.exchange);
    return exchangeOrder || left.symbol.localeCompare(right.symbol);
  });
  if (!instruments.length) {
    throw new MarketDataError("官方上市櫃證券清單沒有可用代號", 502);
  }

  const asOfDates = [
    rocCompactDateToIso(twseRows[0]?.Date),
    rocCompactDateToIso(tpexRows[0]?.Date),
  ].filter((date): date is string => date !== null);
  const asOf = asOfDates.sort().at(-1);
  if (!asOf) {
    throw new MarketDataError("官方上市櫃證券清單沒有提供有效資料日期", 502);
  }

  return { asOf, instruments };
}

export async function getOfficialDailyCloseData(): Promise<OfficialDailyCloseData> {
  const [twseResult, tpexResult] = await Promise.allSettled([
    fetchExchangeJson<TwseDailyCloseRow[]>(
      new URL("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"),
      0,
      "TWSE",
    ),
    fetchExchangeJson<TpexDailyCloseRow[]>(
      new URL("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"),
      0,
      "TPEx",
    ),
  ]);
  let twseRows =
    twseResult.status === "fulfilled" && Array.isArray(twseResult.value)
      ? twseResult.value
      : null;
  let tpexRows =
    tpexResult.status === "fulfilled" && Array.isArray(tpexResult.value)
      ? tpexResult.value
      : null;
  let twseDate = rocCompactDateToIso(twseRows?.[0]?.Date);
  let tpexDate = rocCompactDateToIso(tpexRows?.[0]?.Date);
  const knownDates = [twseDate, tpexDate].filter(
    (date): date is string => date !== null,
  );
  const expectedDate =
    knownDates.sort().at(-1) ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

  if (!twseRows?.length || twseDate !== expectedDate) {
    const fallbackUrl = new URL(
      "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX",
    );
    fallbackUrl.searchParams.set("date", expectedDate.replaceAll("-", ""));
    fallbackUrl.searchParams.set("type", "ALLBUT0999");
    fallbackUrl.searchParams.set("response", "json");
    const fallbackPayload = await fetchExchangeJson<unknown>(
      fallbackUrl,
      0,
      "TWSE MI_INDEX",
    );
    twseRows = parseTwseMiIndexDailyClose(fallbackPayload, expectedDate);
    twseDate = rocCompactDateToIso(twseRows[0]?.Date);
  }

  if (!tpexRows?.length || tpexDate !== expectedDate) {
    const fallbackUrl = new URL(
      "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes",
    );
    fallbackUrl.searchParams.set(
      "date",
      `${expectedDate.slice(0, 4)}/${expectedDate.slice(5, 7)}/${expectedDate.slice(8, 10)}`,
    );
    const fallbackPayload = await fetchOfficialJson(
      fallbackUrl,
      "tpex",
      expectedDate,
    );
    const fallbackMarket = parseTpexDailyMarket(
      fallbackPayload,
      expectedDate,
      fallbackUrl.toString(),
    );
    if (!fallbackMarket.quotes.length) {
      throw new MarketDataError("TPEx 官方收盤資料沒有有效的股票報價", 502);
    }
    const [year, month, day] = expectedDate.split("-");
    const rocDate = `${Number(year) - 1911}${month}${day}`;
    tpexRows = fallbackMarket.quotes.map((quote) => ({
      Date: rocDate,
      SecuritiesCompanyCode: quote.symbol,
      CompanyName: quote.name,
      Close: String(quote.close),
      Change: "",
      TradingShares: String(quote.volume),
      TransactionAmount: String(quote.turnover),
    }));
    tpexDate = expectedDate;
  }
  if (!twseDate || twseDate !== expectedDate || !tpexDate || tpexDate !== expectedDate) {
    throw new MarketDataError("上市與上櫃官方收盤資料日期不一致", 502);
  }

  const quotes: OfficialDailyClose[] = [];
  let twseQuoteCount = 0;
  let tpexQuoteCount = 0;
  for (const row of twseRows) {
    const symbol = row.Code?.trim().toUpperCase();
    const name = row.Name?.trim();
    const close = exchangeNumber(row.ClosingPrice);
    if (!symbol || !name || close === null || close <= 0) continue;
    quotes.push({
      symbol,
      name,
      exchange: "twse",
      close,
      change: exchangeNumber(row.Change),
      volume: exchangeNumber(row.TradeVolume),
      tradedValue: exchangeNumber(row.TradeValue),
    });
    twseQuoteCount += 1;
  }
  for (const row of tpexRows) {
    const symbol = row.SecuritiesCompanyCode?.trim().toUpperCase();
    const name = row.CompanyName?.trim();
    const close = exchangeNumber(row.Close);
    if (!symbol || !name || close === null || close <= 0) continue;
    quotes.push({
      symbol,
      name,
      exchange: "tpex",
      close,
      change: exchangeNumber(row.Change),
      volume: exchangeNumber(row.TradingShares),
      tradedValue: exchangeNumber(row.TransactionAmount),
    });
    tpexQuoteCount += 1;
  }
  if (twseQuoteCount === 0 || tpexQuoteCount === 0) {
    throw new MarketDataError("官方收盤資料未同時涵蓋上市與上櫃行情", 502);
  }
  return { asOf: twseDate, quotes };
}

export async function getOfficialMarketScanSnapshot(): Promise<OfficialMarketScanSnapshot> {
  const bounded = <T>(promise: Promise<T>, timeoutMs: number, source: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${source}查詢逾時`)), timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  const [twseResult, tpexResult] = await Promise.allSettled([
    bounded(fetchExchangeJson<TwseDailyCloseRow[]>(
      new URL("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"),
      0,
      "TWSE",
    ), 5_000, "TWSE"),
    bounded(fetchExchangeJson<TpexDailyCloseRow[]>(
      new URL("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"),
      0,
      "TPEx",
    ), 8_000, "TPEx"),
  ]);
  const reports: Array<{
    exchange: "twse" | "tpex";
    label: "TWSE" | "TPEx";
    date: string;
    quotes: OfficialDailyClose[];
  }> = [];
  const unavailableExchanges: Array<"TWSE" | "TPEx"> = [];

  let twseRows =
    twseResult.status === "fulfilled" && Array.isArray(twseResult.value)
      ? twseResult.value
      : null;
  let twseDate = rocCompactDateToIso(twseRows?.[0]?.Date);
  let twseReportSource = "TWSE 官方收盤";
  const tpexRows =
    tpexResult.status === "fulfilled" && Array.isArray(tpexResult.value)
      ? tpexResult.value
      : null;
  const tpexDate = rocCompactDateToIso(tpexRows?.[0]?.Date);

  if (tpexDate && twseDate && twseDate < tpexDate) {
    const fallbackUrl = new URL(
      "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX",
    );
    fallbackUrl.searchParams.set("date", tpexDate.replaceAll("-", ""));
    fallbackUrl.searchParams.set("type", "ALLBUT0999");
    fallbackUrl.searchParams.set("response", "json");
    try {
      const payload = await fetchExchangeJson<unknown>(
        fallbackUrl,
        0,
        "TWSE MI_INDEX",
      );
      twseRows = parseTwseMiIndexDailyClose(payload, tpexDate);
      twseDate = rocCompactDateToIso(twseRows[0]?.Date);
    } catch (error) {
      logger.warn(
        { expectedDate: tpexDate, err: error },
        "TWSE daily scan report is stale; MI_INDEX date repair failed",
      );
    }
  }

  const now = new Date();
  const taipeiParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const taipeiPart = (type: string) =>
    taipeiParts.find((part) => part.type === type)?.value ?? "";
  const currentTaipeiDate = `${taipeiPart("year")}-${taipeiPart("month")}-${taipeiPart("day")}`;
  const afterClose = Number(taipeiPart("hour")) * 60 + Number(taipeiPart("minute")) >= 13 * 60 + 30;
  const marketClosed = afterClose ? await isTaiwanMarketClosed(now) : true;
  const newestReportDate = [twseDate, tpexDate]
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(-1);
  if (afterClose && marketClosed !== true && newestReportDate && newestReportDate < currentTaipeiDate) {
    const fallbackUrl = new URL("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX");
    fallbackUrl.searchParams.set("date", currentTaipeiDate.replaceAll("-", ""));
    fallbackUrl.searchParams.set("type", "ALLBUT0999");
    fallbackUrl.searchParams.set("response", "json");
    try {
      const payload = await bounded(
        fetchExchangeJson<unknown>(fallbackUrl, 0, "TWSE MI_INDEX current date"),
        8_000,
        "TWSE MI_INDEX current-date",
      );
      twseRows = parseTwseMiIndexDailyClose(payload, currentTaipeiDate);
      twseDate = rocCompactDateToIso(twseRows[0]?.Date);
      twseReportSource = "TWSE MI_INDEX 官方收盤";
    } catch (error) {
      logger.warn(
        { expectedDate: currentTaipeiDate, newestReportDate, err: error },
        "Official daily reports lagged; current-date TWSE MI_INDEX fallback unavailable",
      );
    }
  }

  if (twseRows && twseDate) {
    const quotes = twseRows.flatMap((row): OfficialDailyClose[] => {
      const symbol = row.Code?.trim().toUpperCase();
      const name = row.Name?.trim();
      const close = exchangeNumber(row.ClosingPrice);
      if (!symbol || !name || close === null || close <= 0) return [];
      return [{
        symbol,
        name,
        exchange: "twse",
        close,
        change: exchangeNumber(row.Change),
        volume: exchangeNumber(row.TradeVolume),
        tradedValue: exchangeNumber(row.TradeValue),
      }];
    });
    if (quotes.length) reports.push({ exchange: "twse", label: "TWSE", date: twseDate, quotes });
    else unavailableExchanges.push("TWSE");
  } else {
    unavailableExchanges.push("TWSE");
  }

  if (tpexRows && tpexDate) {
    const quotes = tpexRows.flatMap((row): OfficialDailyClose[] => {
      const symbol = row.SecuritiesCompanyCode?.trim().toUpperCase();
      const name = row.CompanyName?.trim();
      const close = exchangeNumber(row.Close);
      if (!symbol || !name || close === null || close <= 0) return [];
      return [{
        symbol,
        name,
        exchange: "tpex",
        close,
        change: exchangeNumber(row.Change),
        volume: exchangeNumber(row.TradingShares),
        tradedValue: exchangeNumber(row.TransactionAmount),
      }];
    });
    if (quotes.length) reports.push({ exchange: "tpex", label: "TPEx", date: tpexDate, quotes });
    else unavailableExchanges.push("TPEx");
  } else {
    unavailableExchanges.push("TPEx");
  }

  if (!reports.length) {
    throw new MarketDataError("上市與上櫃官方收盤資料目前都無法取得", 502);
  }
  const asOf = reports.map((report) => report.date).sort().at(-1)!;
  for (const report of reports) {
    if (report.date !== asOf && !unavailableExchanges.includes(report.label)) {
      unavailableExchanges.push(report.label);
    }
  }
  const availableReports = reports.filter((report) => report.date === asOf);
  if (unavailableExchanges.length > 0) {
    try {
      const supplemental = await getOfficialDailyCloseData();
      const twseSupplementalRows = supplemental.quotes.filter((quote) => quote.exchange === "twse").length;
      const tpexSupplementalRows = supplemental.quotes.filter((quote) => quote.exchange === "tpex").length;
      const hasBothExchanges = twseSupplementalRows >= 500 && tpexSupplementalRows >= 500;
      if (supplemental.asOf >= asOf && hasBothExchanges) {
        return {
          asOf: supplemental.asOf,
          quotes: supplemental.quotes,
          availableExchanges: ["TWSE", "TPEx"],
          unavailableExchanges: [],
          source: "TWSE + TPEx 官方收盤",
        };
      }
      logger.warn(
        {
          expectedAtLeast: asOf,
          supplementalDate: supplemental.asOf,
          twseRows: twseSupplementalRows,
          tpexRows: tpexSupplementalRows,
        },
        "Supplemental official market reports did not cover both exchanges on the latest date",
      );
    } catch (error) {
      logger.warn(
        { expectedAtLeast: asOf, err: error },
        "Supplemental official market report lookup failed",
      );
    }
  }
  return {
    asOf,
    quotes: availableReports.flatMap((report) => report.quotes),
    availableExchanges: availableReports.map((report) => report.label),
    unavailableExchanges,
    source: availableReports.map((report) =>
      report.label === "TWSE" ? twseReportSource : "TPEx 官方收盤",
    ).join(" + "),
  };
}

function exchangeMonths(
  range: SupportedRange,
  anchorDate?: string,
  countOverride?: number,
): string[] {
  const parts = anchorDate ? null : new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
      }).formatToParts(new Date());
  const year = anchorDate
    ? Number(anchorDate.slice(0, 4))
    : Number(parts?.find((part) => part.type === "year")?.value);
  const month = anchorDate
    ? Number(anchorDate.slice(5, 7))
    : Number(parts?.find((part) => part.type === "month")?.value);
  const count = countOverride ?? (
    range === "1mo" ? 2 :
    range === "3mo" ? 4 :
    range === "6mo" ? 7 :
    range === "1y" ? 13 :
    range === "3y" ? 37 : 61
  );

  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1 - offset, 1));
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}01`;
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index]!);
      }
    }),
  );
  return results;
}

function gregorianDate(rocDate: string | undefined): string | null {
  const match = rocDate?.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]) + 1911;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function exchangeBar(
  row: string[],
  indices: { volume: number | null; open: number; high: number; low: number; close: number },
): ExchangeDay | null {
  const date = gregorianDate(row[0]);
  const open = exchangeNumber(row[indices.open]);
  const high = exchangeNumber(row[indices.high]);
  const low = exchangeNumber(row[indices.low]);
  const close = exchangeNumber(row[indices.close]);
  if (date === null || open === null || high === null || low === null || close === null) {
    return null;
  }
  return {
    date,
    timestamp: Date.parse(`${date}T05:30:00.000Z`),
    open,
    high,
    low,
    close,
    volume: indices.volume === null ? null : exchangeNumber(row[indices.volume]),
  };
}

function rangeStartDate(range: SupportedRange): string {
  const days =
    range === "1mo" ? 31 :
    range === "3mo" ? 93 :
    range === "6mo" ? 186 :
    range === "1y" ? 366 :
    range === "3y" ? 1_096 : 1_826;
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function keepRange(
  days: ExchangeDay[],
  range: SupportedRange,
  startDate = rangeStartDate(range),
): ExchangeDay[] {
  return days.filter((bar) => bar.date >= startDate);
}

async function fetchTwseStockMonth(
  stockCode: string,
  month: string,
  signal?: AbortSignal,
): Promise<string[][]> {
  return getCachedExchangeMonth(`twse:${stockCode}:${month}`, async () => {
    const url = new URL("https://www.twse.com.tw/exchangeReport/STOCK_DAY");
    url.searchParams.set("response", "json");
    url.searchParams.set("date", month);
    url.searchParams.set("stockNo", stockCode);
    const response = await withExchangeHistoryRequestSlot(
      () => fetchExchangeJson<ExchangeDailyResponse>(url, 90_000, "臺灣證券交易所", signal),
      signal,
    );
    return response.stat === "OK" ? response.data ?? [] : [];
  }, signal);
}

async function fetchTpexStockMonth(
  stockCode: string,
  month: string,
  signal?: AbortSignal,
): Promise<string[][]> {
  return getCachedExchangeMonth(`tpex:${stockCode}:${month}`, async () => {
    const url = new URL(
      "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock",
    );
    url.searchParams.set("code", stockCode);
    url.searchParams.set("date", `${month.slice(0, 4)}/${month.slice(4, 6)}/01`);
    const response = await withExchangeHistoryRequestSlot(
      () => fetchExchangeJson<ExchangeDailyResponse>(url, 90_000, "臺灣證券交易所", signal),
      signal,
    );
    return response.tables?.[0]?.data ?? [];
  }, signal);
}

async function getCachedExchangeMonth(
  key: string,
  load: () => Promise<string[][]>,
  signal?: AbortSignal,
): Promise<string[][]> {
  if (signal) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return load();
  }
  const taiwanParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const currentMonthKey = `${taiwanParts.find((part) => part.type === "year")?.value}${taiwanParts.find((part) => part.type === "month")?.value}01`;
  const ttlMs = key.endsWith(currentMonthKey) ? 60_000 : EXCHANGE_MONTH_CACHE_TTL_MS;
  const cached = exchangeMonthCache.get(key);
  if (cached && Date.now() - cached.loadedAt < ttlMs) {
    return cached.promise;
  }
  const promise = load();
  exchangeMonthCache.set(key, { loadedAt: Date.now(), promise });
  try {
    const rows = await promise;
    if (exchangeMonthCache.size > 1_000) {
      const oldest = exchangeMonthCache.keys().next().value;
      if (oldest) exchangeMonthCache.delete(oldest);
    }
    return rows;
  } catch (error) {
    if (exchangeMonthCache.get(key)?.promise === promise) {
      exchangeMonthCache.delete(key);
    }
    throw error;
  }
}

async function fetchTwseTaiexMonth(month: string): Promise<string[][]> {
  const url = new URL(
    "https://www.twse.com.tw/indicesReport/MI_5MINS_HIST",
  );
  url.searchParams.set("response", "json");
  url.searchParams.set("date", month);
  const response = await fetchExchangeJson<ExchangeDailyResponse>(url);
  return response.stat === "OK" ? response.data ?? [] : [];
}

async function getExchangeHistory(
  range: SupportedRange,
  fetchMonth: (month: string) => Promise<string[][]>,
  indices: { volume: number | null; open: number; high: number; low: number; close: number },
  window?: { startDate: string; endDate: string; monthCount: number },
): Promise<ExchangeDay[]> {
  const months = exchangeMonths(range, window?.endDate, window?.monthCount);
  const monthlyRows = await mapWithConcurrency(months, 2, fetchMonth);
  const uniqueDays = new Map<string, ExchangeDay>();
  for (const row of monthlyRows.flat()) {
    const bar = exchangeBar(row, indices);
    if (bar) uniqueDays.set(bar.date, bar);
  }
  return keepRange(
    [...uniqueDays.values()].sort((left, right) => left.date.localeCompare(right.date)),
    range,
    window?.startDate,
  );
}

function taiwanMarketCloseDate(date: string): Date {
  return new Date(`${date}T13:30:00+08:00`);
}

async function fetchTwseTaiexQuote(): Promise<MarketQuoteData> {
  const url = new URL("https://mis.twse.com.tw/stock/api/getStockInfo.jsp");
  url.searchParams.set("ex_ch", "tse_t00.tw");
  url.searchParams.set("_", String(Date.now()));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(7_000),
    });
  } catch {
    throw new MarketDataError("TWSE MIS 暫時無法連線", 502);
  }
  if (!response.ok) {
    throw new MarketDataError(`TWSE MIS 回應 HTTP ${response.status}`, 502);
  }

  const payload = (await response.json()) as TwseQuotePayload;
  const row = payload.msgArray?.[0];
  const price = numericText(row?.z);
  const previous = numericText(row?.y);
  if (!row || price === null || previous === null || price <= 0) {
    throw new MarketDataError("TWSE MIS 目前沒有可用的大盤報價", 502);
  }

  const date = row.d ?? "";
  const time = row.t ?? "13:30:00";
  const datePart =
    /^\d{8}$/.test(date)
      ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
      : new Date().toISOString().slice(0, 10);
  const asOf = new Date(`${datePart}T${time}+08:00`);
  const change = price - previous;

  return {
    key: "taiex",
    name: "加權指數",
    ticker: "^TWII",
    price,
    change,
    changePercent: (change / previous) * 100,
    source: "TWSE MIS",
    asOf: Number.isNaN(asOf.getTime()) ? null : asOf,
    available: true,
    error: null,
  };
}

async function fetchTwseStockQuote(
  symbol: string,
  exchange: "tse" | "otc",
): Promise<StockQuoteData> {
  const stockCode = symbol.trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
  if (!/^[A-Z0-9]{4,6}$/.test(stockCode)) {
    throw new MarketDataError("請輸入台灣上市或上櫃股票代號", 400);
  }

  const url = new URL("https://mis.twse.com.tw/stock/api/getStockInfo.jsp");
  url.searchParams.set("ex_ch", `${exchange}_${stockCode}.tw`);
  url.searchParams.set("json", "1");
  url.searchParams.set("delay", "0");
  url.searchParams.set("_", String(Date.now()));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Referer: "https://mis.twse.com.tw/stock/index.jsp",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(7_000),
    });
  } catch {
    throw new MarketDataError("TWSE MIS 個股報價暫時無法連線", 502);
  }
  if (!response.ok) {
    throw new MarketDataError(
      `TWSE MIS 個股報價回應 HTTP ${response.status}`,
      502,
    );
  }

  let payload: TwseQuotePayload;
  try {
    payload = (await response.json()) as TwseQuotePayload;
  } catch {
    throw new MarketDataError("TWSE MIS 回傳無法辨識的個股報價", 502);
  }

  const row = payload.msgArray?.find((item) => item.c === stockCode);
  // MIS may put the latest trade under `trade.z` while the top-level `z` is "-".
  const price = numericText(row?.z) ?? numericText(row?.trade?.z);
  if (!row || price === null || price <= 0) {
    throw new MarketDataError("TWSE MIS 目前沒有可用的最新成交價", 502);
  }

  const previousClose = numericText(row.y);
  const change =
    previousClose === null ? null : price - previousClose;
  const changePercent =
    previousClose === null || previousClose <= 0 || change === null
      ? null
      : (change / previousClose) * 100;

  let asOf: Date | null = null;
  const tradeTime = row.trade?.t;
  const reportedTime = tradeTime ?? row.t;
  if (/^\d{8}$/.test(row.d ?? "") && /^\d{2}:\d{2}:\d{2}$/.test(reportedTime ?? "")) {
    const datePart = `${row.d!.slice(0, 4)}-${row.d!.slice(4, 6)}-${row.d!.slice(6, 8)}`;
    const parsed = new Date(`${datePart}T${reportedTime}+08:00`);
    if (!Number.isNaN(parsed.getTime())) asOf = parsed;
  }
  if (!asOf && row.tlong) {
    const timestamp = Number(row.tlong);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      asOf = new Date(timestamp);
    }
  }

  return {
    name: row.n?.trim() || null,
    price,
    previousClose,
    change,
    changePercent,
    source: tradeTime
      ? "TWSE MIS · 成交時間"
      : "TWSE MIS · 報價更新時間",
    asOf,
    available: true,
    error: null,
  };
}

export async function getStockQuote(
  symbol: string,
  exchange: "tse" | "otc",
  {
    maxInSessionAgeMs = STOCK_QUOTE_MAX_AGE_MS,
  }: { maxInSessionAgeMs?: number } = {},
): Promise<StockQuoteData> {
  if (!process.env.FUGLE_API_KEY?.trim()) {
    return validateStockQuoteFreshness(
      await fetchTwseStockQuote(symbol, exchange),
      new Date(),
      maxInSessionAgeMs,
    );
  }

  try {
    return validateStockQuoteFreshness(
      await fetchFugleStockQuote(symbol),
      new Date(),
      maxInSessionAgeMs,
    );
  } catch (fugleError) {
    try {
      const fallback = await fetchTwseStockQuote(symbol, exchange);
      const timestampLabel = fallback.source.includes("成交時間")
        ? "成交時間"
        : "報價更新時間";
      return validateStockQuoteFreshness({
        ...fallback,
        source: `TWSE MIS（Fugle 備援）· ${timestampLabel}`,
      }, new Date(), maxInSessionAgeMs);
    } catch (misError) {
      const fugleMessage =
        fugleError instanceof Error ? fugleError.message : "Fugle 報價失敗";
      const misMessage =
        misError instanceof Error ? misError.message : "TWSE MIS 報價失敗";
      throw new MarketDataError(
        `${fugleMessage}；備援來源：${misMessage}`,
        502,
      );
    }
  }
}

export async function getMarketWideStockQuotes(
  instruments: Array<Pick<OfficialDailyClose, "symbol" | "exchange">>,
  now = new Date(),
  onProgress?: (completed: number, total: number) => void,
): Promise<Map<string, StockQuoteData>> {
  const quotes = new Map<string, StockQuoteData>();
  if (!instruments.length) return quotes;

  const channels = [...new Map(instruments.map((instrument) => {
    const symbol = instrument.symbol.trim().toUpperCase();
    const exchange = instrument.exchange === "twse" ? "tse" : "otc";
    return [`${exchange}_${symbol}.tw`, { symbol, exchange, instrumentExchange: instrument.exchange }] as const;
  })).values()];
  const batchSize = 80;
  const batches = Array.from(
    { length: Math.ceil(channels.length / batchSize) },
    (_, index) => channels.slice(index * batchSize, (index + 1) * batchSize),
  );
  let nextBatch = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, async () => {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch++]!;
      const url = new URL("https://mis.twse.com.tw/stock/api/getStockInfo.jsp");
      url.searchParams.set(
        "ex_ch",
        batch.map(({ exchange, symbol }) => `${exchange}_${symbol}.tw`).join("|"),
      );
      url.searchParams.set("json", "1");
      url.searchParams.set("delay", "0");
      url.searchParams.set("_", String(now.getTime()));
      try {
        let response: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            response = await fetch(url, {
              headers: {
                Accept: "application/json",
                Referer: "https://mis.twse.com.tw/stock/index.jsp",
                "User-Agent": USER_AGENT,
              },
              signal: AbortSignal.timeout(8_000),
            });
          } catch (error) {
            if (attempt === 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
            continue;
          }
          if (
            response.ok ||
            (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) ||
            attempt === 2
          ) break;
          const retryAfter = response.status === 429
            ? retryAfterMilliseconds(response)
            : null;
          if (retryAfter !== null && retryAfter > MAX_EXCHANGE_HISTORY_RETRY_AFTER_MS) break;
          await new Promise((resolve) => setTimeout(
            resolve,
            retryAfter ?? 300 * (attempt + 1),
          ));
        }
        if (!response) throw new Error("TWSE MIS 批次報價未回應");
        if (!response.ok) throw new Error(`TWSE MIS 批次報價 HTTP ${response.status}`);
        const payload = await response.json() as TwseQuotePayload;
        for (const row of payload.msgArray ?? []) {
          const symbol = row.c?.trim().toUpperCase();
          if (!symbol) continue;
          const instrument = batch.find((item) => item.symbol === symbol);
          if (!instrument || row.ex !== instrument.exchange) continue;

          // The market-wide scan requires an actual trade timestamp and the
          // cumulative session volume; quote-update-only rows are not eligible.
          const price = numericText(row.trade?.z);
          const volumeLots = numericText(row.v);
          const date = row.d ?? "";
          const time = row.trade?.t ?? "";
          if (
            price === null || price <= 0 ||
            volumeLots === null || volumeLots <= 0 ||
            !/^\d{8}$/.test(date) ||
            !/^\d{2}:\d{2}:\d{2}$/.test(time)
          ) continue;
          const asOf = new Date(
            `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time}+08:00`,
          );
          if (Number.isNaN(asOf.getTime())) continue;
          const previousClose = numericText(row.y);
          if (previousClose === null || previousClose <= 0) continue;
          const change = price - previousClose;
          try {
            const quote = validateStockQuoteFreshness({
              name: row.n?.trim() || null,
              price,
              previousClose,
              change,
              changePercent: (change / previousClose) * 100,
              // MIS reports cumulative volume in lots (1,000 shares).
              volume: volumeLots * 1_000,
              openPrice: numericText(row.o) ?? undefined,
              highPrice: numericText(row.h) ?? undefined,
              lowPrice: numericText(row.l) ?? undefined,
              source: "TWSE MIS 批次 · 成交時間",
              asOf,
              available: true,
              error: null,
            }, new Date(), 180_000);
            quotes.set(symbol, quote);
          } catch {
            // Exclude stale or malformed rows individually; one bad quote must
            // not discard the rest of a successful provider batch.
          }
        }
      } catch (error) {
        logger.warn(
          { err: error, batchSize: batch.length },
          "Unable to fetch a TWSE MIS market-wide quote batch",
        );
      } finally {
        completed += batch.length;
        onProgress?.(completed, channels.length);
      }
    }
  }));
  return quotes;
}

export function isTaiwanStockSessionOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const minuteOfDay = hour * 60 + minute;
  return (
    ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday ?? "") &&
    minuteOfDay >= 9 * 60 &&
    minuteOfDay < 13 * 60 + 30
  );
}

function validateStockQuoteFreshness(
  quote: StockQuoteData,
  now = new Date(),
  maxInSessionAgeMs = STOCK_QUOTE_MAX_AGE_MS,
): StockQuoteData {
  if (!quote.available || quote.price === null) {
    throw new MarketDataError(
      quote.error ?? "來源沒有提供可用的個股成交報價",
      502,
    );
  }
  if (!quote.asOf) {
    throw new MarketDataError("個股報價來源未提供成交時間，暫不顯示該報價", 502);
  }
  const age = quote.asOf ? now.getTime() - quote.asOf.getTime() : Infinity;
  if (age < -60_000) {
    throw new MarketDataError("個股報價來源回報了未來時間，暫不顯示該報價", 502);
  }
  const quoteAgeLimitMs = quote.source.includes("成交時間")
    ? maxInSessionAgeMs
    : STOCK_QUOTE_MAX_AGE_MS;
  if (isTaiwanStockSessionOpen(now) && age > quoteAgeLimitMs) {
    throw new MarketDataError(
      `個股即時報價超過 ${Math.round(quoteAgeLimitMs / 1_000)} 秒未更新，已停止顯示舊價格`,
      502,
    );
  }
  if (!isTaiwanStockSessionOpen(now)) {
    if (!quote.source.includes("成交時間")) {
      throw new MarketDataError(
        "個股報價來源只提供非交易時段更新時間，改用官方最近收盤價。",
        502,
      );
    }
    return {
      ...quote,
      source: quote.source.includes("盤後最後成交")
        ? quote.source
        : `${quote.source} · 盤後最後成交`,
    };
  }
  return quote;
}

const MAX_REASONABLE_TAIEX_DAILY_MOVE_PERCENT = 15;

function validateTaiexMoveFromOfficialClose(
  price: number,
  previousClose: number | null,
): void {
  if (previousClose === null || !Number.isFinite(previousClose) || previousClose <= 0) {
    throw new MarketDataError(
      "缺少官方前一交易日收盤價，無法驗證 Fugle 加權指數報價",
      502,
    );
  }

  const changePercent = ((price - previousClose) / previousClose) * 100;
  if (
    !Number.isFinite(changePercent) ||
    Math.abs(changePercent) > MAX_REASONABLE_TAIEX_DAILY_MOVE_PERCENT
  ) {
    throw new MarketDataError(
      `Fugle 加權指數相較官方前收變動 ${changePercent.toFixed(2)}%，判定為異常報價`,
      502,
    );
  }
}

function validateTaiexQuoteFreshness(
  quote: MarketQuoteData,
  now = new Date(),
): MarketQuoteData {
  const age = quote.asOf ? now.getTime() - quote.asOf.getTime() : Infinity;
  if (age < -60_000) {
    throw new MarketDataError("加權指數來源回報了未來時間，暫不顯示該報價", 502);
  }
  if (isTaiwanStockSessionOpen(now) && age > 90_000) {
    throw new MarketDataError(
      "加權指數即時報價超過 90 秒未更新，已停止顯示舊價格",
      502,
    );
  }
  if (!isTaiwanStockSessionOpen(now)) {
    const suffix =
      age > 90_000 ? "盤後最後指數" : "非交易時段更新";
    return {
      ...quote,
      source:
        quote.source?.includes(suffix) === true
          ? quote.source
          : `${quote.source ?? "指數行情"} · ${suffix}`,
    };
  }
  return quote;
}

export async function getTaiexQuote(): Promise<MarketQuoteData> {
  try {
    const tick = await fetchFugleTaiexIndexTick();
    let previousClose: number | null = null;
    try {
      const history = await getTaiexHistory("1mo");
      const taipeiDate = new Date(tick.asOf.getTime() + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      previousClose =
        history.bars.filter((bar) => bar.date < taipeiDate).at(-1)?.close ??
        null;
    } catch {
      // A valid WebSocket index tick remains useful without a calculated daily change.
    }
    const fugleQuote = toFugleTaiexMarketQuote(tick, previousClose);
    if (fugleQuote.price === null || fugleQuote.price <= 0) {
      throw new MarketDataError("Fugle 加權指數沒有有效的正數報價", 502);
    }
    validateTaiexMoveFromOfficialClose(fugleQuote.price, previousClose);
    return validateTaiexQuoteFreshness(fugleQuote);
  } catch (fugleError) {
    try {
      return validateTaiexQuoteFreshness(await fetchTwseTaiexQuote());
    } catch (misError) {
      const fugleMessage =
        fugleError instanceof Error ? fugleError.message : "Fugle 指數行情失敗";
      const misMessage =
        misError instanceof Error ? misError.message : "TWSE MIS 大盤行情失敗";
      try {
        const history = await getTaiexHistory("1mo");
        const latest = history.bars.at(-1);
        const previous = history.bars.at(-2);
        if (!latest) throw new MarketDataError("沒有可用的大盤收盤資料", 404);
        const change = previous ? latest.close - previous.close : null;
        return {
          key: "taiex",
          name: "加權指數",
          ticker: "^TWII",
          price: latest.close,
          change,
          changePercent:
            previous && previous.close > 0 && change !== null
              ? (change / previous.close) * 100
              : null,
          source: `${history.source} · 最近收盤價`,
          asOf: history.asOf,
          available: true,
          error: null,
        };
      } catch (historyError) {
        const historyMessage =
          historyError instanceof Error
            ? historyError.message
            : "最近收盤資料目前無法取得";
        throw new MarketDataError(
          `${fugleMessage}；備援來源：${misMessage}；收盤資料：${historyMessage}`,
          502,
        );
      }
    }
  }
}

function unavailableFuturesQuote(
  session: "day" | "night",
  error: string,
): MarketQuoteData {
  const label = session === "day" ? "日盤" : "夜盤";
  return {
    key: session === "day" ? "futures_day" : "futures_night",
    name: `臺指期${label}`,
    ticker: session === "day" ? "TXF-F" : "TXF-M",
    price: null,
    change: null,
    changePercent: null,
    source: null,
    asOf: null,
    available: false,
    error,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function getFuturesQuotes(): Promise<MarketQuoteData[]> {
  const marketClosed = await isTaiwanMarketClosed();
  if (marketClosed === true) {
    const deadline = Date.now() + FUTURES_QUOTE_BUDGET_MS;
    return Promise.all(
      (["day", "night"] as const).map(async (session) => {
        try {
          const quote = await withTimeout(
            fetchTaifexDailyFuturesQuote(session),
            deadline - Date.now(),
            "TAIFEX 官方最近收盤價查詢逾時",
          );
          return quote ?? unavailableFuturesQuote(
            session,
            "休市日暫時無法取得 TAIFEX 官方最近收盤價。",
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "TAIFEX 官方日行情查詢失敗";
          return unavailableFuturesQuote(session, `休市日暫無收盤報價：${message}`);
        }
      }),
    );
  }

  const deadline = Date.now() + FUTURES_QUOTE_BUDGET_MS;
  const failures: string[] = [];
  let quotes: MarketQuoteData[] | null = null;

  try {
    quotes = await withTimeout(
      fetchTaifexFuturesQuotes(),
      deadline - Date.now(),
      "TAIFEX MIS 即時行情逾時",
    );
  } catch (taifexError) {
    failures.push(
      taifexError instanceof Error
        ? `TAIFEX MIS：${taifexError.message}`
        : "TAIFEX MIS 即時報價失敗",
    );
  }

  if (process.env.FUGLE_API_KEY?.trim() && (!quotes || quotes.some((quote) => !quote.available))) {
    try {
      const fallbackQuote = await withTimeout(
        fetchFugleFuturesQuote(),
        deadline - Date.now(),
        "期貨即時備援來源逾時",
      );
      const session = fallbackQuote.key === "futures_night" ? "night" : "day";
      const fallbackIndex = session === "day" ? 0 : 1;
      if (!quotes) {
        quotes = [
          unavailableFuturesQuote(
            "day",
            "目前沒有可用的臺指期日盤即時報價。",
          ),
          unavailableFuturesQuote(
            "night",
            "目前沒有可用的臺指期夜盤即時報價。",
          ),
        ];
      }
      if (!quotes[fallbackIndex]?.available) {
        quotes[fallbackIndex] = fallbackQuote;
      }
    } catch (fugleError) {
      const fugleMessage =
        fugleError instanceof Error
          ? `Fugle：${fugleError.message}`
          : "Fugle 期貨行情失敗";
      failures.push(
        fugleMessage,
      );
      if (quotes) {
        const dayQuote = quotes[0];
        if (dayQuote && !dayQuote.available) {
          quotes[0] = {
            ...dayQuote,
            error: `${dayQuote.error ?? "臺指期日盤無可用即時報價"}；${fugleMessage}`,
          };
        }
        const nightQuote = quotes[1];
        if (nightQuote && !nightQuote.available) {
          quotes[1] = {
            ...nightQuote,
            error: `${nightQuote.error ?? "臺指期夜盤無可用即時報價"}；${fugleMessage}`,
          };
        }
      }
    }
  }

  if (!quotes) {
    const error = failures.length
      ? `${failures.join("；")}；目前沒有可驗證的即時期貨報價。`
      : "即時期貨來源目前無可用報價。";
    quotes = [
      unavailableFuturesQuote("day", error),
      unavailableFuturesQuote("night", error),
    ];
  }

  return quotes;
}

export async function getMarketQuotes(): Promise<MarketQuoteData[]> {
  const settled = await Promise.allSettled([
    getTaiexQuote(),
    getFuturesQuotes(),
  ]);
  const [taiexResult, futuresResult] = settled;
  const taiexQuote: MarketQuoteData =
    taiexResult.status === "fulfilled"
      ? taiexResult.value
      : {
      key: "taiex",
      name: "加權指數",
      ticker: "^TWII",
      price: null,
      change: null,
      changePercent: null,
      source: null,
      asOf: null,
      available: false,
      error:
        taiexResult.reason instanceof Error
          ? taiexResult.reason.message
          : "目前無法取得行情",
    };
  const futuresQuotes =
    futuresResult.status === "fulfilled"
      ? futuresResult.value
      : [
          unavailableFuturesQuote(
            "day",
            futuresResult.reason instanceof Error
              ? futuresResult.reason.message
              : "目前無法取得臺指期日盤行情",
          ),
          unavailableFuturesQuote(
            "night",
            futuresResult.reason instanceof Error
              ? futuresResult.reason.message
              : "目前無法取得臺指期夜盤行情",
          ),
        ];
  const quotes = [taiexQuote, ...futuresQuotes];

  if (!quotes.some((quote) => quote.available)) {
    throw new MarketDataError("目前無法從行情來源取得大盤資料", 502);
  }
  return quotes;
}

function unavailableUsMarketIndicator(
  config: UsMarketIndicatorConfig,
  error: string,
): MarketQuoteData {
  return {
    key: config.key,
    name: config.name,
    ticker: config.ticker,
    price: null,
    change: null,
    changePercent: null,
    source: null,
    asOf: null,
    available: false,
    error,
  };
}

function parseNasdaqNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNasdaqTimestamp(
  value: string | undefined,
): { asOf: Date | null; dateLabel: string; hasTime: boolean } | null {
  if (!value) return null;
  const match =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+ET)?$/i.exec(
      value.trim(),
    );
  if (!match) return null;

  const month = new Map([
    ["jan", 0],
    ["feb", 1],
    ["mar", 2],
    ["apr", 3],
    ["may", 4],
    ["jun", 5],
    ["jul", 6],
    ["aug", 7],
    ["sep", 8],
    ["oct", 9],
    ["nov", 10],
    ["dec", 11],
  ]).get(match[1]!.toLowerCase());
  if (month === undefined) return null;

  const day = Number(match[2]);
  const year = Number(match[3]);
  const dateLabel = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!match[4] || !match[5] || !match[6]) {
    return {
      asOf: null,
      dateLabel,
      hasTime: false,
    };
  }

  let hour = Number(match[4]) % 12;
  if (match[6].toUpperCase() === "PM") hour += 12;
  const minute = Number(match[5]);
  const easternWallTimeAsUtc = Date.UTC(year, month, day, hour, minute);
  const easternOffsetAt = (timestamp: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const part = (type: string) =>
      Number(parts.find((item) => item.type === type)?.value);
    return (
      Date.UTC(
        part("year"),
        part("month") - 1,
        part("day"),
        part("hour"),
        part("minute"),
      ) - timestamp
    );
  };
  const firstOffset = easternOffsetAt(easternWallTimeAsUtc);
  const firstTimestamp = easternWallTimeAsUtc - firstOffset;
  const resolvedTimestamp =
    easternWallTimeAsUtc - easternOffsetAt(firstTimestamp);
  const asOf = new Date(resolvedTimestamp);
  const easternDateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(asOf);
  const easternPart = (type: string) =>
    Number(easternDateParts.find((item) => item.type === type)?.value);
  if (
    Number.isNaN(asOf.getTime()) ||
    easternPart("year") !== year ||
    easternPart("month") !== month + 1 ||
    easternPart("day") !== day
  ) {
    return null;
  }
  return { asOf, dateLabel, hasTime: true };
}

async function fetchUsMarketIndicator(
  config: UsMarketIndicatorConfig,
): Promise<MarketQuoteData> {
  const url = new URL(
    `https://api.nasdaq.com/api/quote/${config.ticker}/info`,
  );
  url.searchParams.set("assetclass", config.nasdaqAssetClass);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Origin: "https://www.nasdaq.com",
        Referer: "https://www.nasdaq.com/",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    return unavailableUsMarketIndicator(
      config,
      error instanceof Error
        ? `Nasdaq 暫時無法連線：${error.message}`
        : "Nasdaq 暫時無法連線",
    );
  }
  if (!response.ok) {
    return unavailableUsMarketIndicator(
      config,
      `Nasdaq 回應 HTTP ${response.status}`,
    );
  }

  let payload: NasdaqQuotePayload;
  try {
    payload = (await response.json()) as NasdaqQuotePayload;
  } catch {
    return unavailableUsMarketIndicator(
      config,
      "Nasdaq 回傳無法辨識的行情資料",
    );
  }

  const primaryData = payload.data?.primaryData;
  const price = parseNasdaqNumber(primaryData?.lastSalePrice);
  const change = parseNasdaqNumber(primaryData?.netChange);
  const changePercent = parseNasdaqNumber(primaryData?.percentageChange);
  const timestamp = parseNasdaqTimestamp(primaryData?.lastTradeTimestamp);
  if (
    price === null ||
    price <= 0 ||
    change === null ||
    changePercent === null ||
    !timestamp
  ) {
    return unavailableUsMarketIndicator(
      config,
      payload.status?.bCodeMessage?.[0]?.errorMessage ??
        `Nasdaq 回傳的${config.name}價格或來源時間不完整`,
    );
  }

  return {
    key: config.key,
    name: config.name,
    ticker: config.ticker,
    price,
    change,
    changePercent,
    source: timestamp.hasTime
      ? `Nasdaq · ${payload.data?.exchange ?? "美股"} · ${primaryData?.isRealTime ? "即時報價" : "延遲報價"}`
      : `Nasdaq · PHLX 指數 · 資料日期 ${timestamp.dateLabel}`,
    asOf: timestamp.asOf,
    available: true,
    error: null,
  };
}

function getUsMarketIndicator(
  config: UsMarketIndicatorConfig,
): Promise<MarketQuoteData> {
  const cached = usMarketIndicatorCache.get(config.key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = fetchUsMarketIndicator(config).catch((error: unknown) =>
    unavailableUsMarketIndicator(
      config,
      error instanceof Error
        ? error.message
        : "Nasdaq 暫時無法提供報價",
    ),
  );
  const entry = {
    expiresAt: Date.now() + US_MARKET_INDICATOR_CACHE_TTL_MS,
    promise,
  };
  usMarketIndicatorCache.set(config.key, entry);
  if (usMarketIndicatorCache.size > 20) {
    for (const [key, value] of usMarketIndicatorCache) {
      if (value.expiresAt <= Date.now()) usMarketIndicatorCache.delete(key);
    }
  }
  return promise;
}

const dowJonesConfig: UsMarketIndicatorConfig = {
  key: "us_sox",
  name: "道瓊工業指數",
  ticker: "^DJI",
  nasdaqAssetClass: "index",
};

async function getDowJonesIndicator(): Promise<UsPremarketIndex> {
  try {
    const response = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5EDJI?range=5d&interval=1d",
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
    const payload = await response.json() as {
      chart?: { result?: Array<{ meta?: {
        symbol?: string;
        regularMarketPrice?: number;
        regularMarketTime?: number;
        chartPreviousClose?: number;
      } }> | null };
    };
    const meta = payload.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const previousClose = meta?.chartPreviousClose;
    const asOf = meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1_000) : null;
    if (
      meta?.symbol !== "^DJI" ||
      !Number.isFinite(price) || price! <= 0 ||
      !Number.isFinite(previousClose) || previousClose! <= 0 ||
      !asOf || Number.isNaN(asOf.getTime())
    ) {
      throw new Error("Yahoo Finance 道瓊資料欄位不完整");
    }
    const change = price! - previousClose!;
    return {
      name: dowJonesConfig.name,
      ticker: dowJonesConfig.ticker,
      price: price!,
      change,
      changePercent: (change / previousClose!) * 100,
      source: "Yahoo Finance · 道瓊指數",
      asOf,
      available: true,
      error: null,
    };
  } catch (error) {
    return {
      name: dowJonesConfig.name,
      ticker: dowJonesConfig.ticker,
      price: null,
      change: null,
      changePercent: null,
      source: null,
      asOf: null,
      available: false,
      error: error instanceof Error ? error.message : "道瓊資料暫不可用",
    };
  }
}

export async function getUsPremarketIndices(): Promise<{
  nasdaq: UsPremarketIndex;
  dow: UsPremarketIndex;
}> {
  const [nasdaqQuote, dow] = await Promise.all([
    fetchUsMarketIndicator(usPremarketIndexConfigs[0]!).catch((error: unknown) =>
      unavailableUsMarketIndicator(
        usPremarketIndexConfigs[0]!,
        error instanceof Error ? error.message : "納斯達克指數資料暫不可用",
      ),
    ),
    getDowJonesIndicator(),
  ]);
  const { key: _key, ...nasdaq } = nasdaqQuote;
  return { nasdaq, dow };
}

export async function getMarketOverviewQuotes(): Promise<MarketQuoteData[]> {
  const [taiwanQuotes, usQuotes] = await Promise.all([
    getMarketQuotes(),
    Promise.all(usMarketIndicatorConfigs.map(getUsMarketIndicator)),
  ]);
  return [...taiwanQuotes, ...usQuotes];
}

export async function getTaiexHistory(
  range: SupportedRange,
): Promise<HistoryData> {
  let officialBars: YahooBar[] = [];
  let officialError: unknown = null;
  try {
    const exchangeDays = await getExchangeHistory(
      range,
      fetchTwseTaiexMonth,
      { volume: null, open: 1, high: 2, low: 3, close: 4 },
    );
    officialBars = exchangeDays.map((day) => ({ ...day, volume: null }));
  } catch (error) {
    officialError = error;
  }

  const minimumBars = range === "1y" ? 120 : range === "5y" ? 500 : 2;
  let yahooBars: YahooBar[] = [];
  try {
    yahooBars = await getYahooDailyBars("^TWII", "5d");
  } catch (error) {
    logger.warn(
      { err: error, range },
      "Unable to retrieve TAIEX daily history from Yahoo Finance fallback",
    );
  }
  const officialLatestDate = officialBars.at(-1)?.date ?? "";
  const yahooLatestDate = yahooBars.at(-1)?.date ?? "";
  if (yahooLatestDate > officialLatestDate) {
    const mergedBars = new Map(officialBars.map((bar) => [bar.date, bar]));
    for (const bar of yahooBars) {
      if (bar.date > officialLatestDate) mergedBars.set(bar.date, bar);
    }
    const latest = [...mergedBars.values()].sort((left, right) => left.date.localeCompare(right.date)).at(-1);
    const bars = [...mergedBars.values()]
      .sort((left, right) => left.date.localeCompare(right.date))
      .filter((bar) => {
        const cutoff = new Date(Date.now() - HISTORY_RANGE_CALENDAR_DAYS[range] * 86_400_000)
          .toISOString()
          .slice(0, 10);
        return bar.date >= cutoff;
      });
    if (latest && bars.length >= minimumBars) {
    return {
      ticker: "^TWII",
      source: "TWSE Open Data + Yahoo Finance · ^TWII 日線備援",
      range,
      asOf: taiwanMarketCloseDate(latest.date),
      bars,
    };
    }
  }
  if (officialBars.length >= minimumBars) {
    const latest = officialBars.at(-1)!;
    return {
      ticker: "^TWII",
      source: "TWSE Open Data",
      range,
      asOf: taiwanMarketCloseDate(latest.date),
      bars: officialBars,
    };
  }

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const end = `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
    const start = new Date(Date.parse(`${end}T00:00:00Z`) - (
      range === "1mo" ? 31 :
      range === "3mo" ? 93 :
      range === "6mo" ? 186 :
      range === "1y" ? 366 : 1_826
    ) * 86_400_000).toISOString().slice(0, 10);
    const fallback = await fetchFugleTaiexHistoricalDailyBars(start, end);
    const fugleBars: YahooBar[] = fallback.map((bar) => ({
      ...bar,
      timestamp: taiwanMarketCloseDate(bar.date).getTime(),
      volume: null,
    }));
    const chosen = fugleBars.length > officialBars.length ? fugleBars : officialBars;
    const latest = chosen.at(-1);
    if (latest && chosen.length >= Math.min(minimumBars, 2)) {
      return {
        ticker: "^TWII",
        source: chosen === fugleBars ? "Fugle MarketData · TWSE IX0001 歷史日線" : "TWSE Open Data",
        range,
        asOf: taiwanMarketCloseDate(latest.date),
        bars: chosen,
      };
    }
  } catch (error) {
    logger.warn(
      { err: error, officialBars: officialBars.length },
      "Unable to retrieve TAIEX daily history from Fugle fallback",
    );
    officialError ??= error;
  }

  const latest = officialBars.at(-1);
  if (latest && officialBars.length >= 2) {
    return {
      ticker: "^TWII",
      source: "TWSE Open Data · 不完整",
      range,
      asOf: taiwanMarketCloseDate(latest.date),
      bars: officialBars,
    };
  }
  const detail = officialError instanceof Error ? `：${officialError.message}` : "";
  throw new MarketDataError(`沒有可用的大盤歷史資料${detail}`, 502);
}

export async function getYahooDailyBars(
  ticker: string,
  range: YahooChartRange = "1mo",
): Promise<YahooBar[]> {
  const normalizedTicker = ticker.trim().toUpperCase();
  if (!/^\^?[A-Z0-9.-]{1,16}$/.test(normalizedTicker)) {
    throw new Error("Yahoo Finance 代碼格式無效");
  }
  const cacheKey = `${normalizedTicker}:${range}`;
  const cached = yahooDailyBarCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (range !== "1y" && range !== "3y" && range !== "5y") {
    const annual = yahooDailyBarCache.get(`${normalizedTicker}:1y`);
    if (annual && annual.expiresAt > Date.now()) {
      const fullBars = await annual.promise;
      const days = range === "5d" ? 7 : HISTORY_RANGE_CALENDAR_DAYS[range];
      const latestDate = fullBars.at(-1)?.date;
      if (latestDate) {
        const cutoff = new Date(Date.parse(`${latestDate}T00:00:00Z`) - days * 86_400_000)
          .toISOString()
          .slice(0, 10);
        return fullBars.filter((bar) => bar.date >= cutoff);
      }
    }
  }

  const promise = (async () => {
    const payload = await withYahooRequestSlot(async () => {
      let response: Response | null = null;
      for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
        const url = new URL(
          `https://${host}/v8/finance/chart/${encodeURIComponent(normalizedTicker)}`,
        );
        url.searchParams.set("range", range);
        url.searchParams.set("interval", "1d");
        response = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8_000),
        });
        if (response.ok) break;
        if (response.status !== 429) {
          throw new Error(`Yahoo Finance HTTP ${response.status}`);
        }
        if (host === "query2.finance.yahoo.com") {
          yahooRateLimitedUntil = Date.now() + 60_000;
        }
      }
      if (!response?.ok) throw new Error(`Yahoo Finance HTTP ${response?.status ?? "unknown"}`);
      return await response.json() as {
      chart?: {
        error?: { description?: string } | null;
        result?: Array<{
          meta?: { symbol?: string };
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: Array<number | null>;
              high?: Array<number | null>;
              low?: Array<number | null>;
              close?: Array<number | null>;
              volume?: Array<number | null>;
            }>;
          };
        }> | null;
      };
      };
    });
    const result = payload.chart?.result?.[0];
    if (!result || result.meta?.symbol?.toUpperCase() !== normalizedTicker) {
      throw new Error(payload.chart?.error?.description ?? "Yahoo Finance 回傳代碼不符");
    }
    const quote = result.indicators?.quote?.[0];
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const bars: YahooBar[] = [];
    for (let index = 0; index < (result.timestamp?.length ?? 0); index += 1) {
      const timestamp = result.timestamp![index]!;
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(timestamp * 1_000));
      const open = quote?.open?.[index];
      const high = quote?.high?.[index];
      const low = quote?.low?.[index];
      const close = quote?.close?.[index];
      if (
        date >= today ||
        !Number.isFinite(open) || !Number.isFinite(high) ||
        !Number.isFinite(low) || !Number.isFinite(close) ||
        open! <= 0 || high! < Math.max(open!, close!) ||
        low! > Math.min(open!, close!) || low! <= 0
      ) continue;
      bars.push({
        date,
        timestamp: taiwanMarketCloseDate(date).getTime(),
        open: open!,
        high: high!,
        low: low!,
        close: close!,
        volume: typeof quote?.volume?.[index] === "number"
          ? quote.volume[index]!
          : null,
      });
    }
    if (bars.length < 2) throw new Error("Yahoo Finance 日線資料不足");
    return bars;
  })();

  const entry = { expiresAt: Date.now() + 60_000, promise };
  yahooDailyBarCache.set(cacheKey, entry);
  try {
    return await promise;
  } catch (error) {
    entry.expiresAt = Date.now() + 20_000;
    throw error;
  }
}

export async function getTaiexIntradayHistory(): Promise<MarketIntradayHistoryData> {
  if (taiexIntradayCache && taiexIntradayCache.expiresAt > Date.now()) {
    return taiexIntradayCache.promise;
  }

  const promise = (async (): Promise<MarketIntradayHistoryData> => {
    let intraday: Awaited<ReturnType<typeof fetchFugleTaiexIntradayCandles>>;
    let dailyHistory: Awaited<ReturnType<typeof getTaiexHistory>> | null = null;
    let sessionType: MarketIntradayHistoryData["sessionType"] = "live";
    try {
      intraday = await fetchFugleTaiexIntradayCandles();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Fugle 尚未提供加權指數一分鐘分時資料"
      ) {
        throw new MarketDataError(
          error instanceof Error
            ? error.message
            : "目前無法取得加權指數一分鐘分時資料",
          502,
        );
      }

      dailyHistory = await getTaiexHistory("1mo");
      const latestSessionDate = dailyHistory.bars.at(-1)?.date;
      if (!latestSessionDate) {
        throw new MarketDataError("沒有可用的官方加權指數交易日，無法回查歷史分時", 502);
      }
      try {
        intraday = await fetchFugleTaiexHistoricalIntradayCandles(latestSessionDate);
        sessionType = "historical";
      } catch (historicalError) {
        throw new MarketDataError(
          historicalError instanceof Error
            ? `即時分時尚無資料，且無法取得最近交易日歷史分時：${historicalError.message}`
            : "即時分時尚無資料，且無法取得最近交易日歷史分時",
          502,
        );
      }
    }

    dailyHistory ??= await getTaiexHistory("1mo");
    const previousClose =
      dailyHistory.bars
        .filter((bar) => bar.date < intraday.date)
        .at(-1)?.close ?? null;
    if (previousClose === null) {
      throw new MarketDataError(
        "缺少官方前一交易日收盤價，無法驗證加權指數分時",
        502,
      );
    }

    for (const bar of intraday.bars) {
      validateTaiexMoveFromOfficialClose(bar.open, previousClose);
      validateTaiexMoveFromOfficialClose(bar.high, previousClose);
      validateTaiexMoveFromOfficialClose(bar.low, previousClose);
      validateTaiexMoveFromOfficialClose(bar.close, previousClose);
    }

    const latest = intraday.bars.at(-1);
    if (!latest) {
      throw new MarketDataError("目前沒有可用的加權指數分時資料", 404);
    }
    return {
      ticker: "^TWII",
      date: intraday.date,
      timeframe: "1m",
      sessionType,
      source: sessionType === "historical"
        ? "Fugle MarketData · TWSE IX0001 官方歷史一分鐘 K 線"
        : "Fugle MarketData · TWSE IX0001 即時一分鐘 K 線",
      previousClose,
      asOf: latest.time,
      bars: intraday.bars,
    };
  })();

  taiexIntradayCache = {
    expiresAt: Date.now() + TAIEX_INTRADAY_CACHE_TTL_MS,
    promise,
  };
  try {
    return await promise;
  } catch (error) {
    if (taiexIntradayCache?.promise === promise) taiexIntradayCache = null;
    throw error;
  }
}

async function fetchFinMindStockHistory(
  code: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<ExchangeDay[]> {
  const token = process.env.FINMIND_API_TOKEN?.trim();
  if (!token) throw new Error("未設定 FinMind API token");
  const url = new URL("https://api.finmindtrade.com/api/v4/data");
  url.searchParams.set("dataset", "TaiwanStockPrice");
  url.searchParams.set("data_id", code);
  url.searchParams.set("start_date", from);
  url.searchParams.set("end_date", to);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await finMindHttpError(response, "FinMind 歷史日線回應");
  const payload = await response.json() as {
    status?: number;
    msg?: string;
    data?: Array<Record<string, unknown>>;
  };
  if (payload.status !== 200 || !Array.isArray(payload.data)) {
    throw new Error(`FinMind 歷史日線回傳格式錯誤${payload.msg ? `：${payload.msg}` : ""}`);
  }
  const parseNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string"
        ? exchangeNumber(value)
        : null;
  const bars = payload.data.flatMap((row): ExchangeDay[] => {
    const date = typeof row.date === "string" ? row.date : "";
    const open = parseNumber(row.open);
    const high = parseNumber(row.max);
    const low = parseNumber(row.min);
    const close = parseNumber(row.close);
    const volume = parseNumber(row.Trading_Volume);
    if (
      row.stock_id !== code ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to ||
      open === null || high === null || low === null || close === null ||
      open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
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
  if (!bars.length) throw new Error("FinMind 歷史日線沒有符合股票代號與日期的有效資料");
  return bars;
}

async function fetchFinMindMarketWideRecentStockHistory(
  asOfDate: string,
): Promise<MarketWideRecentStockHistory> {
  const token = process.env.FINMIND_API_TOKEN?.trim();
  if (!token) throw new Error("全市場批次日線需要已設定的 FinMind API token");
  const startDate = new Date(Date.parse(`${asOfDate}T00:00:00Z`) - 75 * 86_400_000)
    .toISOString().slice(0, 10);
  const url = new URL("https://api.finmindtrade.com/api/v4/data");
  url.searchParams.set("dataset", "TaiwanStockPrice");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", asOfDate);
  url.searchParams.set("streaming_all_data", "true");
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await finMindHttpError(response, "FinMind 全市場日線回應");
  const payload = await response.json() as {
    status?: number;
    msg?: string;
    data?: Array<Record<string, unknown>>;
  };
  if (payload.status !== 200 || !Array.isArray(payload.data)) {
    throw new Error(`FinMind 全市場日線回傳格式錯誤${payload.msg ? `：${payload.msg}` : ""}`);
  }
  const parseNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" ? exchangeNumber(value) : null;
  const grouped = new Map<string, ExchangeDay[]>();
  for (const row of payload.data) {
    const code = typeof row.stock_id === "string" ? row.stock_id.trim().toUpperCase() : "";
    const date = typeof row.date === "string" ? row.date : "";
    const open = parseNumber(row.open);
    const high = parseNumber(row.max);
    const low = parseNumber(row.min);
    const close = parseNumber(row.close);
    const volume = parseNumber(row.Trading_Volume);
    const tradedValue = parseNumber(row.Trading_money);
    if (
      !/^[A-Z0-9]{4,6}$/.test(code) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDate || date > asOfDate ||
      open === null || high === null || low === null || close === null ||
      open <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || low <= 0
    ) continue;
    const bars = grouped.get(code) ?? [];
    bars.push({
      date,
      timestamp: Date.parse(`${date}T05:30:00.000Z`),
      open,
      high,
      low,
      close,
      volume,
      tradedValue,
    });
    grouped.set(code, bars);
  }
  for (const bars of grouped.values()) bars.sort((left, right) => left.date.localeCompare(right.date));
  if (grouped.size < 500) {
    throw new Error(`FinMind 全市場日線覆蓋不足：僅有 ${grouped.size} 檔股票資料`);
  }
  return { source: "FinMind TaiwanStockPrice · 全市場批次日線", barsBySymbol: grouped };
}

export async function getMarketWideRecentStockHistory(
  asOfDate: string,
  universe: Array<Pick<OfficialDailyClose, "symbol" | "exchange">> = [],
  onFallbackProgress?: (completed: number, total: number) => void,
): Promise<MarketWideRecentStockHistory> {
  try {
    return await fetchFinMindMarketWideRecentStockHistory(asOfDate);
  } catch (bulkError) {
    if (!universe.length) throw bulkError;
    logger.warn(
      { err: bulkError, asOfDate, universeSize: universe.length },
      "FinMind bulk history unavailable; falling back to validated per-stock history",
    );
    const failures: string[] = [];
    let completed = 0;
    const histories = await mapWithConcurrency(universe, 6, async ({ symbol, exchange }) => {
      const ticker = `${symbol}.${exchange === "twse" ? "TW" : "TWO"}`;
      try {
        const fetchRecentBars = async (range: "1mo" | "3mo") => {
          const history = await getStockHistory(ticker, range, {
            expectedAsOf: asOfDate,
            skipFinMindFallback: true,
          });
          const bars = history.bars
            .filter((bar) => bar.date <= asOfDate)
            .map((bar): ExchangeDay => ({
              date: bar.date,
              timestamp: Date.parse(`${bar.date}T05:30:00.000Z`),
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
            }))
            .sort((left, right) => left.date.localeCompare(right.date));
          return { history, bars };
        };
        let recent = await fetchRecentBars("1mo");
        if (!hasAlignedRecentHistoryBars(recent.bars, asOfDate)) {
          recent = await fetchRecentBars("3mo");
        }
        if (!hasAlignedRecentHistoryBars(recent.bars, asOfDate)) {
          failures.push(symbol);
          return null;
        }
        return { symbol, source: recent.history.source, bars: recent.bars };
      } catch {
        failures.push(symbol);
        return null;
      } finally {
        completed += 1;
        onFallbackProgress?.(completed, universe.length);
      }
    });
    const barsBySymbol = new Map<string, ExchangeDay[]>();
    const sourceCounts = new Map<string, number>();
    for (const result of histories) {
      if (!result) continue;
      barsBySymbol.set(result.symbol, result.bars);
      sourceCounts.set(result.source, (sourceCounts.get(result.source) ?? 0) + 1);
    }
    logger.info(
      {
        asOfDate,
        requestedSymbols: universe.length,
        usableSymbols: barsBySymbol.size,
        failedSymbols: failures.length,
        failedSymbolExamples: failures.slice(0, 10),
        sourceCounts: Object.fromEntries(sourceCounts),
      },
      "Per-stock recent history fallback completed",
    );
    if (!barsBySymbol.size) {
      throw new MarketDataError(
        `FinMind 全市場日線無法使用，逐股官方／Fugle 備援亦未取得 ${asOfDate} 對齊且至少 21 根日線`,
        502,
      );
    }
    return {
      source: `逐股歷史日線備援（${barsBySymbol.size}/${universe.length} 檔符合日期與覆蓋檢查）`,
      barsBySymbol,
    };
  }
}

export async function getStockHistory(
  symbol: string,
  range: SupportedRange,
  { expectedAsOf, marketWideScan = false, skipFinMindFallback = false, signal }: {
    expectedAsOf?: string;
    marketWideScan?: boolean;
    skipFinMindFallback?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<StockHistoryData> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const normalized = symbol.trim().toUpperCase();
  const tpexOnly = normalized.endsWith(".TWO");
  const twseOnly = normalized.endsWith(".TW");
  const stockCode = normalized.replace(/\.(TW|TWO)$/, "");
  if (!/^[A-Z0-9]{4,6}$/.test(stockCode)) {
    throw new MarketDataError("請輸入台灣上市或上櫃股票代號", 400);
  }

  const stockIndices = { volume: 1, open: 3, high: 4, low: 5, close: 6 };
  if (marketWideScan && !expectedAsOf) {
    throw new Error("Market-wide scan history requires an official as-of date");
  }
  const historyWindow = marketWideScan
    ? getMarketWideScanHistoryWindow(expectedAsOf!)
    : expectedAsOf
      ? {
          startDate: new Date(
            Date.parse(`${expectedAsOf}T00:00:00Z`) -
              HISTORY_RANGE_CALENDAR_DAYS[range] * 86_400_000,
          ).toISOString().slice(0, 10),
          endDate: expectedAsOf,
          monthCount: exchangeMonths(range, expectedAsOf).length,
          minimumBars: MIN_HISTORY_BARS_BY_RANGE[range],
        }
      : undefined;
  const loadTwse = (selectedRange: SupportedRange = range) =>
    getExchangeHistory(
      selectedRange,
      (month) => fetchTwseStockMonth(stockCode, month, signal),
      stockIndices,
      selectedRange === range ? historyWindow : undefined,
    );
  const loadTpex = (selectedRange: SupportedRange = range) =>
    getExchangeHistory(
      selectedRange,
      (month) => fetchTpexStockMonth(stockCode, month, signal),
      stockIndices,
      selectedRange === range ? historyWindow : undefined,
    );

  let exchangeDays: ExchangeDay[] = [];
  let isTpex = tpexOnly;
  let actualRange = range;
  let officialError: unknown = null;
  let historyFromFugle = false;
  let historyFromFinMind = false;
  const minimumHistoryBars = historyWindow?.minimumBars ?? MIN_HISTORY_BARS_BY_RANGE[range];
  const historyNeedsSupplement = () =>
    exchangeDays.length < minimumHistoryBars ||
    (expectedAsOf !== undefined && exchangeDays.at(-1)?.date !== expectedAsOf);
  try {
    if (tpexOnly) {
      exchangeDays = await loadTpex();
    } else {
      exchangeDays = await loadTwse();
      if (exchangeDays.length === 0 && !twseOnly) {
        exchangeDays = await loadTpex();
        isTpex = true;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    officialError = error;
  }

  if (range === "5y" && exchangeDays.length === 0) {
    try {
      if (tpexOnly) {
        exchangeDays = await loadTpex("1y");
      } else {
        exchangeDays = await loadTwse("1y");
        if (exchangeDays.length === 0 && !twseOnly) {
          exchangeDays = await loadTpex("1y");
          isTpex = true;
        }
      }
      if (exchangeDays.length > 0) actualRange = "1y";
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      officialError = error;
    }
  }

  if (
    historyNeedsSupplement() &&
    !skipFinMindFallback &&
    process.env.FINMIND_API_TOKEN?.trim()
  ) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const today = `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
      const end = historyWindow?.endDate ?? today;
      const start = historyWindow?.startDate ??
        new Date(Date.parse(`${today}T00:00:00Z`) - HISTORY_RANGE_CALENDAR_DAYS[range] * 86_400_000)
          .toISOString().slice(0, 10);
      const exchange = tpexOnly ? "TPEx" : twseOnly ? "TWSE" : exchangeDays.length
        ? isTpex ? "TPEx" : "TWSE"
        : null;
      if (!exchange) throw new Error("股票市場別未核實，拒絕使用 FinMind 歷史備援");
      const backup = await fetchFinMindStockHistory(stockCode, start, end, signal);
      const backupMatchesExpectedDate = expectedAsOf === undefined ||
        backup.at(-1)?.date === expectedAsOf;
      const currentMatchesExpectedDate = expectedAsOf === undefined ||
        exchangeDays.at(-1)?.date === expectedAsOf;
      if (
        backupMatchesExpectedDate &&
        (backup.length > exchangeDays.length || !currentMatchesExpectedDate)
      ) {
        exchangeDays = backup;
        isTpex = exchange === "TPEx";
        actualRange = range;
        historyFromFinMind = true;
      }
    } catch (backupError) {
      if (signal?.aborted) throw signal.reason ?? backupError;
      logger.warn(
        { err: backupError, symbol: stockCode },
        "Unable to retrieve requested history range from FinMind fallback",
      );
    }
  }

  // If the official source returned less than the requested history window,
  // try that same span from Fugle rather than silently overstating coverage.
  if (historyNeedsSupplement()) {
    try {
      const taiwanDateParts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const today = `${taiwanDateParts.find((part) => part.type === "year")?.value}-${taiwanDateParts.find((part) => part.type === "month")?.value}-${taiwanDateParts.find((part) => part.type === "day")?.value}`;
      const maxDays = HISTORY_RANGE_CALENDAR_DAYS[range];
      const endDate = historyWindow?.endDate ?? today;
      const end = new Date(`${endDate}T00:00:00Z`);
      const start = historyWindow?.startDate ??
        new Date(end.getTime() - maxDays * 86_400_000).toISOString().slice(0, 10);
      const backup = await fetchFugleStockHistoricalDailyRange(stockCode, start, endDate, signal);
      if (
        (twseOnly && backup.exchange !== "TWSE") ||
        (tpexOnly && backup.exchange !== "TPEx")
      ) throw new Error(`Fugle 回傳交易所 ${backup.exchange}，與要求的股票市場不符`);
      const backupMatchesExpectedDate = expectedAsOf === undefined ||
        backup.bars.at(-1)?.date === expectedAsOf;
      const currentMatchesExpectedDate = expectedAsOf === undefined ||
        exchangeDays.at(-1)?.date === expectedAsOf;
      if (
        backupMatchesExpectedDate &&
        (backup.bars.length > exchangeDays.length || !currentMatchesExpectedDate)
      ) {
        exchangeDays = backup.bars;
        isTpex = backup.exchange === "TPEx";
        actualRange = range;
        historyFromFugle = true;
        historyFromFinMind = false;
        officialError = null;
      }
    } catch (backupError) {
      if (signal?.aborted) throw signal.reason ?? backupError;
      if (exchangeDays.length === 0) {
        const officialMessage = officialError instanceof Error
          ? officialError.message
          : "官方日線無可用資料";
        const backupMessage = backupError instanceof Error
          ? backupError.message
          : "Fugle 歷史日線備援失敗";
        throw new MarketDataError(
          `${officialMessage}；替代歷史日線來源也無法使用：${backupMessage}`,
          502,
        );
      }
      logger.warn(
        { err: backupError, symbol: stockCode, officialBars: exchangeDays.length },
        "Unable to extend short official history to the requested range",
      );
    }
  }

  if (exchangeDays.length === 0) {
    try {
      const taiwanDateParts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const today = `${taiwanDateParts.find((part) => part.type === "year")?.value}-${taiwanDateParts.find((part) => part.type === "month")?.value}-${taiwanDateParts.find((part) => part.type === "day")?.value}`;
      const maxDays = range === "1y" ? 366 : range === "6mo" ? 186 : range === "3mo" ? 93 : 31;
      const end = new Date(`${today}T00:00:00Z`);
      const start = new Date(end.getTime() - maxDays * 86_400_000).toISOString().slice(0, 10);
      const backup = await fetchFugleStockHistoricalDailyRange(stockCode, start, today, signal);
      if (
        (twseOnly && backup.exchange !== "TWSE") ||
        (tpexOnly && backup.exchange !== "TPEx")
      ) throw new Error(`Fugle 回傳交易所 ${backup.exchange}，與要求的股票市場不符`);
      const latest = backup.bars.at(-1)!;
      return {
        symbol: stockCode,
        ticker: `${stockCode}.${backup.exchange === "TPEx" ? "TWO" : "TW"}`,
        source: "Fugle MarketData 歷史日Ｋ備援（交易所公開日線暫不可用）",
        currency: "TWD",
        range: actualRange,
        asOf: taiwanMarketCloseDate(latest.date),
        bars: backup.bars,
      };
    } catch (backupError) {
      if (signal?.aborted) throw signal.reason ?? backupError;
      const officialMessage = officialError instanceof Error
        ? officialError.message
        : "官方日線無可用資料";
      const backupMessage = backupError instanceof Error
        ? backupError.message
        : "Fugle 歷史日線備援失敗";
      throw new MarketDataError(
        `${officialMessage}；替代歷史日線來源也無法使用：${backupMessage}`,
        502,
      );
    }
  }

  const bars: YahooBar[] = exchangeDays.map((bar) => ({
    ...bar,
    // TPEx reports daily volume in thousand shares; expose both exchanges in
    // shares so the client can consistently divide by 1,000 to show lots.
    // Fugle already reports shares, so never scale those fallback bars again.
    volume:
      isTpex && !historyFromFugle && !historyFromFinMind && bar.volume !== null ? bar.volume * 1_000 : bar.volume,
  }));
  const latest = bars.at(-1)!;
  return {
    symbol: stockCode,
    ticker: `${stockCode}.${isTpex ? "TWO" : "TW"}`,
    source: historyFromFugle
      ? "Fugle MarketData 歷史日線備援"
      : historyFromFinMind
      ? `FinMind TaiwanStockPrice（${isTpex ? "TPEx" : "TWSE"} 市場別由官方行情核實）`
      : isTpex ? "TPEx Open Data" : "TWSE Open Data",
    currency: "TWD",
    range: actualRange,
    asOf: taiwanMarketCloseDate(latest.date),
    bars,
  };
}

function movingAverage(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const recent = values.slice(-period);
  return recent.reduce((sum, value) => sum + value, 0) / period;
}

export async function getTaiexSummary(): Promise<MarketSummaryData> {
  const history = await getTaiexHistory("1y");
  const bars = history.bars;
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  if (!latest || !previous) {
    throw new MarketDataError("大盤歷史資料不足，無法計算摘要", 502);
  }

  const closes = bars.map((bar) => bar.close);
  const ma20 = movingAverage(closes, 20);
  const ma60 = movingAverage(closes, 60);
  const ma120 = movingAverage(closes, 120);
  const recentBars = bars.slice(-20);
  const support20 = recentBars.length ? Math.min(...recentBars.map((bar) => bar.low)) : null;
  const resistance20 = recentBars.length ? Math.max(...recentBars.map((bar) => bar.high)) : null;
  let quote: MarketQuoteData | null = null;
  try {
    quote = await getTaiexQuote();
  } catch {
    quote = null;
  }
  const currentPrice = quote?.price ?? latest.close;
  const change = quote?.change ?? latest.close - previous.close;
  const changePercent =
    quote?.changePercent ??
    (previous.close === 0 ? 0 : (change / previous.close) * 100);
  const close20 = closes.length >= 21 ? closes[closes.length - 21]! : null;
  const close60 = closes.length >= 61 ? closes[closes.length - 61]! : null;
  const return20 =
    close20 === null || close20 === 0
      ? null
      : ((latest.close - close20) / close20) * 100;
  const return60 =
    close60 === null || close60 === 0
      ? null
      : ((latest.close - close60) / close60) * 100;

  const factors: MarketSummaryData["factors"] = [
    {
      key: "price_above_ma20",
      label: "大盤高於近 20 日平均價",
      passed: ma20 === null ? null : currentPrice > ma20,
      observedValue: ma20 === null ? null : currentPrice - ma20,
      threshold: 0,
    },
    {
      key: "ma20_above_ma60",
      label: "近 20 日平均價高於近 60 日平均價",
      passed: ma20 === null || ma60 === null ? null : ma20 > ma60,
      observedValue: ma20 === null || ma60 === null ? null : ma20 - ma60,
      threshold: 0,
    },
    {
      key: "ma60_above_ma120",
      label: "近 60 日平均價高於近 120 日平均價",
      passed: ma60 === null || ma120 === null ? null : ma60 > ma120,
      observedValue: ma60 === null || ma120 === null ? null : ma60 - ma120,
      threshold: 0,
    },
    {
      key: "return_20d_positive",
      label: "大盤近 20 日上漲",
      passed: return20 === null ? null : return20 > 0,
      observedValue: return20,
      threshold: 0,
    },
    {
      key: "return_60d_positive",
      label: "大盤近 60 日上漲",
      passed: return60 === null ? null : return60 > 0,
      observedValue: return60,
      threshold: 0,
    },
    {
      key: "daily_change_above_minus_one",
      label: "大盤當日跌幅未超過 1%",
      passed: changePercent > -1,
      observedValue: changePercent,
      threshold: -1,
    },
  ];

  const evaluable = factors.filter(
    (factor): factor is typeof factor & { passed: boolean } =>
      factor.passed !== null,
  );
  const enoughHistory =
    closes.length >= 120 && evaluable.length === factors.length;
  const score = enoughHistory
    ? evaluable.filter((factor) => factor.passed).length
    : null;

  return {
    ticker: "^TWII",
    source: quote?.source ?? history.source,
    asOf: quote?.asOf ?? history.asOf,
    currentPrice,
    change,
    changePercent,
    dailyCloseDate: latest.date,
    dailyCloseSource: history.source,
    dailyClosePrice: latest.close,
    dailyCloseChange: latest.close - previous.close,
    dailyCloseChangePercent:
      previous.close === 0
        ? 0
        : ((latest.close - previous.close) / previous.close) * 100,
    ma20,
    ma60,
    ma120,
    support20,
    resistance20,
    score,
    status:
      score === null
        ? "insufficient"
        : score >= 5
          ? "bullish"
          : score >= 3
            ? "neutral"
            : "bearish",
    factors,
  };
}