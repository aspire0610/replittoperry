import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  type FuturesAiDayStrategy,
} from "@workspace/api-zod";
import {
  aiStockResearchAgentsTable,
  db,
  paperTradingAutomationTable,
  type PaperAutomationEvent,
  type PaperAutomationState,
  type PaperFuturesEvaluation,
  type PaperFuturesPerformanceState,
  type PaperFuturesStopLossOutcome,
  type PaperFuturesEntryMode,
  type AggressiveFuturesStrategyId,
  type PaperTradingAutomation,
} from "@workspace/db";
import {
  fetchFuturesDayIntraday,
} from "./futures-day-intraday.js";
import {
  resolveFuturesSession,
  isFuturesSessionQuoteTimestamp,
} from "./futures-session.js";
import { getFuturesAiDayStrategy } from "./futures-ai-day-strategy.js";
import {
  getStockQuote,
  isTaiwanStockSessionOpen,
  type StockQuoteData,
} from "./market-data.js";
import {
  calculatePaperTradeCosts,
  calculateRealizedPaperTradePnl,
} from "./paper-trading-math.js";
import { isFundOrEtf } from "./quant-market-parse.js";
import {
  calculatePaperAutomationShares,
  calculatePaperFuturesContracts,
  isFuturesDayEntryTime,
  isFuturesNightEntryTime,
  futuresStrategyRetryIntervalMs,
  PAPER_FORCE_ENTRY_MIN_TARGET_POINTS,
  paperAutomationExitReason,
  paperFuturesExitReason,
  recordPaperFuturesExit,
  resolvePaperFuturesEntry,
  shouldTriggerPaperFuturesStrategyReview,
  shouldFlattenFuturesDayPosition,
  shouldFlattenFuturesNightPosition,
  shouldRecordUnavailableFuturesDecision,
  validatePaperAutomationSignal,
  type PaperAutomationSignal,
  type PaperFuturesEntryDecision,
} from "./paper-trading-automation-rules.js";
import type { FuturesStrategyAdjustmentFeedback } from "./futures-ai-day-strategy.js";
import {
  adaptiveFuturesStrategyMessage,
  emptyAdaptiveFuturesStrategyState,
  recordAdaptiveFuturesStrategyOutcome,
  resolveAggressiveFuturesStrategy,
} from "./adaptive-futures-strategy.js";

const MAX_EVENTS = 100;
const SIGNAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_QUOTE_AGE_MS = 3 * 60 * 1_000;
const MAX_FUTURES_QUOTE_AGE_MS = 90_000;
const FUTURES_TICKER = "TXF";
const FUTURES_CONTRACTS = {
  TX: { name: "大台", multiplier: 200 },
  MTX: { name: "小台", multiplier: 50 },
  TMF: { name: "微台", multiplier: 10 },
} as const;
const FUTURES_DECISION_LOG_LIMIT = 25;
const FUTURES_DECISION_PRICE_CHANGE_POINTS = 10;
const FUTURES_STOP_LOSS_REVIEW_THRESHOLD = 3;
const futuresStrategyKey = (
  entryMode: PaperFuturesEntryMode,
  forceEntry: boolean,
  sessionSymbol: "TXF1" | "TXF8",
  adaptiveStrategyId?: AggressiveFuturesStrategyId,
) => `${sessionSymbol}:${entryMode}:${forceEntry ? "forced" : "standard"}:${adaptiveStrategyId ?? "default"}`;
const DISCLAIMER =
  "此帳本只做紙上模擬，不連接券商、不會送出真實委託；股票按現股成交，期貨以 TX 連續行情估算 TX／MTX／TMF 點值損益，每筆最多 5 口，不扣保證金、手續費或期交稅，也忽略排隊、滑價及市場衝擊。日盤與夜盤分別使用 TXF1、TXF8 專屬 AI 訊號及同時段資料；日盤 13:30、夜盤 04:45 後不再進場，各盤收盤前 5 分鐘若有新鮮行情就模擬平倉，若行情不足則保留持倉並持續監控。模擬結果不代表未來績效。";

export class PaperAutomationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PaperAutomationError";
  }
}

const cachedAutomationFuturesStrategies = new Map<
  string,
  {
    lastAttemptAt: number;
    strategy: FuturesAiDayStrategy | null;
    failureCount: number;
  }
>();

type FuturesStrategyForAccount = {
  strategy: FuturesAiDayStrategy | null;
  adjustedForStreakId: number | null;
  adaptiveStrategyId?: AggressiveFuturesStrategyId;
};

export type PaperAutomationSettingsInput = {
  startingCash?: number;
  riskPerTradePercent: number;
  dailyLossLimitPercent: number;
  maxOpenPositions: number;
  futuresEnabled: boolean;
  futuresContract: keyof typeof FUTURES_CONTRACTS;
  futuresEntryMode: PaperFuturesEntryMode;
  futuresForceEntryEnabled?: boolean;
};

function numberValue(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new PaperAutomationError("模擬資金資料無效。", 503);
  return parsed;
}

function emptyState(): PaperAutomationState {
  return {
    positions: [],
    pendingEntries: [],
    events: [],
    currentFuturesEvaluation: null,
    futuresDecisionLogs: [],
    futuresPerformance: emptyFuturesPerformance(),
    dailyDate: null,
    dailyStartEquity: null,
    dailyStopTriggered: false,
    lastProcessedAt: null,
  };
}

function emptyFuturesPerformance(): PaperFuturesPerformanceState {
  return {
    closedTrades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    realizedPnl: 0,
    consecutiveStopLosses: 0,
    stopLossStreakId: 0,
    lastAdjustedStreakId: 0,
    lastAdjustedStopLossCount: 0,
    recentStopLosses: [],
    adjustmentFeedback: null,
    adjustmentStatus: "idle",
    adjustmentAt: null,
    adjustmentMessage: "",
    adaptiveStrategy: emptyAdaptiveFuturesStrategyState(),
  };
}

function summarizeFuturesEvents(
  events: PaperAutomationEvent[],
  autoReviewEnabled = true,
): PaperFuturesPerformanceState {
  const performance = emptyFuturesPerformance();
  const exits = events
    .filter((event) =>
      event.kind === "exit_filled" &&
      event.assetClass === "futures" &&
      ["take_profit", "stop_loss", "session_end"].includes(event.exitReason ?? "")
    )
    .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));

  for (const event of exits) {
    if (
      event.adaptiveStrategyId &&
      event.realizedPnl !== undefined &&
      event.exitReason
    ) {
      performance.adaptiveStrategy = recordAdaptiveFuturesStrategyOutcome(
        performance.adaptiveStrategy,
        {
          strategyId: event.adaptiveStrategyId,
          realizedPnl: event.realizedPnl,
          exitReason: event.exitReason,
        },
      );
    }
    if (event.exitReason === "stop_loss") {
      if (performance.consecutiveStopLosses === 0) performance.stopLossStreakId += 1;
      performance.consecutiveStopLosses += 1;
      if (
        event.direction &&
        event.entryPrice !== undefined &&
        event.price !== null &&
        event.realizedPnl !== undefined
      ) {
        performance.recentStopLosses.push({
          direction: event.direction,
          entryPrice: event.entryPrice,
          exitPrice: event.price,
          stopLossPrice: event.stopLossPrice ?? event.price,
          realizedPnl: event.realizedPnl,
          asOf: event.asOf,
        });
        performance.recentStopLosses = performance.recentStopLosses.slice(-3);
      }
    } else {
      performance.consecutiveStopLosses = 0;
    }
    if (event.realizedPnl === undefined) continue;
    performance.closedTrades += 1;
    performance.realizedPnl += event.realizedPnl;
    if (event.realizedPnl > 0) performance.wins += 1;
    else if (event.realizedPnl < 0) performance.losses += 1;
    else performance.breakeven += 1;
  }
  performance.realizedPnl = Math.round(performance.realizedPnl * 100) / 100;
  if (autoReviewEnabled && performance.consecutiveStopLosses >= FUTURES_STOP_LOSS_REVIEW_THRESHOLD) {
    performance.adjustmentStatus = "pending";
    performance.adjustmentMessage = "連續停損已達 3 次，等待 AI 依近期結果重新評估。";
    performance.adjustmentFeedback = {
      streakId: performance.stopLossStreakId,
      consecutiveStopLosses: performance.consecutiveStopLosses,
      recentStopLosses: performance.recentStopLosses.slice(-FUTURES_STOP_LOSS_REVIEW_THRESHOLD),
    };
  }
  return performance;
}

function toTaipeiDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function taipeiMinuteOfDay(date: Date): number {
  const taipei = new Date(date.getTime() + 8 * 60 * 60_000);
  return taipei.getUTCHours() * 60 + taipei.getUTCMinutes();
}

function positionMarketValue(position: PaperAutomationState["positions"][number]): number {
  if (position.assetClass === "futures") {
    const direction = position.direction === "short" ? -1 : 1;
    return position.shares *
      (position.lastPrice - position.entryPrice) *
      (position.contractMultiplier ?? 0) *
      direction;
  }
  return position.shares * position.lastPrice;
}

function accountEquity(cash: number, positions: PaperAutomationState["positions"]): number {
  return Math.round((cash + positions.reduce(
    (sum, position) => sum + positionMarketValue(position),
    0,
  )) * 100) / 100;
}

function addEvent(
  state: PaperAutomationState,
  event: Omit<PaperAutomationEvent, "id" | "asOf"> & { asOf?: string },
): void {
  state.events.unshift({
    ...event,
    id: randomUUID(),
    asOf: event.asOf ?? new Date().toISOString(),
  });
  state.events = state.events.slice(0, MAX_EVENTS);
}

function updateFuturesEvaluation(
  state: PaperAutomationState,
  evaluation: Omit<PaperFuturesEvaluation, "id" | "asOf">,
  now: Date,
): void {
  const asOf = now.toISOString();
  const current = {
    ...evaluation,
    id: state.currentFuturesEvaluation?.id ?? randomUUID(),
    asOf,
  };
  state.currentFuturesEvaluation = current;

  const signature = (item: PaperFuturesEvaluation) => JSON.stringify([
    item.status,
    item.action,
    item.direction,
    item.stopLossPrice,
    item.targetPrice,
    item.reason,
  ]);
  const latestLog = state.futuresDecisionLogs[0];
  if (latestLog && signature(latestLog) === signature(current)) {
    if (current.status === "unavailable" && latestLog.status === "unavailable") {
      if (!shouldRecordUnavailableFuturesDecision(latestLog.asOf, now.getTime())) {
        return;
      }
    } else {
      const priceMovedEnough =
        latestLog.price !== null &&
        current.price !== null &&
        Math.abs(latestLog.price - current.price) >= FUTURES_DECISION_PRICE_CHANGE_POINTS;
      const minuteElapsed = now.getTime() - Date.parse(latestLog.asOf) >= 60_000;
      if (!priceMovedEnough && !minuteElapsed) return;
    }
  }
  state.futuresDecisionLogs.unshift({ ...current, id: randomUUID() });
  state.futuresDecisionLogs = state.futuresDecisionLogs.slice(0, FUTURES_DECISION_LOG_LIMIT);
}

function futuresAdjustmentFeedback(
  performance: PaperFuturesPerformanceState,
  includeStrategyTrials = false,
): FuturesStrategyAdjustmentFeedback | null {
  if (
    performance.consecutiveStopLosses < FUTURES_STOP_LOSS_REVIEW_THRESHOLD ||
    performance.stopLossStreakId === 0
  ) return null;
  const reviewDue = shouldTriggerPaperFuturesStrategyReview(
    performance,
    FUTURES_STOP_LOSS_REVIEW_THRESHOLD,
  );
  const withStrategyTrials = (
    feedback: FuturesStrategyAdjustmentFeedback,
  ): FuturesStrategyAdjustmentFeedback => includeStrategyTrials
    ? {
        ...feedback,
        strategyTrials: Object.entries(performance.adaptiveStrategy?.strategies ?? {})
          .map(([strategyId, stats]) => {
            const decisiveTrades = stats.wins + stats.losses;
            return {
              strategyId: strategyId as AggressiveFuturesStrategyId,
              closedTrades: stats.closedTrades,
              wins: stats.wins,
              losses: stats.losses,
              rawWinRatePercent: decisiveTrades
                ? Math.round(stats.wins / decisiveTrades * 1000) / 10
                : null,
              realizedPnl: stats.realizedPnl,
            };
          })
      }
    : feedback;
  const savedFeedback = performance.adjustmentFeedback;
  if (!reviewDue && savedFeedback?.streakId === performance.stopLossStreakId) {
    return withStrategyTrials({
      consecutiveStopLosses: savedFeedback.consecutiveStopLosses,
      recentStopLosses: savedFeedback.recentStopLosses,
    });
  }
  return withStrategyTrials({
    consecutiveStopLosses: performance.consecutiveStopLosses,
    recentStopLosses: performance.recentStopLosses.slice(-FUTURES_STOP_LOSS_REVIEW_THRESHOLD),
  });
}

function exchangeForTicker(ticker: string): "tse" | "otc" {
  return ticker.endsWith(".TWO") ? "otc" : "tse";
}

function isFreshSessionQuote(quote: StockQuoteData, now = new Date()): boolean {
  return Boolean(
    quote.available &&
    quote.price !== null &&
    quote.price > 0 &&
    quote.asOf &&
    now.getTime() - quote.asOf.getTime() >= 0 &&
    now.getTime() - quote.asOf.getTime() <= MAX_QUOTE_AGE_MS &&
    isTaiwanStockSessionOpen(quote.asOf),
  );
}

function marketDateFromAssessment(assessment: PaperAutomationSignal): string | null {
  const date = assessment.quoteAsOf instanceof Date
    ? assessment.quoteAsOf
    : typeof assessment.quoteAsOf === "string"
      ? new Date(assessment.quoteAsOf)
      : null;
  if (!date) return null;
  if (!Number.isFinite(date.getTime())) return null;
  return toTaipeiDate(date);
}

function assessmentTime(assessment: PaperAutomationSignal): string {
  const value = assessment.analyzedAt;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : "";
}

function toDashboard(row: PaperTradingAutomation | null) {
  if (!row) {
    return {
      initialized: false,
      enabled: false,
      startingCash: null,
      cash: null,
      equity: null,
      riskPerTradePercent: 0.5,
      dailyLossLimitPercent: 2,
      maxOpenPositions: 3,
      futuresEnabled: false,
      futuresContract: "TMF",
      futuresEntryMode: "convergent",
      futuresForceEntryEnabled: false,
      dailyStopTriggered: false,
      dailyStartEquity: null,
      positions: [],
      pendingEntries: [],
      events: [],
      currentFuturesEvaluation: null,
      futuresDecisionLogs: [],
      futuresPerformance: {
        ...emptyFuturesPerformance(),
        winRatePercent: null,
      },
      lastProcessedAt: null,
      disclaimer: DISCLAIMER,
    };
  }
  const state = row.state ?? emptyState();
  const futuresPerformance = {
    ...(state.futuresPerformance ??
      summarizeFuturesEvents(state.events ?? [], row.futuresForceEntryEnabled)),
    adaptiveStrategy:
      state.futuresPerformance?.adaptiveStrategy ??
      emptyAdaptiveFuturesStrategyState(),
  };
  const cash = numberValue(row.cash);
  const currentDay = state.dailyDate === toTaipeiDate();
  return {
    initialized: true,
    enabled: row.enabled,
    startingCash: numberValue(row.startingCash),
    cash,
    equity: accountEquity(cash, state.positions),
    riskPerTradePercent: numberValue(row.riskPerTradePercent),
    dailyLossLimitPercent: numberValue(row.dailyLossLimitPercent),
    maxOpenPositions: row.maxOpenPositions,
    futuresEnabled: row.futuresEnabled,
    futuresContract: row.futuresContract as keyof typeof FUTURES_CONTRACTS,
    futuresEntryMode: row.futuresEntryMode as PaperFuturesEntryMode,
    futuresForceEntryEnabled: row.futuresForceEntryEnabled,
    dailyStopTriggered: state.dailyDate === toTaipeiDate() && state.dailyStopTriggered,
    dailyStartEquity: currentDay
      ? state.dailyStartEquity
      : accountEquity(cash, state.positions),
    positions: state.positions,
    pendingEntries: state.pendingEntries,
    events: state.events,
    currentFuturesEvaluation: state.currentFuturesEvaluation ?? null,
    futuresDecisionLogs: state.futuresDecisionLogs ?? [],
    futuresPerformance: {
      closedTrades: futuresPerformance.closedTrades,
      wins: futuresPerformance.wins,
      losses: futuresPerformance.losses,
      breakeven: futuresPerformance.breakeven,
      realizedPnl: futuresPerformance.realizedPnl,
      winRatePercent: futuresPerformance.wins + futuresPerformance.losses > 0
        ? Math.round(futuresPerformance.wins / (futuresPerformance.wins + futuresPerformance.losses) * 1000) / 10
        : null,
      consecutiveStopLosses: futuresPerformance.consecutiveStopLosses,
      adjustmentStatus: row.futuresEntryMode === "aggressive"
        ? futuresPerformance.adaptiveStrategy.status === "locked"
          ? "applied"
          : "pending"
        : futuresPerformance.adjustmentStatus,
      adjustmentAt: futuresPerformance.adjustmentAt,
      adjustmentMessage: row.futuresEntryMode === "aggressive"
        ? adaptiveFuturesStrategyMessage(futuresPerformance.adaptiveStrategy)
        : futuresPerformance.adjustmentMessage,
    },
    lastProcessedAt: state.lastProcessedAt,
    disclaimer: DISCLAIMER,
  };
}

