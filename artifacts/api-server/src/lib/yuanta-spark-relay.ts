import { createHmac, randomUUID } from "node:crypto";

export type YuantaSparkMarket =
  | "securities"
  | "otc"
  | "emerging"
  | "twse_odd"
  | "otc_odd"
  | "futures";

export type YuantaSparkQuote = {
  symbol: string;
  name: string | null;
  price: number;
  previousClose: number | null;
  asOf: Date | null;
  volume: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  stockType2: number | null;
};

type RelayPayload = {
  quotes?: Array<{
    symbol?: unknown;
    name?: unknown;
    price?: unknown;
    previousClose?: unknown;
    asOf?: unknown;
    volume?: unknown;
    openPrice?: unknown;
    highPrice?: unknown;
    lowPrice?: unknown;
    stockType2?: unknown;
  }>;
};

type RelayKLinePayload = {
  bars?: Array<{
    time?: unknown;
    open?: unknown;
    high?: unknown;
    low?: unknown;
    close?: unknown;
    volume?: unknown;
  }>;
};

type RelayTickBarsPayload = {
  tickCount?: unknown;
  bars?: Array<{
    time?: unknown;
    open?: unknown;
    high?: unknown;
    low?: unknown;
    close?: unknown;
    volume?: unknown;
  }>;
};

export type YuantaSparkBar = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

const RELAY_TIMEOUT_MS = 8_000;
const KLINE_CACHE_MS = 15_000;
const TICK_BARS_CACHE_MS = 55_000;
const klineCache = new Map<
  string,
  { expiresAt: number; promise: Promise<YuantaSparkBar[]> }
>();
const futuresTickBarsCache = new Map<
  string,
  { expiresAt: number; promise: Promise<YuantaSparkBar[]> }
>();

export function isYuantaSparkRelayConfigured(): boolean {
  return Boolean(
    process.env.YUANTA_SPARK_RELAY_URL?.trim() &&
      process.env.YUANTA_SPARK_RELAY_SECRET?.trim(),
  );
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function fetchYuantaSparkQuotes(
  market: YuantaSparkMarket,
  symbols: string[],
): Promise<YuantaSparkQuote[]> {
  const baseUrl = process.env.YUANTA_SPARK_RELAY_URL?.trim();
  const secret = process.env.YUANTA_SPARK_RELAY_SECRET?.trim();
  if (!baseUrl || !secret) {
    throw new Error("Yuanta SPARK relay 尚未設定。");
  }
  if (symbols.length === 0 || symbols.length > 20) {
    throw new Error("Yuanta SPARK relay 商品代碼數量無效。");
  }

  const url = new URL("/v1/quotes", baseUrl);
  url.searchParams.set("market", market);
  url.searchParams.set("symbols", [...new Set(symbols)].sort().join(","));
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Yuanta SPARK relay 必須使用 HTTPS。");
  }

  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const canonical = `GET\n${url.pathname}${url.search}\n${timestamp}\n${nonce}`;
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Yuanta-Timestamp": timestamp,
      "X-Yuanta-Nonce": nonce,
      "X-Yuanta-Signature": signature,
    },
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Yuanta SPARK relay 回應 HTTP ${response.status}`);
  }

  const payload = await response.json() as RelayPayload;
  if (!Array.isArray(payload.quotes)) {
    throw new Error("Yuanta SPARK relay 回傳格式無效。");
  }
  return payload.quotes.flatMap((row): YuantaSparkQuote[] => {
    const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    const price = typeof row.price === "number" ? row.price : Number.NaN;
    const previousClose =
      typeof row.previousClose === "number" && Number.isFinite(row.previousClose)
        ? row.previousClose
        : null;
    if (!symbol || !Number.isFinite(price) || price <= 0) return [];
    return [{
      symbol,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
      price,
      previousClose,
      asOf: parseDate(row.asOf),
      volume: parseFiniteNumber(row.volume),
      openPrice: parseFiniteNumber(row.openPrice),
      highPrice: parseFiniteNumber(row.highPrice),
      lowPrice: parseFiniteNumber(row.lowPrice),
      stockType2: parseFiniteNumber(row.stockType2),
    }];
  });
}

async function requestYuantaSparkKLine(
  market: "securities" | "otc",
  symbol: string,
  date: string,
): Promise<YuantaSparkBar[]> {
  const baseUrl = process.env.YUANTA_SPARK_RELAY_URL?.trim();
  const secret = process.env.YUANTA_SPARK_RELAY_SECRET?.trim();
  if (!baseUrl || !secret) throw new Error("Yuanta SPARK relay 尚未設定。");
  if (!/^[A-Z0-9]{1,12}$/i.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Yuanta SPARK K 線查詢參數無效。");
  }

  const url = new URL("/v1/kline", baseUrl);
  url.searchParams.set("market", market);
  url.searchParams.set("symbol", symbol.toUpperCase());
  url.searchParams.set("date", date);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Yuanta SPARK relay 必須使用 HTTPS。");
  }

  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const canonical = `GET\n${url.pathname}${url.search}\n${timestamp}\n${nonce}`;
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Yuanta-Timestamp": timestamp,
      "X-Yuanta-Nonce": nonce,
      "X-Yuanta-Signature": signature,
    },
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Yuanta SPARK K 線回應 HTTP ${response.status}`);

  const payload = await response.json() as RelayKLinePayload;
  if (!Array.isArray(payload.bars)) throw new Error("Yuanta SPARK K 線回傳格式無效。");
  return payload.bars.flatMap((bar): YuantaSparkBar[] => {
    const time = parseDate(bar.time);
    const open = parseFiniteNumber(bar.open);
    const high = parseFiniteNumber(bar.high);
    const low = parseFiniteNumber(bar.low);
    const close = parseFiniteNumber(bar.close);
    if (
      !time || open === null || high === null || low === null || close === null ||
      Math.min(open, high, low, close) <= 0
    ) return [];
    return [{
      time,
      open,
      high,
      low,
      close,
      volume: parseFiniteNumber(bar.volume),
    }];
  }).sort((left, right) => left.time.getTime() - right.time.getTime());
}

