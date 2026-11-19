import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePaperAutomationShares,
  calculatePaperFuturesContracts,
  isFuturesDayEntryTime,
  isFuturesNightEntryTime,
  paperAutomationExitReason,
  paperFuturesExitReason,
  recordPaperFuturesExit,
  resolvePaperFuturesEntry,
  shouldFlattenFuturesDayPosition,
  shouldFlattenFuturesNightPosition,
  validatePaperAutomationSignal,
  wilsonLowerBoundPercent,
} from "./paper-trading-automation-rules.ts";

test("Wilson lower bound is conservative and increases with a strong sample", () => {
  assert.ok(wilsonLowerBoundPercent(99, 100) < 99);
  assert.ok(wilsonLowerBoundPercent(500, 500) > 99);
  assert.equal(wilsonLowerBoundPercent(101, 100), null);
});

test("risk sizing caps both per-trade loss and available cash using round lots", () => {
  const shares = calculatePaperAutomationShares({
    equity: 1_200_000,
    cash: 110_000,
    riskPerTradePercent: 0.5,
    entryPrice: 100,
    stopLossPrice: 95,
  });
  assert.equal(shares, 1_000);
  assert.equal(calculatePaperAutomationShares({
    equity: 1_000_000,
    cash: 10_000,
    riskPerTradePercent: 0.5,
    entryPrice: 100,
    stopLossPrice: 95,
  }), 0);
});

test("exit rules return the first observed stop or target breach", () => {
  assert.equal(paperAutomationExitReason(94, 95, 110), "stop_loss");
  assert.equal(paperAutomationExitReason(111, 95, 110), "take_profit");
  assert.equal(paperAutomationExitReason(100, 95, 110), null);
});

test("futures sizing respects contract point values and the per-trade risk cap", () => {
  const base = {
    equity: 1_000_000,
    riskPerTradePercent: 0.5,
    entryPrice: 22_000,
    stopLossPrice: 21_900,
  };
  assert.equal(calculatePaperFuturesContracts({ ...base, contractMultiplier: 200 }), 0);
  assert.equal(calculatePaperFuturesContracts({ ...base, contractMultiplier: 50 }), 1);
  assert.equal(calculatePaperFuturesContracts({ ...base, contractMultiplier: 10 }), 5);
  assert.equal(calculatePaperFuturesContracts({
    ...base,
    contractMultiplier: 10,
    maxContracts: 3,
  }), 3);
});

test("forced futures entry requires an AI direction and uses the latest valid price", () => {
  const base = {
    forceEntry: true,
    status: "available",
    action: "long",
    entryPlanStatus: "available",
    entryPlanMode: "conditional",
    planDirection: "long",
    currentPrice: 42_100,
    plannedEntryPrice: 42_080,
    stopLossPrice: 42_000,
    targetPrice: 42_300,
  };
  assert.deepEqual(resolvePaperFuturesEntry(base), {
    direction: "long",
    entryPrice: 42_100,
    stopLossPrice: 42_000,
    targetPrice: 42_300,
    forced: true,
  });
  assert.deepEqual(resolvePaperFuturesEntry({
    ...base,
    action: "short",
    planDirection: "short",
    plannedEntryPrice: 42_120,
    stopLossPrice: 42_200,
    targetPrice: 41_900,
  }), {
    direction: "short",
    entryPrice: 42_100,
    stopLossPrice: 42_200,
    targetPrice: 41_900,
    forced: true,
  });
  assert.equal(resolvePaperFuturesEntry({ ...base, action: "wait" }), null);
});

test("forced futures entry still requires a complete AI plan and valid stop/target order", () => {
  const base = {
    forceEntry: true,
    status: "available",
    action: "long",
    entryPlanStatus: "available",
    entryPlanMode: "conditional",
    planDirection: "long",
    currentPrice: 42_100,
    plannedEntryPrice: 42_080,
    stopLossPrice: 42_000,
    targetPrice: 42_300,
  };
  assert.equal(resolvePaperFuturesEntry({ ...base, status: "insufficient_data" }), null);
  assert.equal(resolvePaperFuturesEntry({ ...base, entryPlanStatus: "unavailable" }), null);
  assert.equal(resolvePaperFuturesEntry({ ...base, action: "insufficient" }), null);
  assert.equal(resolvePaperFuturesEntry({ ...base, planDirection: null }), null);
  assert.equal(resolvePaperFuturesEntry({ ...base, targetPrice: 42_050 }), null);
});