export async function getPaperTradingAutomation(userId: string) {
  const [row] = await db
    .select()
    .from(paperTradingAutomationTable)
    .where(eq(paperTradingAutomationTable.userId, userId))
    .limit(1);
  return toDashboard(row ?? null);
}

export async function savePaperTradingAutomationSettings(
  userId: string,
  input: PaperAutomationSettingsInput,
) {
  if (
    !Number.isFinite(input.riskPerTradePercent) ||
    input.riskPerTradePercent < 0.1 ||
    input.riskPerTradePercent > 1 ||
    !Number.isFinite(input.dailyLossLimitPercent) ||
    input.dailyLossLimitPercent < 0.5 ||
    input.dailyLossLimitPercent > 5 ||
    !Number.isInteger(input.maxOpenPositions) ||
    input.maxOpenPositions < 1 ||
    input.maxOpenPositions > 5 ||
    typeof input.futuresEnabled !== "boolean" ||
    !Object.hasOwn(FUTURES_CONTRACTS, input.futuresContract) ||
    !["aggressive", "convergent"].includes(input.futuresEntryMode) ||
    (input.futuresForceEntryEnabled !== undefined && typeof input.futuresForceEntryEnabled !== "boolean")
  ) {
    throw new PaperAutomationError("風控設定超出允許範圍。");
  }
  const [existing] = await db
    .select()
    .from(paperTradingAutomationTable)
    .where(eq(paperTradingAutomationTable.userId, userId))
    .limit(1);
  if (existing) {
    if (input.startingCash !== undefined && input.startingCash !== numberValue(existing.startingCash)) {
      throw new PaperAutomationError("模擬本金建立後不能直接更改；請保留現有帳本。", 409);
    }
    const [updated] = await db
      .update(paperTradingAutomationTable)
      .set({
        riskPerTradePercent: input.riskPerTradePercent.toFixed(2),
        dailyLossLimitPercent: input.dailyLossLimitPercent.toFixed(2),
        maxOpenPositions: input.maxOpenPositions,
        futuresEnabled: input.futuresEnabled,
        futuresContract: input.futuresContract,
        futuresEntryMode: input.futuresEntryMode,
        futuresForceEntryEnabled: input.futuresForceEntryEnabled ?? false,
        updatedAt: new Date(),
      })
      .where(eq(paperTradingAutomationTable.userId, userId))
      .returning();
    return toDashboard(updated ?? existing);
  }

  const startingCash = input.startingCash ?? 1_000_000;
  if (!Number.isFinite(startingCash) || startingCash < 100_000 || startingCash > 100_000_000) {
    throw new PaperAutomationError("模擬本金需介於 100,000 至 100,000,000 元。");
  }
  const [created] = await db
    .insert(paperTradingAutomationTable)
    .values({
      userId,
      enabled: false,
      startingCash: startingCash.toFixed(2),
      cash: startingCash.toFixed(2),
      riskPerTradePercent: input.riskPerTradePercent.toFixed(2),
      dailyLossLimitPercent: input.dailyLossLimitPercent.toFixed(2),
      maxOpenPositions: input.maxOpenPositions,
      futuresEnabled: input.futuresEnabled,
      futuresContract: input.futuresContract,
      futuresEntryMode: input.futuresEntryMode,
      futuresForceEntryEnabled: input.futuresForceEntryEnabled ?? false,
      state: emptyState(),
    })
    .onConflictDoNothing({ target: paperTradingAutomationTable.userId })
    .returning();
  if (!created) throw new PaperAutomationError("模擬帳本已在其他工作階段建立，請重新載入。", 409);
  return toDashboard(created);
}

export async function setPaperTradingAutomationEnabled(userId: string, enabled: boolean) {
  const [row] = await db
    .select()
    .from(paperTradingAutomationTable)
    .where(eq(paperTradingAutomationTable.userId, userId))
    .limit(1);
  if (!row) throw new PaperAutomationError("請先建立自動模擬帳本。", 409);
  const state = structuredClone(row.state ?? emptyState());
  const today = toTaipeiDate();
  if (enabled) {
    if (state.dailyDate === today && state.dailyStopTriggered) {
      throw new PaperAutomationError("今日已觸及虧損上限；明日再啟用新進場。", 409);
    }
    if (!row.futuresEnabled) {
      const [agent] = await db
        .select({ id: aiStockResearchAgentsTable.id })
        .from(aiStockResearchAgentsTable)
        .where(and(
          eq(aiStockResearchAgentsTable.userId, userId),
          eq(aiStockResearchAgentsTable.enabled, true),
        ))
        .limit(1);
      if (!agent) throw new PaperAutomationError("請啟用臺指期自動模擬，或先啟用至少一位個股研究 Agent。", 409);
    }
  }
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.dailyStartEquity = accountEquity(numberValue(row.cash), state.positions);
    state.dailyStopTriggered = false;
  }
  if (!enabled && state.pendingEntries.length) {
    for (const pending of state.pendingEntries) {
      addEvent(state, {
        agentId: pending.agentId,
        ticker: pending.ticker,
        ...(pending.assetClass ? { assetClass: pending.assetClass } : {}),
        ...(pending.contractType ? { contractType: pending.contractType } : {}),
        ...(pending.direction ? { direction: pending.direction } : {}),
        kind: "skipped",
        side: pending.direction === "short" ? "sell" : "buy",
        shares: null,
        ...(pending.assetClass === "futures" ? { contracts: null } : {}),
        price: null,
        reason: "已暫停自動進場，待成交訊號已取消。",
      });
    }
    state.pendingEntries = [];
  }
  const [updated] = await db
    .update(paperTradingAutomationTable)
    .set({ enabled, state, updatedAt: new Date() })
    .where(eq(paperTradingAutomationTable.userId, userId))
    .returning();
  return toDashboard(updated ?? row);
}

