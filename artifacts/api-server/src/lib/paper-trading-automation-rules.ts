import type {
  AdaptiveFuturesStrategyState,
  AggressiveFuturesStrategyId,
} from "@workspace/db";
import {
  emptyAdaptiveFuturesStrategyState,
  recordAdaptiveFuturesStrategyOutcome,
} from "./adaptive-futures-strategy.js";

export type PaperAutomationSignal = {
  action?: unknown;
  direction?: unknown;
  pricePlanStatus?: unknown;
  entryPrice?: unknown;
  stopLossPrice?: unknown;
  takeProfitPrice?: unknown;
  quoteAsOf?: unknown;
  analyzedAt?: unknown;
  forwardDirectionValidation?: unknown;
  pricePlanValidation?: unknown;
};

export type PaperAutomationSignalCheck =
  | { eligible: true }
  | { eligible: false; reason: string };

export type FuturesPaperPerformance = {
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  realizedPnl: number;
  consecutiveStopLosses: number;
  stopLossStreakId: number;
  lastAdjustedStreakId: number;
  lastAdjustedStopLossCount: number;
  recentStopLosses: Array<{
    direction: "long" | "short";
    entryPrice: number;
    exitPrice: number;
    stopLossPrice: number;
    realizedPnl: number;
    asOf: string;
  }>;
  adjustmentFeedback: {
    streakId: number;
    consecutiveStopLosses: number;
    recentStopLosses: Array<{
      direction: "long" | "short";
      entryPrice: number;
      exitPrice: number;
      stopLossPrice: number;
      realizedPnl: number;
      asOf: string;
    }>;
  } | null;
  adjustmentStatus: "idle" | "pending" | "applied";
  adjustmentAt: string | null;
  adjustmentMessage: string;
  adaptiveStrategy: AdaptiveFuturesStrategyState;
};

const MINIMUM_SAMPLE_COUNT = 100;
const MINIMUM_WILSON_LOWER_PERCENT = 80;
const FUTURES_DAY_ENTRY_END_MINUTE = 13 * 60 + 30;
const FUTURES_DAY_FLATTEN_START_MINUTE = 13 * 60 + 40;
const FUTURES_NIGHT_ENTRY_END_MINUTE = 4 * 60 + 45;
const FUTURES_NIGHT_FLATTEN_START_MINUTE = 4 * 60 + 55;
export const PAPER_FORCE_ENTRY_MIN_TARGET_POINTS = 20;
export const FUTURES_STRATEGY_RETRY_BASE_INTERVAL_MS = 5 * 60_000;
export const FUTURES_STRATEGY_RETRY_MAX_INTERVAL_MS = 30 * 60_000;
export const FUTURES_UNAVAILABLE_DECISION_LOG_INTERVAL_MS = 5 * 60_000;

export function futuresStrategyRetryIntervalMs(failureCount: number): number {
  if (!Number.isFinite(failureCount) || failureCount < 1) {
    return FUTURES_STRATEGY_RETRY_BASE_INTERVAL_MS;
  }
  return Math.min(
    FUTURES_STRATEGY_RETRY_MAX_INTERVAL_MS,
    FUTURES_STRATEGY_RETRY_BASE_INTERVAL_MS * 2 ** Math.floor(failureCount - 1),
  );
}

export function shouldRecordUnavailableFuturesDecision(
  previousAsOf: string | undefined,
  nowMs: number,
): boolean {
  if (!previousAsOf) return true;
  const previousMs = Date.parse(previousAsOf);
  return !Number.isFinite(previousMs) ||
    nowMs - previousMs >= FUTURES_UNAVAILABLE_DECISION_LOG_INTERVAL_MS;
}

export function isFuturesDayEntryTime(minuteOfDay: number): boolean {
  return Number.isInteger(minuteOfDay) &&
    minuteOfDay >= 8 * 60 + 45 &&
    minuteOfDay < FUTURES_DAY_ENTRY_END_MINUTE;
}

export function shouldFlattenFuturesDayPosition(minuteOfDay: number): boolean {
  return Number.isInteger(minuteOfDay) &&
    minuteOfDay >= FUTURES_DAY_FLATTEN_START_MINUTE;
}

export function isFuturesNightEntryTime(minuteOfDay: number): boolean {
  return Number.isInteger(minuteOfDay) &&
    (minuteOfDay >= 15 * 60 || minuteOfDay < FUTURES_NIGHT_ENTRY_END_MINUTE);
}