test("forced futures paper entry requires at least 20 target points", () => {
  const base = {
    forceEntry: true,
    status: "available",
    action: "long",
    entryPlanStatus: "available",
    entryPlanMode: "conditional",
    planDirection: "long",
    currentPrice: 42_100,
    plannedEntryPrice: 42_080,
    stopLossPrice: 42_000,
    targetPrice: 42_120,
  };
  assert.equal(resolvePaperFuturesEntry(base)?.targetPrice, 42_120);
  assert.equal(resolvePaperFuturesEntry({ ...base, targetPrice: 42_119 }), null);
});

test("three consecutive futures stop losses request one AI review per losing streak", () => {
  const empty = {
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
  };
  const stop = (performance, asOf) => recordPaperFuturesExit(performance, {
    exitReason: "stop_loss",
    direction: "long",
    entryPrice: 22_000,
    exitPrice: 21_900,
    stopLossPrice: 21_900,
    realizedPnl: -1_000,
    asOf,
  });

  const first = stop(empty, "2026-11-18T01:00:00.000Z");
  const second = stop(first, "2026-11-18T01:05:00.000Z");
  const third = stop(second, "2026-11-18T01:10:00.000Z");
  assert.equal(first.adjustmentStatus, "idle");
  assert.equal(second.adjustmentStatus, "idle");
  assert.equal(third.adjustmentStatus, "pending");
  assert.equal(third.consecutiveStopLosses, 3);
  assert.equal(third.stopLossStreakId, 1);
  assert.equal(third.recentStopLosses.length, 3);
  assert.equal(third.realizedPnl, -3_000);
  assert.equal(third.losses, 3);

  const appliedFirstReview = {
    ...third,
    lastAdjustedStreakId: third.stopLossStreakId,
    lastAdjustedStopLossCount: third.consecutiveStopLosses,
    adjustmentStatus: "applied",
  };
  const fourth = stop(appliedFirstReview, "2026-11-18T01:15:00.000Z");
  assert.equal(fourth.stopLossStreakId, 1);
  assert.equal(fourth.adjustmentStatus, "applied");
  assert.equal(fourth.adjustmentFeedback.consecutiveStopLosses, 3);
  const fifth = stop(fourth, "2026-11-18T01:16:00.000Z");
  assert.equal(fifth.adjustmentStatus, "applied");
  const sixth = stop(fifth, "2026-11-18T01:17:00.000Z");
  assert.equal(sixth.adjustmentStatus, "pending");
  assert.equal(sixth.adjustmentFeedback.consecutiveStopLosses, 6);
  const recovered = recordPaperFuturesExit(fourth, {
    exitReason: "take_profit",
    direction: "long",
    entryPrice: 22_000,
    exitPrice: 22_200,
    stopLossPrice: 21_900,
    realizedPnl: 2_000,
    asOf: "2026-11-18T01:20:00.000Z",
  });
  assert.equal(recovered.consecutiveStopLosses, 0);
  assert.equal(recovered.recentStopLosses.length, 0);
  assert.equal(recovered.wins, 1);

  const adjusted = {
    ...recovered,
    lastAdjustedStreakId: 1,
    lastAdjustedStopLossCount: 3,
    adjustmentStatus: "applied",
  };
  const newStreak = [
    "2026-11-18T01:25:00.000Z",
    "2026-11-18T01:30:00.000Z",
    "2026-11-18T01:35:00.000Z",
  ].reduce((performance, asOf) => stop(performance, asOf), adjusted);
  assert.equal(newStreak.stopLossStreakId, 2);
  assert.equal(newStreak.adjustmentStatus, "pending");

  const withoutForcedEntry = [1, 2, 3].reduce((performance, n) =>
    recordPaperFuturesExit(performance, {
      exitReason: "stop_loss",
      direction: "short",
      entryPrice: 22_000,
      exitPrice: 22_100,
      stopLossPrice: 22_100,
      realizedPnl: -1_000,
      asOf: `2026-11-18T02:0${n}:00.000Z`,
    }, 3, false), empty);
  assert.equal(withoutForcedEntry.consecutiveStopLosses, 3);
  assert.equal(withoutForcedEntry.adjustmentStatus, "idle");
});