export async function queuePaperAutomationSignal(input: {
  userId: string;
  agentId: string;
  ticker: string;
  name: string;
  assessment: PaperAutomationSignal;
}): Promise<void> {
  const [config] = await db
    .select({ enabled: paperTradingAutomationTable.enabled })
    .from(paperTradingAutomationTable)
    .where(eq(paperTradingAutomationTable.userId, input.userId))
    .limit(1);
  if (!config?.enabled) return;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(paperTradingAutomationTable)
      .where(eq(paperTradingAutomationTable.userId, input.userId))
      .for("update")
      .limit(1);
    if (!row?.enabled) return;
    const state = structuredClone(row.state ?? emptyState());
    const marketDate = marketDateFromAssessment(input.assessment);
    const signalAsOf = assessmentTime(input.assessment);
    if (signalAsOf && state.events.some((event) =>
      event.agentId === input.agentId &&
      (event.kind === "signal_queued" || event.kind === "skipped") &&
      event.asOf === signalAsOf
    )) return;
    const check = validatePaperAutomationSignal(input.assessment);
    if (!marketDate || !check.eligible) {
      if (input.assessment.action === "buy") {
        addEvent(state, {
          agentId: input.agentId,
          ticker: input.ticker,
          kind: "skipped",
          side: null,
          shares: null,
          price: null,
          ...(signalAsOf ? { asOf: signalAsOf } : {}),
          reason: !marketDate
            ? "判讀日期無效，未建立模擬委託。"
            : check.eligible
              ? "判讀未通過模擬委託資格檢查。"
              : check.reason,
        });
      }
      await tx.update(paperTradingAutomationTable)
        .set({ state, updatedAt: new Date() })
        .where(eq(paperTradingAutomationTable.userId, input.userId));
      return;
    }

    if (!signalAsOf) return;
    const alreadyTracked = [
      ...state.pendingEntries.map((entry) => entry.signalAsOf),
      ...state.positions.map((position) => position.signalAsOf),
      ...state.events.filter((event) => event.agentId === input.agentId && event.kind === "signal_queued")
        .map((event) => event.asOf),
    ].includes(signalAsOf);
    if (alreadyTracked) return;
    if (state.positions.some((position) => position.ticker === input.ticker) ||
      state.pendingEntries.some((entry) => entry.ticker === input.ticker)) {
      addEvent(state, {
        agentId: input.agentId,
        ticker: input.ticker,
        kind: "skipped",
        side: null,
        shares: null,
        price: null,
        reason: "同一標的已有模擬持倉或待成交進場。",
      });
    } else {
      const pending = {
        id: randomUUID(),
        agentId: input.agentId,
        ticker: input.ticker,
        name: input.name,
        entryPrice: Number(input.assessment.entryPrice),
        stopLossPrice: Number(input.assessment.stopLossPrice),
        takeProfitPrice: Number(input.assessment.takeProfitPrice),
        signalAsOf,
        marketDate,
        expiresAt: new Date(Date.now() + SIGNAL_LIFETIME_MS).toISOString(),
      };
      state.pendingEntries.unshift(pending);
      addEvent(state, {
        agentId: input.agentId,
        ticker: input.ticker,
        kind: "signal_queued",
        side: "buy",
        shares: null,
        price: pending.entryPrice,
        asOf: signalAsOf,
        reason: "AI 買進方案通過樣本數與信賴下限檢查；等待盤中價格回到條件進場價。",
      });
    }
    await tx.update(paperTradingAutomationTable)
      .set({ state, updatedAt: new Date() })
      .where(eq(paperTradingAutomationTable.userId, input.userId));
  });
}

async function getFreshQuote(ticker: string, now: Date): Promise<StockQuoteData | null> {
  try {
    const quote = await getStockQuote(ticker, exchangeForTicker(ticker));
    return isFreshSessionQuote(quote, now) ? quote : null;
  } catch {
    return null;
  }
}

async function getFreshFuturesQuote(now: Date): Promise<StockQuoteData | null> {
  const session = resolveFuturesSession(now.getTime());
  if (!session.active) return null;
  try {
    const data = await fetchFuturesDayIntraday();
    const asOf = data.asOf;
    if (
      !asOf ||
      typeof data.price !== "number" ||
      !Number.isFinite(data.price) ||
      data.price <= 0 ||
      !isFuturesSessionQuoteTimestamp(asOf.getTime(), session, now.getTime()) ||
      now.getTime() - asOf.getTime() < -60_000 ||
      now.getTime() - asOf.getTime() > MAX_FUTURES_QUOTE_AGE_MS
    ) return null;
    return {
      name: "臺指期 TX 連續行情",
      price: data.price,
      previousClose: null,
      change: data.change,
      changePercent: data.changePercent,
      source: data.source,
      asOf,
      available: true,
      error: null,
    };
  } catch {
    return null;
  }
}

function dateTimeMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function resolveReadyFuturesEntry(
  strategy: FuturesAiDayStrategy | null,
  quote: StockQuoteData | null,
  now: Date,
  forceEntry: boolean,
  sessionSymbol: "TXF1" | "TXF8",
): PaperFuturesEntryDecision | null {
  const strategyQuote = sessionSymbol === "TXF8"
    ? strategy?.nightQuote
    : strategy?.dayQuote;
  if (
    !strategy ||
    !quote?.price ||
    !quote.asOf ||
    !strategyQuote ||
    strategyQuote.price === null
  ) return null;
  const decision = resolvePaperFuturesEntry({
    forceEntry,
    status: strategy.status,
    action: strategy.action,
    entryPlanStatus: strategy.entryPlanStatus,
    entryPlanMode: strategy.entryPlanMode,
    planDirection: strategy.planDirection,
    currentPrice: quote.price,
    plannedEntryPrice: strategy.entryPrice,
    stopLossPrice: strategy.stopLossPrice,
    targetPrice: strategy.targetPrice,
  });
  if (!decision) return null;
  const analyzedAt = dateTimeMillis(strategy.analyzedAt);
  const strategyQuoteAt = dateTimeMillis(strategyQuote.asOf);
  if (
    !Number.isFinite(analyzedAt) ||
    !Number.isFinite(strategyQuoteAt) ||
    now.getTime() - analyzedAt < -60_000 ||
    now.getTime() - analyzedAt > MAX_FUTURES_QUOTE_AGE_MS ||
    Math.abs(now.getTime() - strategyQuoteAt) > MAX_FUTURES_QUOTE_AGE_MS ||
    Math.abs(quote.asOf.getTime() - strategyQuoteAt) > MAX_FUTURES_QUOTE_AGE_MS ||
    strategyQuote.price === null ||
    Math.abs(quote.price - strategyQuote.price) > 5
  ) return null;
  return decision;
}

async function getAutomationFuturesStrategy(
  now: Date,
  entryMode: PaperFuturesEntryMode,
  forceEntry: boolean,
  sessionSymbol: "TXF1" | "TXF8",
  adjustmentFeedback?: FuturesStrategyAdjustmentFeedback,
  adaptiveStrategyId?: AggressiveFuturesStrategyId,
): Promise<FuturesAiDayStrategy | null> {
  for (const [key, cached] of cachedAutomationFuturesStrategies) {
    if (now.getTime() - cached.lastAttemptAt > 30 * 60_000) {
      cachedAutomationFuturesStrategies.delete(key);
    }
  }
  const feedbackHash = adjustmentFeedback
    ? JSON.stringify(adjustmentFeedback)
    : "base";
  const cacheKey = `${futuresStrategyKey(entryMode, forceEntry, sessionSymbol)}:${adaptiveStrategyId ?? "default"}:${feedbackHash}`;
  const cached = cachedAutomationFuturesStrategies.get(cacheKey);
  const retryIntervalMs = cached
    ? futuresStrategyRetryIntervalMs(cached.failureCount)
    : 0;
  if (
    cached &&
    now.getTime() - cached.lastAttemptAt < retryIntervalMs
  ) {
    return cached.strategy;
  }
  const previousFailureCount = cached?.failureCount ?? 0;
  cachedAutomationFuturesStrategies.set(cacheKey, {
    lastAttemptAt: now.getTime(),
    strategy: null,
    failureCount: previousFailureCount,
  });
  try {
    const strategy = await getFuturesAiDayStrategy(
      entryMode,
      forceEntry,
      adjustmentFeedback,
      adaptiveStrategyId,
    );
    cachedAutomationFuturesStrategies.set(cacheKey, {
      lastAttemptAt: now.getTime(),
      strategy,
      failureCount: 0,
    });
  } catch {
    cachedAutomationFuturesStrategies.set(cacheKey, {
      lastAttemptAt: now.getTime(),
      strategy: null,
      failureCount: previousFailureCount + 1,
    });
  }
  return cachedAutomationFuturesStrategies.get(cacheKey)?.strategy ?? null;
}