export function shouldFlattenFuturesNightPosition(minuteOfDay: number): boolean {
  return Number.isInteger(minuteOfDay) &&
    minuteOfDay >= FUTURES_NIGHT_FLATTEN_START_MINUTE &&
    minuteOfDay < 5 * 60;
}

export type PaperFuturesEntryDecision = {
  direction: "long" | "short";
  entryPrice: number;
  stopLossPrice: number;
  targetPrice: number;
  forced: boolean;
};

export function resolvePaperFuturesEntry(input: {
  forceEntry: boolean;
  status: "available" | "waiting_for_day_session" | "insufficient_data";
  action: "long" | "short" | "wait" | "insufficient";
  entryPlanStatus: "available" | "unavailable";
  entryPlanMode: "current" | "conditional" | "reference";
  planDirection: "long" | "short" | null;
  currentPrice: number | null;
  plannedEntryPrice: number | null;
  stopLossPrice: number | null;
  targetPrice: number | null;
}): PaperFuturesEntryDecision | null {
  const {
    forceEntry,
    status,
    action,
    entryPlanStatus,
    entryPlanMode,
    planDirection,
    currentPrice,
    plannedEntryPrice,
    stopLossPrice,
    targetPrice,
  } = input;
  if (
    status !== "available" ||
    action === "insufficient" ||
    entryPlanStatus !== "available" ||
    entryPlanMode === "reference" ||
    currentPrice === null ||
    plannedEntryPrice === null ||
    stopLossPrice === null ||
    targetPrice === null ||
    ![currentPrice, plannedEntryPrice, stopLossPrice, targetPrice]
      .every((value) => Number.isFinite(value) && value > 0)
  ) return null;

  const direction = forceEntry
    ? action === "long" || action === "short"
      ? action
      : null
    : action === "long" || action === "short"
      ? action
      : null;
  if (
    direction === null ||
    planDirection !== direction ||
    (!forceEntry &&
      (action !== direction ||
        entryPlanMode !== "current" ||
        Math.abs(plannedEntryPrice - currentPrice) > 0.001))
  ) return null;

  const entryPrice = forceEntry ? currentPrice : plannedEntryPrice;
  const validPriceOrder = direction === "long"
    ? stopLossPrice < entryPrice && entryPrice < targetPrice
    : targetPrice < entryPrice && entryPrice < stopLossPrice;
  if (!validPriceOrder) return null;
  const targetDistance = direction === "long"
    ? targetPrice - entryPrice
    : entryPrice - targetPrice;
  if (forceEntry && targetDistance < PAPER_FORCE_ENTRY_MIN_TARGET_POINTS) return null;

  return {
    direction,
    entryPrice,
    stopLossPrice,
    targetPrice,
    forced: forceEntry,
  };
}

export function shouldTriggerPaperFuturesStrategyReview(
  performance: FuturesPaperPerformance,
  reviewThreshold = 3,
): boolean {
  return performance.consecutiveStopLosses >= reviewThreshold &&
    performance.stopLossStreakId > 0 &&
    (
      performance.stopLossStreakId !== performance.lastAdjustedStreakId ||
      performance.consecutiveStopLosses >= performance.lastAdjustedStopLossCount + reviewThreshold
    );
}

