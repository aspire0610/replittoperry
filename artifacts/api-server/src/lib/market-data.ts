import {
  fetchFugleFuturesQuote,
  fetchFugleStockQuote,
  fetchFugleTaiexIndexTick,
  fetchFugleTaiexIntradayCandles,
  toFugleTaiexMarketQuote,
} from "./fugle-market-data.js";
import {
  fetchTaifexDailyFuturesQuote,
  fetchTaifexFuturesQuotes,
} from "./taifex-market-data.js";

const STOCK_QUOTE_MAX_AGE_MS = 90_000;

type SupportedRange = "1mo" | "3mo" | "6mo" | "1y";

type YahooBar = {
  date: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

type TwseQuoteRow = {
  c?: string;
  n?: string;
  z?: string;
  y?: string;
  d?: string;
  t?: string;
  tlong?: string;
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
};

type TpexDailyCloseRow = {
  Date?: string;
  SecuritiesCompanyCode?: string;
  CompanyName?: string;
  Close?: string;
  Change?: string;
};

type ExchangeDay = {
  date: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
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
  close: number;
  change: number | null;
};

export type OfficialDailyCloseData = {
  asOf: string;
  quotes: OfficialDailyClose[];
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
const usMarketIndicatorConfigs = [
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
] as const;
type UsMarketIndicatorConfig = (typeof usMarketIndicatorConfigs)[number];
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

function numericText(value: string | undefined): number | null {
  if (!value || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchExchangeJson<T>(
  url: URL,
  cacheTtlMs = 90_000,
  sourceName = "臺灣證券交易所",
): Promise<T> {
  const key = url.toString();
  const cached = exchangeResponseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise as Promise<T>;
  }

  const promise = (async (): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
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
  const [twseRows, tpexRows] = await Promise.all([
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
  if (!Array.isArray(twseRows) || !twseRows.length || !Array.isArray(tpexRows) || !tpexRows.length) {
    throw new MarketDataError("交易所官方收盤資料目前不完整", 502);
  }

  const twseDate = rocCompactDateToIso(twseRows[0]?.Date);
  const tpexDate = rocCompactDateToIso(tpexRows[0]?.Date);
  if (!twseDate || !tpexDate || twseDate !== tpexDate) {
    throw new MarketDataError("上市與上櫃官方收盤資料日期不一致", 502);
  }

  const quotes: OfficialDailyClose[] = [];
  for (const row of twseRows) {
    const symbol = row.Code?.trim().toUpperCase();
    const name = row.Name?.trim();
    const close = exchangeNumber(row.ClosingPrice);
    if (!symbol || !name || close === null || close <= 0) continue;
    quotes.push({
      symbol,
      name,
      close,
      change: exchangeNumber(row.Change),
    });
  }
  for (const row of tpexRows) {
    const symbol = row.SecuritiesCompanyCode?.trim().toUpperCase();
    const name = row.CompanyName?.trim();
    const close = exchangeNumber(row.Close);
    if (!symbol || !name || close === null || close <= 0) continue;
    quotes.push({
      symbol,
      name,
      close,
      change: exchangeNumber(row.Change),
    });
  }
  if (!quotes.length) {
    throw new MarketDataError("官方收盤資料沒有有效的股票報價", 502);
  }
  return { asOf: twseDate, quotes };
}

function exchangeMonths(range: SupportedRange): string[] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const count = range === "1mo" ? 2 : range === "3mo" ? 4 : range === "6mo" ? 7 : 13;

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
  const days = range === "1mo" ? 31 : range === "3mo" ? 93 : range === "6mo" ? 186 : 366;
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function keepRange(days: ExchangeDay[], range: SupportedRange): ExchangeDay[] {
  const startDate = rangeStartDate(range);
  return days.filter((bar) => bar.date >= startDate);
}

async function fetchTwseStockMonth(
  stockCode: string,
  month: string,
): Promise<string[][]> {
  const url = new URL("https://www.twse.com.tw/exchangeReport/STOCK_DAY");
  url.searchParams.set("response", "json");
  url.searchParams.set("date", month);
  url.searchParams.set("stockNo", stockCode);
  const response = await fetchExchangeJson<ExchangeDailyResponse>(url);
  return response.stat === "OK" ? response.data ?? [] : [];
}

async function fetchTpexStockMonth(
  stockCode: string,
  month: string,
): Promise<string[][]> {
  const url = new URL(
    "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock",
  );
  url.searchParams.set("code", stockCode);
  url.searchParams.set("date", `${month.slice(0, 4)}/${month.slice(4, 6)}/01`);
  const response = await fetchExchangeJson<ExchangeDailyResponse>(url);
  return response.tables?.[0]?.data ?? [];
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
): Promise<ExchangeDay[]> {
  const months = exchangeMonths(range);
  const monthlyRows = await mapWithConcurrency(months, 3, fetchMonth);
  const uniqueDays = new Map<string, ExchangeDay>();
  for (const row of monthlyRows.flat()) {
    const bar = exchangeBar(row, indices);
    if (bar) uniqueDays.set(bar.date, bar);
  }
  return keepRange(
    [...uniqueDays.values()].sort((left, right) => left.date.localeCompare(right.date)),
    range,
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

async function getFuturesQuotes(): Promise<MarketQuoteData[]> {
  const failures: string[] = [];
  let quotes: MarketQuoteData[] | null = null;

  try {
    quotes = await fetchTaifexFuturesQuotes();
  } catch (taifexError) {
    failures.push(
      taifexError instanceof Error
        ? `TAIFEX MIS：${taifexError.message}`
        : "TAIFEX MIS 即時報價失敗",
    );
  }

  if (process.env.FUGLE_API_KEY?.trim() && (!quotes || quotes.some((quote) => !quote.available))) {
    try {
      const fallbackQuote = await fetchFugleFuturesQuote();
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
      ? `${failures.join("；")}；尚未取得官方日行情收盤資料。`
      : "即時期貨來源目前無可用報價，尚未取得官方日行情收盤資料。";
    quotes = [
      unavailableFuturesQuote("day", error),
      unavailableFuturesQuote("night", error),
    ];
  }

  for (const session of ["day", "night"] as const) {
    const index = session === "day" ? 0 : 1;
    const quote = quotes[index];
    if (!quote || quote.available) continue;
    try {
      const dailyQuote = await fetchTaifexDailyFuturesQuote(session);
      if (dailyQuote) {
        quotes[index] = dailyQuote;
      } else {
        quotes[index] = {
          ...quote,
          error: `${quote.error ?? "沒有可用的即時成交快照"}；TAIFEX 官方日行情尚無可用的${session === "day" ? "日盤" : "夜盤"}最近收盤價。`,
        };
      }
    } catch (dailyError) {
      const dailyMessage =
        dailyError instanceof Error
          ? dailyError.message
          : "TAIFEX 官方日行情查詢失敗";
      quotes[index] = {
        ...quote,
        error: `${quote.error ?? "沒有可用的即時成交快照"}；${dailyMessage}`,
      };
    }
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
  const exchangeDays = await getExchangeHistory(
    range,
    fetchTwseTaiexMonth,
    { volume: null, open: 1, high: 2, low: 3, close: 4 },
  );
  const bars: YahooBar[] = exchangeDays.map((day) => ({
    ...day,
    volume: null,
  }));
  const latest = bars.at(-1);
  if (!latest) throw new MarketDataError("沒有可用的大盤歷史資料", 404);

  return {
    ticker: "^TWII",
    source: "TWSE Open Data",
    range,
    asOf: taiwanMarketCloseDate(latest.date),
    bars,
  };
}

export async function getTaiexIntradayHistory(): Promise<MarketIntradayHistoryData> {
  if (taiexIntradayCache && taiexIntradayCache.expiresAt > Date.now()) {
    return taiexIntradayCache.promise;
  }

  const promise = (async (): Promise<MarketIntradayHistoryData> => {
    let intraday: Awaited<ReturnType<typeof fetchFugleTaiexIntradayCandles>>;
    try {
      intraday = await fetchFugleTaiexIntradayCandles();
    } catch (error) {
      throw new MarketDataError(
        error instanceof Error
          ? error.message
          : "目前無法取得加權指數一分鐘分時資料",
        502,
      );
    }

    const dailyHistory = await getTaiexHistory("1mo");
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
      source: "Fugle MarketData · TWSE IX0001 一分鐘 K 線",
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

export async function getStockHistory(
  symbol: string,
  range: SupportedRange,
): Promise<StockHistoryData> {
  const normalized = symbol.trim().toUpperCase();
  const tpexOnly = normalized.endsWith(".TWO");
  const twseOnly = normalized.endsWith(".TW");
  const stockCode = normalized.replace(/\.(TW|TWO)$/, "");
  if (!/^[A-Z0-9]{4,6}$/.test(stockCode)) {
    throw new MarketDataError("請輸入台灣上市或上櫃股票代號", 400);
  }

  const stockIndices = { volume: 1, open: 3, high: 4, low: 5, close: 6 };
  const loadTwse = () =>
    getExchangeHistory(
      range,
      (month) => fetchTwseStockMonth(stockCode, month),
      stockIndices,
    );
  const loadTpex = () =>
    getExchangeHistory(
      range,
      (month) => fetchTpexStockMonth(stockCode, month),
      stockIndices,
    );

  let exchangeDays: ExchangeDay[];
  let isTpex = tpexOnly;
  if (tpexOnly) {
    exchangeDays = await loadTpex();
  } else {
    exchangeDays = await loadTwse();
    if (exchangeDays.length === 0 && !twseOnly) {
      exchangeDays = await loadTpex();
      isTpex = true;
    }
  }

  if (exchangeDays.length === 0) {
    throw new MarketDataError(
      "此代號目前沒有可用的上市或上櫃日線資料；可能尚未掛牌、已下市／下櫃，或官方來源暫無資料。",
      404,
    );
  }

  const bars: YahooBar[] = exchangeDays.map((bar) => ({
    ...bar,
    // TPEx reports daily volume in thousand shares; expose both exchanges in
    // shares so the client can consistently divide by 1,000 to show lots.
    volume:
      isTpex && bar.volume !== null ? bar.volume * 1_000 : bar.volume,
  }));
  const latest = bars.at(-1)!;
  return {
    symbol: stockCode,
    ticker: `${stockCode}.${isTpex ? "TWO" : "TW"}`,
    source: isTpex ? "TPEx Open Data" : "TWSE Open Data",
    currency: "TWD",
    range,
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