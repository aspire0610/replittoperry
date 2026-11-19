import type { MarketQuoteData } from "./market-data.js";

type YahooChart = {
  chart?: {
    result?: Array<{
      meta?: { symbol?: string; regularMarketPrice?: number; regularMarketTime?: number };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }> | null;
  };
};

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function usDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(timestamp));
}

export function parseYahooUsQuote(payload: unknown, symbol: string, now = Date.now()) {
  const result = (payload as YahooChart | null)?.chart?.result?.[0];
  const meta = result?.meta;
  if (meta?.symbol !== symbol || !positive(meta.regularMarketPrice) || !positive(meta.regularMarketTime)) {
    throw new Error("Yahoo Finance 商品代碼、價格或來源時間不完整");
  }
  const time = meta.regularMarketTime * 1_000;
  if (!Number.isFinite(time) || time > now + 60_000 || now - time > 7 * 86_400_000) {
    throw new Error("Yahoo Finance 來源時間過期或超前");
  }
  const date = usDate(time);
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  // chartPreviousClose is the start of the requested range, NOT yesterday's close.
  const previous = (result?.timestamp ?? []).flatMap((timestamp, index) => {
    const close = closes[index];
    return positive(timestamp) && timestamp * 1_000 < time &&
      usDate(timestamp * 1_000) < date && positive(close)
      ? [{ timestamp, close }] : [];
  }).sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!previous || time - previous.timestamp * 1_000 > 7 * 86_400_000) {
    throw new Error("Yahoo Finance 缺少可核對的前一交易日收盤");
  }
  const change = meta.regularMarketPrice - previous.close;
  return {
    price: meta.regularMarketPrice,
    change,
    changePercent: change / previous.close * 100,
    asOf: new Date(time),
    source: `Yahoo Finance · 備援 · 一般交易時段行情（可能延遲）· 美國交易日 ${date}`,
    available: true,
    error: null,
  };
}

/** Keep primary quotes unchanged; never replace SOX with a semiconductor ETF. */
export async function recoverUsMarketQuote(
  primary: MarketQuoteData,
  yahooSymbol: string,
): Promise<MarketQuoteData> {
  if (primary.available) return primary;
  try {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`);
    url.searchParams.set("range", "5d");
    url.searchParams.set("interval", "1d");
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Yahoo Finance 回應 HTTP ${response.status}`);
    return { ...primary, ...parseYahooUsQuote(await response.json(), yahooSymbol) };
  } catch (error) {
    return {
      ...primary,
      error: `${primary.error ?? "Nasdaq 資料暫不可用"}；${error instanceof Error ? error.message : "Yahoo Finance 備援失敗"}`,
    };
  }
}