test("normal futures entry still requires the AI current-price action", () => {
  const base = {
    forceEntry: false,
    status: "available",
    action: "long",
    entryPlanStatus: "available",
    entryPlanMode: "current",
    planDirection: "long",
    currentPrice: 42_100,
    plannedEntryPrice: 42_100,
    stopLossPrice: 42_000,
    targetPrice: 42_300,
  };
  assert.deepEqual(resolvePaperFuturesEntry(base), {
    direction: "long",
    entryPrice: 42_100,
    stopLossPrice: 42_000,
    targetPrice: 42_300,
    forced: false,
  });
  assert.equal(resolvePaperFuturesEntry({ ...base, action: "wait" }), null);
  assert.equal(resolvePaperFuturesEntry({ ...base, entryPlanMode: "conditional" }), null);
});

test("futures exit checks handle long and short stop and target levels", () => {
  assert.equal(paperFuturesExitReason(21_899, "long", 21_900, 22_200), "stop_loss");
  assert.equal(paperFuturesExitReason(22_201, "long", 21_900, 22_200), "take_profit");
  assert.equal(paperFuturesExitReason(22_101, "short", 22_100, 21_800), "stop_loss");
  assert.equal(paperFuturesExitReason(21_799, "short", 22_100, 21_800), "take_profit");
  assert.equal(paperFuturesExitReason(22_000, "short", 22_100, 21_800), null);
});

test("futures day entries stop before the close and open positions flatten near close", () => {
  assert.equal(isFuturesDayEntryTime(8 * 60 + 44), false);
  assert.equal(isFuturesDayEntryTime(8 * 60 + 45), true);
  assert.equal(isFuturesDayEntryTime(13 * 60 + 29), true);
  assert.equal(isFuturesDayEntryTime(13 * 60 + 30), false);
  assert.equal(shouldFlattenFuturesDayPosition(13 * 60 + 39), false);
  assert.equal(shouldFlattenFuturesDayPosition(13 * 60 + 40), true);
});

test("futures night entries stop 15 minutes before close and flatten 5 minutes before close", () => {
  assert.equal(isFuturesNightEntryTime(14 * 60 + 59), false);
  assert.equal(isFuturesNightEntryTime(15 * 60), true);
  assert.equal(isFuturesNightEntryTime(4 * 60 + 44), true);
  assert.equal(isFuturesNightEntryTime(4 * 60 + 45), false);
  assert.equal(shouldFlattenFuturesNightPosition(4 * 60 + 54), false);
  assert.equal(shouldFlattenFuturesNightPosition(4 * 60 + 55), true);
  assert.equal(shouldFlattenFuturesNightPosition(5 * 60), false);
});

test("signal qualification requires both independent 100-sample Wilson gates", () => {
  const assessment = {
    action: "buy",
    direction: "bullish",
    pricePlanStatus: "available",
    entryPrice: 100,
    stopLossPrice: 95,
    takeProfitPrice: 110,
    quoteAsOf: new Date().toISOString(),
    analyzedAt: new Date().toISOString(),
    forwardDirectionValidation: {
      horizons: [{
        horizonDays: 5,
        evaluatedDirectionalForecastCount: 500,
        correctForecastCount: 480,
      }],
    },
    pricePlanValidation: {
      resolvedTradeCount: 500,
      targetFirstCount: 480,
    },
  };
  assert.deepEqual(validatePaperAutomationSignal(assessment), { eligible: true });
  const insufficient = structuredClone(assessment);
  insufficient.pricePlanValidation.resolvedTradeCount = 99;
  assert.match(validatePaperAutomationSignal(insufficient).reason, /100 筆/u);
  const invalidPlan = structuredClone(assessment);
  invalidPlan.stopLossPrice = 100;
  assert.match(validatePaperAutomationSignal(invalidPlan).reason, /順序不一致/u);
  const futureQuote = structuredClone(assessment);
  futureQuote.quoteAsOf = new Date(Date.now() + 120_000).toISOString();
  assert.match(validatePaperAutomationSignal(futureQuote).reason, /時間已過期/u);
  assert.equal(calculatePaperAutomationShares({
    equity: 1_000_000,
    cash: 110_000,
    riskPerTradePercent: 0.5,
    entryPrice: 100,
    stopLossPrice: 95,
  }), 0);
});
