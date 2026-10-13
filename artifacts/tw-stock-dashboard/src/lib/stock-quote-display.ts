const FRESH_STOCK_QUOTE_MAX_AGE_MS = 90_000;
const LAST_TRADE_DISPLAY_MAX_AGE_MS = 3 * 60_000;

export type StockQuoteDisplayInput = {
  available: boolean;
  price: number | null;
  source: string;
  asOf: string | null;
};

export type StockQuoteDisplayStatus = {
  available: boolean;
  isDelayedLastTrade: boolean;
};

export function getStockQuoteDisplayStatus(
  quote: StockQuoteDisplayInput | undefined,
  sessionOpen: boolean,
  now = Date.now(),
): StockQuoteDisplayStatus {
  if (!quote?.available || quote.price === null || !quote.asOf) {
    return { available: false, isDelayedLastTrade: false };
  }

  const timestamp = Date.parse(quote.asOf);
  const age = now - timestamp;
  if (!Number.isFinite(timestamp) || age < -60_000) {
    return { available: false, isDelayedLastTrade: false };
  }

  if (!sessionOpen) {
    return { available: true, isDelayedLastTrade: false };
  }

  const hasVerifiedTradeTime = quote.source.includes("成交時間");
  const maxAge = hasVerifiedTradeTime
    ? LAST_TRADE_DISPLAY_MAX_AGE_MS
    : FRESH_STOCK_QUOTE_MAX_AGE_MS;
  if (age > maxAge) {
    return { available: false, isDelayedLastTrade: false };
  }

  return {
    available: true,
    isDelayedLastTrade:
      hasVerifiedTradeTime && age > FRESH_STOCK_QUOTE_MAX_AGE_MS,
  };
}

export function getStockQuoteFallbackReason(
  error: string | null | undefined,
): string | null {
  if (!error) return null;
  const staleAge = error.match(/超過\s*(\d+)\s*秒未更新/u);
  if (staleAge) {
    const minutes = Math.ceil(Number(staleAge[1]) / 60);
    return `即時來源超過 ${minutes} 分鐘未更新`;
  }
  if (/未提供成交時間|沒有成交時間/u.test(error)) {
    return "即時來源沒有可驗證的成交時間";
  }
  return "目前沒有可驗證的即時報價";
}