function futuresEvaluationForAccount(input: {
  current: PaperTradingAutomation;
  state: PaperAutomationState;
  cash: number;
  session: ReturnType<typeof resolveFuturesSession>;
  now: Date;
  quote: StockQuoteData | null;
  strategy: FuturesAiDayStrategy | null;
  entry: PaperFuturesEntryDecision | null;
  strategyReviewPending: boolean;
}): Omit<PaperFuturesEvaluation, "id" | "asOf"> {
  const { current, state, cash, session, now, quote, strategy, entry, strategyReviewPending } = input;
  const action = strategy?.action ?? null;
  const direction = strategy?.planDirection ?? null;
  const price = quote?.price ?? null;
  const levels = {
    action,
    direction,
    price,
    entryPrice: entry?.entryPrice ?? strategy?.entryPrice ?? null,
    stopLossPrice: strategy?.stopLossPrice ?? null,
    targetPrice: strategy?.targetPrice ?? null,
  };
  const result = (
    status: PaperFuturesEvaluation["status"],
    reason: string,
  ): Omit<PaperFuturesEvaluation, "id" | "asOf"> => ({ ...levels, status, reason });

  if (!current.futuresEnabled) return result("inactive", "臺指期紙上模擬未啟用。");
  if (!current.enabled) return result("inactive", "自動進場已暫停；現有持倉仍按新鮮行情監控。");
  if (!session.active) return result("waiting", "目前非期貨交易時段，等待下一筆有效行情。");
  if (session.symbol !== "TXF1" && session.symbol !== "TXF8") {
    return result("waiting", "目前行情不是可用的期貨連續月報價，暫不評估新進場。");
  }
  if (
    session.symbol === "TXF1" &&
    !isFuturesDayEntryTime(taipeiMinuteOfDay(now))
  ) {
    return result("blocked", "已超過臺指期日盤新進場時段。");
  }
  if (
    session.symbol === "TXF8" &&
    !isFuturesNightEntryTime(taipeiMinuteOfDay(now))
  ) {
    return result("blocked", "已超過臺指期夜盤新進場時段。");
  }
  if (state.dailyStopTriggered) return result("blocked", "已觸發每日虧損上限，暫停新增進場。");
  if (state.positions.some((position) => position.assetClass === "futures")) {
    return result("blocked", "目前已有臺指期模擬持倉，持續監控停損與停利，不重複進場。");
  }
  if (state.pendingEntries.some((pending) => pending.assetClass === "futures")) {
    return result("waiting", "AI 方案已列入待處理進場，等待價格確認或風控結果。");
  }
  if (strategyReviewPending) {
    return result("waiting", "連續停損達 3 次，等待 AI 參考近期結果重新評估；期間不沿用舊策略進場。");
  }
  if (!quote?.price || !quote.asOf) {
    return result("waiting", `尚未取得 90 秒內的新鮮${session.label}期貨行情。`);
  }
  if (!strategy) return result("unavailable", "AI 策略暫時沒有可用結果，稍後重新評估。");
  if (strategy.status !== "available") {
    return result("waiting", strategy.entryPlanMessage || "AI 判斷所需的即時資料不足，等待資料補齊。");
  }
  if (strategy.action !== "long" && strategy.action !== "short") {
    return result(
      "waiting",
      strategy.action === "wait"
        ? "AI 目前判斷等待，沒有多空進場訊號；強制模式也不會猜方向。"
        : "AI 判斷資料不足，沒有可執行的多空方向。",
    );
  }
  if (!entry) {
    if (
      current.futuresForceEntryEnabled &&
      strategy.targetPrice !== null &&
      strategy.entryPrice !== null &&
      Math.abs(strategy.targetPrice - quote.price) < PAPER_FORCE_ENTRY_MIN_TARGET_POINTS
    ) {
      return result(
        "blocked",
        `AI 停利距離未達 ${PAPER_FORCE_ENTRY_MIN_TARGET_POINTS} 點最低門檻，暫不強制進場。`,
      );
    }
    if (strategy.entryPlanStatus !== "available") {
      return result("blocked", strategy.entryPlanMessage || "AI 價位方案尚未通過檢查。");
    }
    return result("blocked", "AI 方向已產生，但方案方向、行情時間或價位順序未通過檢查。");
  }
  if (state.positions.length >= current.maxOpenPositions) {
    return result("blocked", `目前持倉已達 ${current.maxOpenPositions} 個標的上限。`);
  }

  const contract = FUTURES_CONTRACTS[current.futuresContract as keyof typeof FUTURES_CONTRACTS];
  const riskPerContract = Math.abs(entry.entryPrice - entry.stopLossPrice) * contract.multiplier;
  const equity = accountEquity(cash, state.positions);
  const riskBudget = equity * numberValue(current.riskPerTradePercent) / 100;
  const contracts = calculatePaperFuturesContracts({
    equity,
    riskPerTradePercent: numberValue(current.riskPerTradePercent),
    entryPrice: entry.entryPrice,
    stopLossPrice: entry.stopLossPrice,
    contractMultiplier: contract.multiplier,
  });
  if (contracts <= 0) {
    return result(
      "blocked",
      `單口風險約 NT$${Math.round(riskPerContract).toLocaleString("zh-TW")}，高於單筆額度 NT$${Math.round(riskBudget).toLocaleString("zh-TW")}；保留風控，不進場。`,
    );
  }
  return result(
    "ready",
    `AI 判斷${entry.direction === "long" ? "做多" : "做空"}，行情與價位檢查通過；依單筆風險上限最多模擬 ${contracts} 口。`,
  );
}