export function recordPaperFuturesExit(
  current: FuturesPaperPerformance,
  input: {
    exitReason: "take_profit" | "stop_loss" | "session_end";
    direction: "long" | "short";
    entryPrice: number;
    exitPrice: number;
    stopLossPrice: number;
    realizedPnl: number;
    asOf: string;
    adaptiveStrategyId?: AggressiveFuturesStrategyId;
  },
  reviewThreshold = 3,
  autoReviewEnabled = true,
): FuturesPaperPerformance {
  const performance = {
    ...current,
    recentStopLosses: [...current.recentStopLosses],
    adaptiveStrategy:
      current.adaptiveStrategy ?? emptyAdaptiveFuturesStrategyState(),
  };
  performance.closedTrades += 1;
  performance.realizedPnl = Math.round((performance.realizedPnl + input.realizedPnl) * 100) / 100;
  if (input.realizedPnl > 0) performance.wins += 1;
  else if (input.realizedPnl < 0) performance.losses += 1;
  else performance.breakeven += 1;
  if (input.adaptiveStrategyId) {
    performance.adaptiveStrategy = recordAdaptiveFuturesStrategyOutcome(
      performance.adaptiveStrategy,
      {
        strategyId: input.adaptiveStrategyId,
        realizedPnl: input.realizedPnl,
        exitReason: input.exitReason,
      },
    );
  }

  if (input.exitReason === "stop_loss") {
    if (performance.consecutiveStopLosses === 0) performance.stopLossStreakId += 1;
    performance.consecutiveStopLosses += 1;
    performance.recentStopLosses.push({
      direction: input.direction,
      entryPrice: input.entryPrice,
      exitPrice: input.exitPrice,
      stopLossPrice: input.stopLossPrice,
      realizedPnl: input.realizedPnl,
      asOf: input.asOf,
    });
    performance.recentStopLosses = performance.recentStopLosses.slice(-reviewThreshold);
    if (autoReviewEnabled && shouldTriggerPaperFuturesStrategyReview(performance, reviewThreshold)) {
      performance.adjustmentStatus = "pending";
      performance.adjustmentMessage =
        `連續停損已達 ${reviewThreshold} 次，等待 AI 依近期結果重新評估。`;
      performance.adjustmentFeedback = {
        streakId: performance.stopLossStreakId,
        consecutiveStopLosses: performance.consecutiveStopLosses,
        recentStopLosses: performance.recentStopLosses.slice(-reviewThreshold),
      };
    }
  } else {
    performance.consecutiveStopLosses = 0;
    performance.recentStopLosses = [];
    performance.adjustmentFeedback = null;
  }
  return performance;
}