export function fetchYuantaSparkKLine(
  market: "securities" | "otc",
  symbol: string,
  date: string,
): Promise<YuantaSparkBar[]> {
  const key = `${market}:${symbol.toUpperCase()}:${date}`;
  const cached = klineCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = requestYuantaSparkKLine(market, symbol, date);
  const entry = { expiresAt: Date.now() + KLINE_CACHE_MS, promise };
  klineCache.set(key, entry);
  void promise.catch(() => {
    if (klineCache.get(key) === entry) klineCache.delete(key);
  });
  return promise;
}

async function requestYuantaSparkFuturesTickBars(
  symbol: string,
): Promise<YuantaSparkBar[]> {
  const baseUrl = process.env.YUANTA_SPARK_RELAY_URL?.trim();
  const secret = process.env.YUANTA_SPARK_RELAY_SECRET?.trim();
  if (!baseUrl || !secret) throw new Error("Yuanta SPARK relay 尚未設定。");
  if (!/^[A-Z0-9]{1,12}$/i.test(symbol)) {
    throw new Error("Yuanta SPARK 期貨逐筆查詢代碼無效。");
  }

  const url = new URL("/v1/ticks", baseUrl);
  url.searchParams.set("market", "futures");
  url.searchParams.set("symbol", symbol.toUpperCase());
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Yuanta SPARK relay 必須使用 HTTPS。");
  }

  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const canonical = `GET\n${url.pathname}${url.search}\n${timestamp}\n${nonce}`;
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Yuanta-Timestamp": timestamp,
      "X-Yuanta-Nonce": nonce,
      "X-Yuanta-Signature": signature,
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    throw new Error(`Yuanta SPARK 期貨逐筆回應 HTTP ${response.status}`);
  }

  const payload = await response.json() as RelayTickBarsPayload;
  if (!Array.isArray(payload.bars)) {
    throw new Error("Yuanta SPARK 期貨逐筆回傳格式無效。");
  }
  return payload.bars.flatMap((bar): YuantaSparkBar[] => {
    const time = parseDate(bar.time);
    const open = parseFiniteNumber(bar.open);
    const high = parseFiniteNumber(bar.high);
    const low = parseFiniteNumber(bar.low);
    const close = parseFiniteNumber(bar.close);
    if (
      !time || open === null || high === null || low === null || close === null ||
      Math.min(open, high, low, close) <= 0
    ) return [];
    return [{
      time,
      open,
      high,
      low,
      close,
      volume: parseFiniteNumber(bar.volume),
    }];
  }).sort((left, right) => left.time.getTime() - right.time.getTime());
}

export function fetchYuantaSparkFuturesTickBars(
  symbol: string,
): Promise<YuantaSparkBar[]> {
  const todayInTaipei = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const key = `${symbol.toUpperCase()}:${todayInTaipei}`;
  const cached = futuresTickBarsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = requestYuantaSparkFuturesTickBars(symbol);
  const entry = { expiresAt: Date.now() + TICK_BARS_CACHE_MS, promise };
  futuresTickBarsCache.set(key, entry);
  void promise.catch(() => {
    if (futuresTickBarsCache.get(key) === entry) {
      futuresTickBarsCache.delete(key);
    }
  });
  return promise;
}