async function processAutomationAccount(
  row: PaperTradingAutomation,
  quoteByTicker: Map<string, StockQuoteData | null>,
  futuresQuote: StockQuoteData | null,
  futuresStrategies: Map<string, FuturesStrategyForAccount>,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(paperTradingAutomationTable)
      .where(eq(paperTradingAutomationTable.userId, row.userId))
      .for("update")
      .limit(1);
    if (!current) return;
    const state = structuredClone(current.state ?? emptyState());
    state.futuresDecisionLogs ??= [];
    state.futuresPerformance ??= summarizeFuturesEvents(
      state.events ?? [],
      current.futuresForceEntryEnabled || current.futuresEntryMode === "aggressive",
    );
    state.futuresPerformance.adaptiveStrategy ??=
      emptyAdaptiveFuturesStrategyState();
    let cash = numberValue(current.cash);
    const today = toTaipeiDate(now);
    const futuresSession = resolveFuturesSession(now.getTime());
    const shouldFlattenFutures =
      futuresSession.active &&
      ((futuresSession.symbol === "TXF1" &&
        shouldFlattenFuturesDayPosition(taipeiMinuteOfDay(now))) ||
        (futuresSession.symbol === "TXF8" &&
          shouldFlattenFuturesNightPosition(taipeiMinuteOfDay(now))));
    if (state.dailyDate !== today) {
      state.dailyDate = today;
      state.dailyStartEquity = accountEquity(
        cash,
        state.positions.map((position) => ({
          ...position,
          lastPrice: quoteByTicker.get(position.ticker)?.price ??
            (position.assetClass === "futures"
              ? futuresQuote?.price ?? position.lastPrice
              : position.lastPrice),
        })),
      );
      state.dailyStopTriggered = false;
    }

    const remainingPositions = [];
    for (const position of state.positions) {
      const quote = position.assetClass === "futures"
        ? futuresQuote
        : quoteByTicker.get(position.ticker);
      if (!quote || quote.price === null || !quote.asOf) {
        remainingPositions.push(position);
        continue;
      }
      position.lastPrice = quote.price;
      position.lastQuoteAt = quote.asOf.toISOString();
      position.quoteSource = quote.source;
      const direction = position.direction ?? "long";
      const thresholdExit = position.assetClass === "futures"
        ? paperFuturesExitReason(
            quote.price,
            direction,
            position.stopLossPrice,
            position.takeProfitPrice,
          )
        : paperAutomationExitReason(
            quote.price,
            position.stopLossPrice,
            position.takeProfitPrice,
          );
      const exitReason = thresholdExit ??
        (position.assetClass === "futures" && shouldFlattenFutures
          ? "session_end"
          : null);
      if (!exitReason) {
        remainingPositions.push(position);
        continue;
      }
      let exitPrice = quote.price;
      let realizedPnl: number;
      if (position.assetClass === "futures") {
        const pointValue = position.contractMultiplier ?? 0;
        realizedPnl = calculateRealizedPaperTradePnl({
          assetClass: "futures",
          shares: position.shares,
          entryPrice: position.entryPrice,
          exitPrice: quote.price,
          direction,
          contractMultiplier: pointValue,
          isFundOrEtf: false,
        });
        cash += realizedPnl;
        state.futuresPerformance = recordPaperFuturesExit(state.futuresPerformance, {
          exitReason,
          direction,
          entryPrice: position.entryPrice,
          exitPrice: quote.price,
          stopLossPrice: position.stopLossPrice,
          realizedPnl,
          asOf: quote.asOf.toISOString(),
          adaptiveStrategyId: position.adaptiveStrategyId,
        },
        FUTURES_STOP_LOSS_REVIEW_THRESHOLD,
        current.futuresForceEntryEnabled || current.futuresEntryMode === "aggressive",
      );
      } else {
        const costs = calculatePaperTradeCosts({
          side: "sell",
          shares: position.shares,
          price: quote.price,
          isFundOrEtf: isFundOrEtf(position.ticker),
        });
        cash += costs.grossAmount - costs.commission - costs.transactionTax;
        exitPrice = costs.price;
        realizedPnl = calculateRealizedPaperTradePnl({
          assetClass: "equity",
          shares: position.shares,
          entryPrice: position.entryPrice,
          exitPrice: quote.price,
          direction,
          isFundOrEtf: isFundOrEtf(position.ticker),
        });
      }
      cash = Math.round(cash * 100) / 100;
      addEvent(state, {
        agentId: position.agentId,
        ticker: position.ticker,
        ...(position.assetClass ? { assetClass: position.assetClass } : {}),
        ...(position.contractType ? { contractType: position.contractType } : {}),
        ...(position.direction ? { direction: position.direction } : {}),
        ...(position.adaptiveStrategyId
          ? { adaptiveStrategyId: position.adaptiveStrategyId }
          : {}),
        ...(position.assetClass === "futures" ? { contracts: position.shares } : {}),
        exitReason,
        entryPrice: position.entryPrice,
        stopLossPrice: position.stopLossPrice,
        realizedPnl,
        kind: "exit_filled",
        side: position.assetClass === "futures" && direction === "short" ? "buy" : "sell",
        shares: position.shares,
        price: exitPrice,
        asOf: quote.asOf.toISOString(),
        reason: exitReason === "session_end"
          ? `臺指期${futuresSession.label}接近收盤，依最新有效行情模擬平倉，避免跨時段留倉。`
          : exitReason === "stop_loss"
          ? position.assetClass === "futures"
            ? `臺指期${direction === "long" ? "多單" : "空單"}行情觸及停損線，已依每點 NT$${position.contractMultiplier} 模擬結算。`
            : "即時行情觸及停損線，已記錄模擬賣出。"
          : position.assetClass === "futures"
            ? `臺指期${direction === "long" ? "多單" : "空單"}行情觸及停利線，已依每點 NT$${position.contractMultiplier} 模擬結算。`
            : "即時行情觸及停利線，已記錄模擬賣出。",
      });
    }
    state.positions = remainingPositions;

    let equity = accountEquity(cash, state.positions);
    if (
      !state.dailyStopTriggered &&
      state.dailyStartEquity !== null &&
      equity <= state.dailyStartEquity * (1 - numberValue(current.dailyLossLimitPercent) / 100)
    ) {
      state.dailyStopTriggered = true;
      addEvent(state, {
        agentId: null,
        ticker: null,
        kind: "halted",
        side: null,
        shares: null,
        price: equity,
        asOf: now.toISOString(),
        reason: "帳戶觸及當日虧損上限；今日暫停新增模擬部位，仍會監控停損與停利。",
      });
    }

    const performance = state.futuresPerformance;
    const feedback = futuresAdjustmentFeedback(
      performance,
      current.futuresEntryMode === "aggressive",
    );
    if (
      current.futuresForceEntryEnabled &&
      feedback &&
      performance.lastAdjustedStreakId !== performance.stopLossStreakId &&
      performance.adjustmentStatus !== "pending"
    ) {
      performance.adjustmentStatus = "pending";
      performance.adjustmentMessage =
        `連續停損已達 ${FUTURES_STOP_LOSS_REVIEW_THRESHOLD} 次，等待 AI 依近期結果重新評估。`;
      performance.adjustmentFeedback = {
        streakId: performance.stopLossStreakId,
        consecutiveStopLosses: feedback.consecutiveStopLosses,
        recentStopLosses: feedback.recentStopLosses.slice(-FUTURES_STOP_LOSS_REVIEW_THRESHOLD),
      };
    } else if (!current.futuresForceEntryEnabled && performance.adjustmentStatus === "pending") {
      performance.adjustmentStatus = "idle";
      performance.adjustmentMessage = "強制進場模式已關閉，暫停 AI 策略重新評估。";
    }
    const accountStrategyResult = futuresStrategies.get(`account:${row.userId}`);
    const expectedAdaptiveStrategyId =
      current.futuresEntryMode === "aggressive"
        ? resolveAggressiveFuturesStrategy(performance.adaptiveStrategy).id
        : undefined;
    const baseStrategyResult = futuresStrategies.get(futuresStrategyKey(
      current.futuresEntryMode as PaperFuturesEntryMode,
      current.futuresForceEntryEnabled,
      futuresSession.symbol,
      expectedAdaptiveStrategyId,
    ));
    const strategyResult = accountStrategyResult ?? baseStrategyResult;
    const futuresStrategy = strategyResult?.strategy ?? null;
    const hasFreshAdjustment =
      Boolean(feedback) &&
      strategyResult?.adjustedForStreakId === performance.stopLossStreakId &&
      Boolean(futuresStrategy?.aiProvider);
    const strategyDoesNotMatchActiveVariant =
      Boolean(expectedAdaptiveStrategyId) &&
      strategyResult?.adaptiveStrategyId !== expectedAdaptiveStrategyId;
    const strategyReviewPending =
      (Boolean(feedback) &&
        (current.futuresForceEntryEnabled || current.futuresEntryMode === "aggressive") &&
        !hasFreshAdjustment) ||
      strategyDoesNotMatchActiveVariant;
    if (
      hasFreshAdjustment &&
      performance.lastAdjustedStreakId !== performance.stopLossStreakId
    ) {
      performance.lastAdjustedStreakId = performance.stopLossStreakId;
      performance.lastAdjustedStopLossCount = performance.consecutiveStopLosses;
      performance.adjustmentStatus = "applied";
      performance.adjustmentAt = now.toISOString();
      performance.adjustmentMessage =
        `AI 已依連續 ${performance.consecutiveStopLosses} 次停損重新評估；風險上限未變更。`;
    }
    const futuresEntry = strategyReviewPending
      ? null
      : resolveReadyFuturesEntry(
          futuresStrategy,
          futuresQuote,
          now,
          current.futuresForceEntryEnabled,
          futuresSession.symbol,
        );
    updateFuturesEvaluation(state, futuresEvaluationForAccount({
      current,
      state,
      cash,
      session: futuresSession,
      now,
      quote: futuresQuote,
      strategy: futuresStrategy,
      entry: futuresEntry,
      strategyReviewPending,
    }), now);
    if (
      current.enabled &&
      current.futuresEnabled &&
      futuresSession.active &&
      ((futuresSession.symbol === "TXF1" &&
        isFuturesDayEntryTime(taipeiMinuteOfDay(now))) ||
        (futuresSession.symbol === "TXF8" &&
          isFuturesNightEntryTime(taipeiMinuteOfDay(now)))) &&
      !state.dailyStopTriggered &&
      futuresEntry &&
      futuresStrategy
    ) {
      const strategyQuote = futuresSession.symbol === "TXF8"
        ? futuresStrategy.nightQuote
        : futuresStrategy.dayQuote;
      const signalAsOf = new Date(dateTimeMillis(strategyQuote.asOf)).toISOString();
      const direction = futuresEntry.direction;
      const alreadyTracked = [
        ...state.pendingEntries.map((entry) => entry.signalAsOf),
        ...state.positions.map((position) => position.signalAsOf),
        ...state.events
          .filter((event) => event.agentId === "futures-ai" && event.kind === "signal_queued")
          .map((event) => event.asOf),
      ].includes(signalAsOf);
      if (!alreadyTracked && !state.positions.some((position) => position.assetClass === "futures")) {
        const contractType = current.futuresContract as keyof typeof FUTURES_CONTRACTS;
        const contract = FUTURES_CONTRACTS[contractType];
        const pending = {
          id: randomUUID(),
          agentId: "futures-ai",
          ticker: FUTURES_TICKER,
          name: `臺指期${contract.name} ${contractType}`,
          assetClass: "futures" as const,
          contractType,
          direction,
          contractMultiplier: contract.multiplier,
          ...(futuresEntry.forced ? { forcedEntry: true } : {}),
          ...(strategyResult?.adaptiveStrategyId
            ? { adaptiveStrategyId: strategyResult.adaptiveStrategyId }
            : {}),
          entryPrice: futuresEntry.entryPrice,
          stopLossPrice: futuresEntry.stopLossPrice,
          takeProfitPrice: futuresEntry.targetPrice,
          signalAsOf,
          marketDate: toTaipeiDate(new Date(dateTimeMillis(strategyQuote.asOf))),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        };
        state.pendingEntries.unshift(pending);
        addEvent(state, {
          agentId: pending.agentId,
          ticker: pending.ticker,
          assetClass: "futures",
          contractType,
          direction: pending.direction,
          ...(pending.adaptiveStrategyId
            ? { adaptiveStrategyId: pending.adaptiveStrategyId }
            : {}),
          kind: "signal_queued",
          side: direction === "long" ? "buy" : "sell",
          shares: null,
          contracts: null,
          price: pending.entryPrice,
          asOf: signalAsOf,
          reason: futuresEntry.forced
            ? `強制模式依 AI ${futuresSession.label}主觀${direction === "long" ? "多方" : "空方"}方向，按最新有效報價模擬進場；停損停利與帳戶風控仍適用。`
            : `臺指期${futuresSession.label} AI ${direction === "long" ? "多方" : "空方"}訊號通過同時段資料、新鮮度與價位檢查；等待現價確認。`,
        });
      }
    }

    if (!current.enabled) {
      state.pendingEntries = [];
      state.lastProcessedAt = now.toISOString();
      await tx.update(paperTradingAutomationTable)
        .set({ cash: cash.toFixed(2), state, updatedAt: now })
        .where(eq(paperTradingAutomationTable.userId, row.userId));
      return;
    }

    const remainingPending = [];
    for (const pending of state.pendingEntries) {
      const isFutures = pending.assetClass === "futures";
      const direction = pending.direction ?? "long";
      const quote = isFutures ? futuresQuote : quoteByTicker.get(pending.ticker);
      const eventDetails = {
        agentId: pending.agentId,
        ticker: pending.ticker,
        ...(pending.assetClass ? { assetClass: pending.assetClass } : {}),
        ...(pending.contractType ? { contractType: pending.contractType } : {}),
        ...(pending.direction ? { direction: pending.direction } : {}),
        ...(pending.adaptiveStrategyId
          ? { adaptiveStrategyId: pending.adaptiveStrategyId }
          : {}),
      };
      const eventSide = direction === "short" ? "sell" : "buy";
      if (isFutures && !current.futuresEnabled) {
        addEvent(state, {
          ...eventDetails,
          kind: "skipped",
          side: eventSide,
          shares: null,
          contracts: null,
          price: null,
          reason: "臺指期自動模擬已關閉，待成交訊號已取消。",
        });
        continue;
      }
      if (
        isFutures &&
        ((futuresSession.symbol === "TXF1" &&
          !isFuturesDayEntryTime(taipeiMinuteOfDay(now))) ||
          (futuresSession.symbol === "TXF8" &&
            !isFuturesNightEntryTime(taipeiMinuteOfDay(now))))
      ) {
        addEvent(state, {
          ...eventDetails,
          kind: "skipped",
          side: eventSide,
          shares: null,
          contracts: null,
          price: null,
          reason: `已超過臺指期${futuresSession.label}新進場時段，待成交訊號已取消。`,
        });
        continue;
      }
      if (Date.parse(pending.expiresAt) <= now.getTime()) {
        addEvent(state, {
          ...eventDetails,
          kind: "skipped",
          side: eventSide,
          shares: null,
          ...(isFutures ? { contracts: null } : {}),
          price: null,
          reason: isFutures
            ? "期貨訊號超過 60 秒有效期限，未進場。"
            : "條件進場超過有效期限，待成交訊號已取消。",
        });
        continue;
      }
      if (state.dailyStopTriggered) {
        addEvent(state, {
          ...eventDetails,
          kind: "skipped",
          side: eventSide,
          shares: null,
          ...(isFutures ? { contracts: null } : {}),
          price: null,
          reason: "當日虧損上限已觸發，待成交進場已取消。",
        });
        continue;
      }
      if (!quote?.price) {
        remainingPending.push(pending);
        continue;
      }
      const price = quote.price;
      const crossedEntry = direction === "long"
        ? price <= pending.entryPrice
        : price >= pending.entryPrice;
      if (!crossedEntry) {
        remainingPending.push(pending);
        continue;
      }
      const crossedStop = isFutures
        ? direction === "long"
          ? price <= pending.stopLossPrice
          : price >= pending.stopLossPrice
        : price <= pending.stopLossPrice;
      const crossedTarget = isFutures
        ? direction === "long"
          ? price >= pending.takeProfitPrice
          : price <= pending.takeProfitPrice
        : price >= pending.takeProfitPrice;
      if (crossedStop || crossedTarget) {
        addEvent(state, {
          ...eventDetails,
          kind: "skipped",
          side: eventSide,
          shares: null,
          ...(isFutures ? { contracts: null } : {}),
          price,
          asOf: quote.asOf?.toISOString(),
          reason: crossedStop
            ? "最新成交價已越過停損參考，放棄追進。"
            : "最新成交價已越過停利參考，放棄追進。",
        });
        continue;
      }
      if (state.positions.some((position) =>
        isFutures
          ? position.assetClass === "futures"
          : position.ticker === pending.ticker && position.assetClass !== "futures"
      )) {
        addEvent(state, {
          ...eventDetails,
          kind: "skipped",
          side: eventSide,
          shares: null,
          ...(isFutures ? { contracts: null } : {}),
          price,
          asOf: quote.asOf?.toISOString(),
          reason: isFutures
            ? "臺指期已有模擬持倉，取消重複進場。"
            : "該標的已存在模擬持倉，取消重複進場。",
        });
        continue;
      }
      if (state.positions.length >= current.maxOpenPositions) {
        remainingPending.push(pending);
        continue;
      }
      equity = accountEquity(cash, state.positions);
      const shares = isFutures
        ? calculatePaperFuturesContracts({
            equity,
            riskPerTradePercent: numberValue(current.riskPerTradePercent),
            entryPrice: price,
            stopLossPrice: pending.stopLossPrice,
            contractMultiplier: pending.contractMultiplier ?? 0,
          })
        : calculatePaperAutomationShares({
            equity,
            cash,
            riskPerTradePercent: numberValue(current.riskPerTradePercent),
            entryPrice: price,
            stopLossPrice: pending.stopLossPrice,
            sellTaxRate: isFundOrEtf(pending.ticker) ? 0.001 : 0.003,
          });
      if (shares <= 0) {
        addEvent(state, {
          ...eventDetails,
          kind: "skipped",
          side: eventSide,
          shares: null,
          ...(isFutures ? { contracts: null } : {}),
          price,
          asOf: quote.asOf?.toISOString(),
          reason: isFutures
            ? "依單筆風險上限計算，每口期貨風險已超過額度；未建立模擬部位。"
            : "依單筆風險上限與整張股數計算後，資金不足一張；未建立模擬部位。",
        });
        continue;
      }
      const costs = isFutures
        ? null
        : calculatePaperTradeCosts({
            side: "buy",
            shares,
            price,
            isFundOrEtf: isFundOrEtf(pending.ticker),
          });
      if (costs) {
        const totalCost = costs.grossAmount + costs.commission;
        if (totalCost > cash) {
          addEvent(state, {
            ...eventDetails,
            kind: "skipped",
            side: eventSide,
            shares: null,
            price,
            asOf: quote.asOf?.toISOString(),
            reason: "可用模擬現金不足，未建立模擬部位。",
          });
          continue;
        }
        cash = Math.round((cash - totalCost) * 100) / 100;
      }
      state.positions.push({
        id: randomUUID(),
        agentId: pending.agentId,
        ticker: pending.ticker,
        name: pending.name,
        shares,
        ...(pending.assetClass ? { assetClass: pending.assetClass } : { assetClass: "equity" as const }),
        ...(pending.contractType ? { contractType: pending.contractType } : {}),
        ...(pending.direction ? { direction: pending.direction } : {}),
        ...(pending.contractMultiplier ? { contractMultiplier: pending.contractMultiplier } : {}),
        ...(pending.adaptiveStrategyId
          ? { adaptiveStrategyId: pending.adaptiveStrategyId }
          : {}),
        entryPrice: costs?.price ?? price,
        stopLossPrice: pending.stopLossPrice,
        takeProfitPrice: pending.takeProfitPrice,
        entryAt: quote.asOf?.toISOString() ?? now.toISOString(),
        signalAsOf: pending.signalAsOf,
        quoteSource: quote.source,
        lastPrice: price,
        lastQuoteAt: quote.asOf?.toISOString() ?? now.toISOString(),
      });
      addEvent(state, {
        ...eventDetails,
        ...(isFutures ? { contracts: shares } : {}),
        kind: "entry_filled",
        side: eventSide,
        shares,
        price: costs?.price ?? price,
        asOf: quote.asOf?.toISOString(),
        reason: isFutures
          ? pending.forcedEntry
            ? `強制模式依 AI 主觀${direction === "long" ? "多方" : "空方"}方向，以最新有效行情模擬進場 ${shares} 口；仍按每筆風險上限計算，未扣保證金與交易費用。`
            : `臺指期${pending.direction === "long" ? "多單" : "空單"}已按每口風險上限模擬進場 ${shares} 口；未扣保證金與交易費用。`
          : "已到達條件進場價；按單筆風險上限建立模擬買進。",
      });
    }
    state.pendingEntries = remainingPending;
    state.lastProcessedAt = now.toISOString();
    await tx.update(paperTradingAutomationTable)
      .set({ cash: cash.toFixed(2), state, updatedAt: now })
      .where(eq(paperTradingAutomationTable.userId, row.userId));
  });
}

