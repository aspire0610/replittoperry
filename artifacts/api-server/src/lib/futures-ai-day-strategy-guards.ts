import type { MarketQuoteData } from "./market-data.js";
import type { PaperFuturesEntryMode } from "@workspace/db";

export const FUTURES_QUOTE_FRESHNESS_MS = 90_000;
export const FUTURES_MIN_TARGET_POINTS = 150;
export const FUTURES_MIN_REWARD_RISK = 2;

export function qualifiesFuturesEntryMode(input: {
  mode: PaperFuturesEntryMode;
  hasCompleteContext: boolean;
  meetsRiskThresholds: boolean;
  hasDirectionalAgreement: boolean;
  hasBreakoutRetestConfirmation: boolean;
}): boolean {
  const baseSetupIsValid =
    input.hasCompleteContext &&
    input.meetsRiskThresholds &&
    input.hasDirectionalAgreement;
  return baseSetupIsValid &&
    (input.mode === "aggressive" || input.hasBreakoutRetestConfirmation);
}

export type FuturesConfirmationBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export function hasBreakoutRetestConfirmation(input: {
  direction: "long" | "short";
  entryPrice: number;
  bars: FuturesConfirmationBar[];
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const completeBars = input.bars
    .filter((bar) => {
      const time = Date.parse(bar.time);
      return (
        Number.isFinite(time) &&
        time + 60_000 <= now &&
        [bar.open, bar.high, bar.low, bar.close].every(
          (price) => Number.isFinite(price) && price > 0,
        ) &&
        bar.low <= Math.min(bar.open, bar.close) &&
        bar.high >= Math.max(bar.open, bar.close)
      );
    })
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const previous = completeBars.at(-2);
  const retest = completeBars.at(-1);
  if (
    !previous ||
    !retest ||
    Date.parse(retest.time) - Date.parse(previous.time) !== 60_000 ||
    now - (Date.parse(retest.time) + 60_000) > 60_000
  ) {
    return false;
  }

  return input.direction === "long"
    ? previous.close > input.entryPrice &&
        previous.close > previous.open &&
        retest.low <= input.entryPrice &&
        retest.close > input.entryPrice &&
        retest.close > retest.open
    : previous.close < input.entryPrice &&
        previous.close < previous.open &&
        retest.high >= input.entryPrice &&
        retest.close < input.entryPrice &&
        retest.close < retest.open;
}

export function hasDirectionalQuoteAgreement(input: {
  direction: "long" | "short";
  futuresChange: number | null;
  indexChange: number | null;
}): boolean {
  if (input.futuresChange === null || input.indexChange === null) return false;
  return input.direction === "long"
    ? input.futuresChange > 0 && input.indexChange > 0
    : input.futuresChange < 0 && input.indexChange < 0;
}

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

export function isValidFuturesEntryPlan(input: {
  action: "long" | "short" | "wait" | "insufficient";
  planDirection: "long" | "short" | null;
  currentPrice: number | null;
  entryPrice: number | null;
  stopLossPrice: number | null;
  targetPrice: number | null;
  entryReason: string | null;
  stopLossReason: string | null;
  targetReason: string | null;
}): boolean {
  const {
    action,
    planDirection,
    currentPrice,
    entryPrice,
    stopLossPrice,
    targetPrice,
    entryReason,
    stopLossReason,
    targetReason,
  } = input;
  if (
    currentPrice === null ||
    entryPrice === null ||
    stopLossPrice === null ||
    targetPrice === null ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopLossPrice) ||
    !Number.isFinite(targetPrice) ||
    currentPrice <= 0 ||
    entryPrice <= 0 ||
    stopLossPrice <= 0 ||
    targetPrice <= 0 ||
    !entryReason?.trim() ||
    !stopLossReason?.trim() ||
    !targetReason?.trim()
  ) {
    return false;
  }

  const direction =
    action === "long" || action === "short" ? action : planDirection;
  if (
    direction === null ||
    ((action === "long" || action === "short") &&
      planDirection !== null &&
      planDirection !== action) ||
    ((action === "long" || action === "short") &&
      Math.abs(entryPrice - currentPrice) > 0.001)
  ) {
    return false;
  }

  const riskPoints =
    direction === "long"
      ? entryPrice - stopLossPrice
      : stopLossPrice - entryPrice;
  const rewardPoints =
    direction === "long"
      ? targetPrice - entryPrice
      : entryPrice - targetPrice;
  return (
    riskPoints > 0 &&
    rewardPoints > 0
  );
}

export function resolveFuturesEntryPlan(input: {
  action: "long" | "short" | "wait" | "insufficient";
  planDirection: "long" | "short";
  currentPrice: number | null;
  entryPrice: number;
  stopLossPrice: number;
  targetPrice: number;
  entryReason: string;
  stopLossReason: string;
  targetReason: string;
}): {
  valid: boolean;
  action: "long" | "short" | "wait" | "insufficient";
  mode: "current" | "conditional" | "reference";
  planDirection: "long" | "short" | null;
} {
  const structuralPlanIsValid = isValidFuturesEntryPlan({
    ...input,
    action: "wait",
  });
  if (!structuralPlanIsValid) {
    return {
      valid: false,
      action: input.action === "long" || input.action === "short" ? "wait" : input.action,
      mode: "reference",
      planDirection: null,
    };
  }

  const exactCurrentEntry =
    input.currentPrice !== null &&
    Math.abs(input.entryPrice - input.currentPrice) <= 0.001;
  const canEnterNow =
    (input.action === "long" || input.action === "short") &&
    input.planDirection === input.action &&
    exactCurrentEntry;
  return {
    valid: true,
    action: canEnterNow
      ? input.action
      : input.action === "insufficient"
        ? "insufficient"
        : "wait",
    mode: canEnterNow ? "current" : "conditional",
    planDirection: input.planDirection,
  };
}