export function wilsonLowerBoundPercent(wins: number, samples: number): number | null {
  if (!Number.isInteger(wins) || !Number.isInteger(samples) || samples <= 0 || wins < 0 || wins > samples) {
    return null;
  }
  const z = 1.959963984540054;
  const p = wins / samples;
  const zSquared = z * z;
  const denominator = 1 + zSquared / samples;
  const center = p + zSquared / (2 * samples);
  const margin = z * Math.sqrt((p * (1 - p) + zSquared / (4 * samples)) / samples);
  return ((center - margin) / denominator) * 100;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

export function validatePaperAutomationSignal(
  assessment: PaperAutomationSignal,
): PaperAutomationSignalCheck {
  if (assessment.action !== "buy" || assessment.direction !== "bullish") {
    return { eligible: false, reason: "AI 判讀不是有效買進訊號，未建立模擬委託。" };
  }
  if (assessment.pricePlanStatus !== "available") {
    return { eligible: false, reason: "進場、停損或停利方案未通過檢查，未建立模擬委託。" };
  }
  const entry = Number(assessment.entryPrice);
  const stop = Number(assessment.stopLossPrice);
  const target = Number(assessment.takeProfitPrice);
  if (![entry, stop, target].every((value) => Number.isFinite(value) && value > 0) || !(stop < entry && entry < target)) {
    return { eligible: false, reason: "價位缺漏或順序不一致，未建立模擬委託。" };
  }

  const directionValidation = record(assessment.forwardDirectionValidation);
  const horizons = Array.isArray(directionValidation?.horizons) ? directionValidation.horizons : [];
  const fiveDay = horizons.map(record).find((horizon) => horizon?.horizonDays === 5);
  const directionSamples = Number(fiveDay?.evaluatedDirectionalForecastCount);
  const directionWins = Number(fiveDay?.correctForecastCount);
  const directionLowerBound = wilsonLowerBoundPercent(directionWins, directionSamples);
  if (
    directionLowerBound === null ||
    directionSamples < MINIMUM_SAMPLE_COUNT ||
    directionLowerBound < MINIMUM_WILSON_LOWER_PERCENT
  ) {
    return {
      eligible: false,
      reason: `5 日方向驗證尚未達到 ${MINIMUM_SAMPLE_COUNT} 筆且 95% 信賴下限 ${MINIMUM_WILSON_LOWER_PERCENT}% 的門檻。`,
    };
  }

  const planValidation = record(assessment.pricePlanValidation);
  const planSamples = Number(planValidation?.resolvedTradeCount);
  const planWins = Number(planValidation?.targetFirstCount);
  const planLowerBound = wilsonLowerBoundPercent(planWins, planSamples);
  if (
    planLowerBound === null ||
    planSamples < MINIMUM_SAMPLE_COUNT ||
    planLowerBound < MINIMUM_WILSON_LOWER_PERCENT
  ) {
    return {
      eligible: false,
      reason: `價位方案驗證尚未達到 ${MINIMUM_SAMPLE_COUNT} 筆且 95% 信賴下限 ${MINIMUM_WILSON_LOWER_PERCENT}% 的門檻。`,
    };
  }

  const quoteAsOf = timestamp(assessment.quoteAsOf);
  const analyzedAt = timestamp(assessment.analyzedAt);
  const now = Date.now();
  if (
    !Number.isFinite(quoteAsOf) ||
    !Number.isFinite(analyzedAt) ||
    now - quoteAsOf > 24 * 60 * 60 * 1000 ||
    now - analyzedAt > 24 * 60 * 60 * 1000 ||
    quoteAsOf > now + 60_000 ||
    analyzedAt > now + 60_000
  ) {
    return { eligible: false, reason: "AI 判讀或行情時間已過期，未建立模擬委託。" };
  }
  return { eligible: true };
}

export function calculatePaperAutomationShares(input: {
  equity: number;
  cash: number;
  riskPerTradePercent: number;
  entryPrice: number;
  stopLossPrice: number;
  lotSize?: number;
  commissionRate?: number;
  sellTaxRate?: number;
}): number {
  const {
    equity,
    cash,
    riskPerTradePercent,
    entryPrice,
    stopLossPrice,
    lotSize = 1_000,
    commissionRate = 0.001425,
    sellTaxRate = 0.003,
  } = input;
  if (
    ![equity, cash, riskPerTradePercent, entryPrice, stopLossPrice, lotSize, commissionRate, sellTaxRate].every(Number.isFinite) ||
    equity <= 0 || cash <= 0 || riskPerTradePercent <= 0 || entryPrice <= stopLossPrice ||
    stopLossPrice <= 0 || lotSize <= 0 || commissionRate < 0 || sellTaxRate < 0
  ) return 0;

  const riskBudget = equity * riskPerTradePercent / 100;
  const estimatedLossPerShare =
    entryPrice - stopLossPrice +
    entryPrice * commissionRate +
    stopLossPrice * (commissionRate + sellTaxRate);
  const riskShares = Math.floor(riskBudget / estimatedLossPerShare);
  const cashShares = Math.floor(cash / (entryPrice * (1 + commissionRate)));
  const shares = Math.min(riskShares, cashShares);
  return Math.floor(shares / lotSize) * lotSize;
}

export function paperAutomationExitReason(
  price: number,
  stopLossPrice: number,
  takeProfitPrice: number,
): "stop_loss" | "take_profit" | null {
  if (![price, stopLossPrice, takeProfitPrice].every((value) => Number.isFinite(value) && value > 0)) return null;
  if (price <= stopLossPrice) return "stop_loss";
  if (price >= takeProfitPrice) return "take_profit";
  return null;
}

export function calculatePaperFuturesContracts(input: {
  equity: number;
  riskPerTradePercent: number;
  entryPrice: number;
  stopLossPrice: number;
  contractMultiplier: number;
  maxContracts?: number;
}): number {
  const {
    equity,
    riskPerTradePercent,
    entryPrice,
    stopLossPrice,
    contractMultiplier,
    maxContracts = 5,
  } = input;
  if (
    ![equity, riskPerTradePercent, entryPrice, stopLossPrice, contractMultiplier, maxContracts]
      .every(Number.isFinite) ||
    equity <= 0 ||
    riskPerTradePercent <= 0 ||
    entryPrice <= 0 ||
    stopLossPrice <= 0 ||
    entryPrice === stopLossPrice ||
    contractMultiplier <= 0 ||
    !Number.isInteger(maxContracts) ||
    maxContracts < 1
  ) return 0;
  const riskPerContract = Math.abs(entryPrice - stopLossPrice) * contractMultiplier;
  const riskBudget = equity * riskPerTradePercent / 100;
  return Math.min(maxContracts, Math.floor(riskBudget / riskPerContract));
}

export function paperFuturesExitReason(
  price: number,
  direction: "long" | "short",
  stopLossPrice: number,
  takeProfitPrice: number,
): "stop_loss" | "take_profit" | null {
  if (![price, stopLossPrice, takeProfitPrice].every((value) => Number.isFinite(value) && value > 0)) return null;
  if (direction === "long") {
    if (price <= stopLossPrice) return "stop_loss";
    if (price >= takeProfitPrice) return "take_profit";
  } else {
    if (price >= stopLossPrice) return "stop_loss";
    if (price <= takeProfitPrice) return "take_profit";
  }
  return null;
}