export async function runPaperTradingAutomationCycle(now = new Date()): Promise<void> {
  const futuresSession = resolveFuturesSession(now.getTime());
  const rows = await db
    .select()
    .from(paperTradingAutomationTable)
    .where(eq(paperTradingAutomationTable.enabled, true));
  const openAccounts = await db
    .select()
    .from(paperTradingAutomationTable)
    .where(eq(paperTradingAutomationTable.enabled, false));
  const eligibleRows = [
    ...rows,
    ...openAccounts.filter((row) =>
      row.state.positions.length > 0 || row.futuresEnabled
    ),
  ];
  if (!eligibleRows.length) return;
  const shouldReadFutures = eligibleRows.some((row) =>
    row.futuresEnabled && row.enabled ||
    row.state.positions.some((position) => position.assetClass === "futures"),
  );
  const futuresQuote = shouldReadFutures
    ? await getFreshFuturesQuote(now)
    : null;
  const futuresStrategies = new Map<string, FuturesStrategyForAccount>();
  const futuresEntryTime = futuresSession.symbol === "TXF1"
    ? isFuturesDayEntryTime(taipeiMinuteOfDay(now))
    : isFuturesNightEntryTime(taipeiMinuteOfDay(now));
  if (futuresSession.active && futuresEntryTime) {
    const activeConfigs = new Map<string, {
      entryMode: PaperFuturesEntryMode;
      forceEntry: boolean;
      adaptiveStrategyId?: AggressiveFuturesStrategyId;
    }>();
    for (const row of eligibleRows.filter((candidate) => candidate.enabled && candidate.futuresEnabled)) {
      const entryMode = row.futuresEntryMode as PaperFuturesEntryMode;
      const forceEntry = row.futuresForceEntryEnabled;
      const performance = row.state.futuresPerformance ??
        summarizeFuturesEvents(
          row.state.events ?? [],
          row.futuresForceEntryEnabled || row.futuresEntryMode === "aggressive",
        );
      const adaptiveEnabled = entryMode === "aggressive";
      const adaptiveState = performance.adaptiveStrategy ??
        emptyAdaptiveFuturesStrategyState();
      const adaptiveStrategyId = adaptiveEnabled
        ? resolveAggressiveFuturesStrategy(adaptiveState).id
        : undefined;
      const feedback = adaptiveEnabled
        ? adaptiveState.status !== "locked"
          ? futuresAdjustmentFeedback(performance, true)
          : null
        : forceEntry
          ? futuresAdjustmentFeedback(performance)
          : null;
      if (adaptiveEnabled || feedback) {
        if (feedback) {
          futuresStrategies.set(`account:${row.userId}`, {
            strategy: await getAutomationFuturesStrategy(
              now,
              entryMode,
              forceEntry,
              futuresSession.symbol,
              feedback,
              adaptiveStrategyId,
            ),
            adjustedForStreakId: performance.stopLossStreakId,
            ...(adaptiveStrategyId ? { adaptiveStrategyId } : {}),
          });
        } else {
          activeConfigs.set(
            futuresStrategyKey(entryMode, forceEntry, futuresSession.symbol, adaptiveStrategyId),
            { entryMode, forceEntry, adaptiveStrategyId },
          );
        }
      } else {
        activeConfigs.set(futuresStrategyKey(entryMode, forceEntry, futuresSession.symbol), {
          entryMode,
          forceEntry,
        });
      }
    }
    for (const [key, config] of activeConfigs) {
      futuresStrategies.set(
        key,
        {
          strategy: await getAutomationFuturesStrategy(
            now,
            config.entryMode,
            config.forceEntry,
            futuresSession.symbol,
            undefined,
            config.adaptiveStrategyId,
          ),
          adjustedForStreakId: null,
          ...(config.adaptiveStrategyId
            ? { adaptiveStrategyId: config.adaptiveStrategyId }
            : {}),
        },
      );
    }
  }
  const tickers = [...new Set(eligibleRows.flatMap((row) => [
    ...row.state.positions.map((position) => position.ticker),
    ...row.state.pendingEntries.map((entry) => entry.ticker),
  ]).filter((ticker) => ticker !== FUTURES_TICKER))];
  const quoteEntries = await Promise.all(tickers.map(async (ticker) =>
    [ticker, await getFreshQuote(ticker, now)] as const,
  ));
  const quoteByTicker = new Map(quoteEntries);
  if (shouldReadFutures) quoteByTicker.set(FUTURES_TICKER, futuresQuote);
  for (const row of eligibleRows) {
    await processAutomationAccount(row, quoteByTicker, futuresQuote, futuresStrategies, now);
  }
}
