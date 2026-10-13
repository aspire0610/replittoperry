import type { MarketQuoteData } from "./market-data.js";

export const FUTURES_QUOTE_FRESHNESS_MS = 90_000;

export function isFreshMarketQuote(
  quote: MarketQuoteData,
  now = Date.now(),
): boolean {
  if (
    !quote.available ||
    quote.price === null ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0 ||
    !quote.asOf
  ) {
    return false;
  }
  if (quote.source?.includes("盤後")) return false;
  const age = now - quote.asOf.getTime();
  return age >= -60_000 && age <= FUTURES_QUOTE_FRESHNESS_MS;
}

export function isFreshIntradayTaiexQuote(
  quote: MarketQuoteData,
  now = Date.now(),
): boolean {
  if (/(最近收盤價|官方收盤|日線|盤後|非即時)/u.test(quote.source ?? "")) {
    return false;
  }
  return isFreshMarketQuote(quote, now);
}

export function areQuotesSynchronized(
  left: MarketQuoteData,
  right: MarketQuoteData,
): boolean {
  if (!left.asOf || !right.asOf) return false;
  return (
    Math.abs(left.asOf.getTime() - right.asOf.getTime()) <=
    FUTURES_QUOTE_FRESHNESS_MS
  );
}

export function sameQuoteSnapshot(
  left: MarketQuoteData,
  right: MarketQuoteData,
): boolean {
  return (
    left.key === right.key &&
    left.available === right.available &&
    left.price === right.price &&
    left.change === right.change &&
    left.changePercent === right.changePercent &&
    left.source === right.source &&
    left.asOf?.getTime() === right.asOf?.getTime()
  );
}
