import type { StockQuoteData } from "./market-data.js";

export const MAX_VERIFIED_STOCK_TRADE_AGE_MS = 3 * 60_000;

export type StockAiQuoteResolution =
  | {
      usable: true;
      quote: StockQuoteData;
      referenceType: "verified_trade" | "official_daily_close";
    }
  | {
      usable: false;
      quote: null;
      referenceType: null;
      error: string;
    };

export function resolveStockAiQuote({
  providerQuote,
  closeQuote,
  sessionOpen,
  providerQuoteIsInSession,
  now = new Date(),
}: {
  providerQuote: StockQuoteData | null;
  closeQuote: StockQuoteData;
  sessionOpen: boolean;
  providerQuoteIsInSession: boolean;
  now?: Date;
}): StockAiQuoteResolution {
  const providerQuoteAgeMs =
    providerQuote?.asOf === null || providerQuote?.asOf === undefined
      ? Number.POSITIVE_INFINITY
      : now.getTime() - providerQuote.asOf.getTime();
  const hasNewerVerifiedTrade =
    sessionOpen &&
    providerQuote?.available === true &&
    providerQuote.price !== null &&
    providerQuote.asOf !== null &&
    providerQuoteIsInSession &&
    providerQuote.source.includes("成交時間") &&
    !providerQuote.source.includes("盤後最後成交") &&
    providerQuoteAgeMs <= MAX_VERIFIED_STOCK_TRADE_AGE_MS &&
    providerQuoteAgeMs >= -60_000;

  if (sessionOpen && !hasNewerVerifiedTrade) {
    return {
      usable: false,
      quote: null,
      referenceType: null,
      error:
        "盤中 AI 判讀需要可驗證的即時個股報價；目前無法確認新成交，因此不會以最近收盤價代替。請稍後重試。",
    };
  }

  return {
    usable: true,
    quote: hasNewerVerifiedTrade ? providerQuote : closeQuote,
    referenceType: hasNewerVerifiedTrade
      ? "verified_trade"
      : "official_daily_close",
  };
}
