import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkArray,
  calculateBullishMomentumWinRate,
  calculateHitRatePercent,
  calculateLocalPricePlanBacktest,
  calculateWilsonInterval,
  chooseMarketPickOperationPlan,
  filterPicksWithProbabilityEstimate,
  hasUsefulMarketCandidatePool,
  institutionalDataMatchesMarketDate,
  isSystemicRiskDay,
  classifyMarketPickWatchlistFailure,
  getSmcPendingSignalFailureReasons,
  isValidMarketPickProbability,
  rankQualifiedMarketPicks,
  qualifiesAsBuySignal,
  qualifiesAsReliablePricePlan,
  passesAiForwardValidationGate,
  shouldSplitPreliminaryBatchAfterFailure,
  dedupeMarketDailyQuotes,
  validateMarketPickSelection,
  dayTradeMinimumDailyShares,
  isDayTradeLiquidityEligible,
  calculateCdpLevels,
  getTaiwanDayTradeScanMode,
} from "./market-wide-ai-picks-utils.ts";
import {
  MARKET_WIDE_AI_PICK_MINIMUM_SAMPLE_COUNT,
  settleMarketWideAiPick,
  summarizeMarketWideAiPickValidation,
} from "./market-wide-ai-pick-validation-utils.ts";

test("activates systemic defense at the decline-count or decline/advance threshold", () => {
  assert.equal(isSystemicRiskDay(1_000, 1_500), true);
  assert.equal(isSystemicRiskDay(500, 1_500), true);
  assert.equal(isSystemicRiskDay(500, 1_499), false);
  assert.equal(isSystemicRiskDay(0, 1), true);
  assert.equal(isSystemicRiskDay(0, 0), false);
});

test("reports only the earliest failed gate for a separate watchlist", () => {
  assert.equal(classifyMarketPickWatchlistFailure({
    historyAvailable: false,
    signalPassed: false,
    rewardToRisk: 1,
    backtestQualified: false,
  }).failedStage, "historical_data");
  assert.equal(classifyMarketPickWatchlistFailure({
    historyAvailable: true,
    signalPassed: false,
    rewardToRisk: 1,
    backtestQualified: false,
  }).failedStage, "smc_signal");
  assert.equal(classifyMarketPickWatchlistFailure({
    historyAvailable: true,
    signalPassed: true,
    rewardToRisk: 1.8,
    backtestQualified: false,
  }).failedStage, "reward_to_risk");
  assert.equal(classifyMarketPickWatchlistFailure({
    historyAvailable: true,
    signalPassed: true,
    rewardToRisk: 2,
    backtestQualified: false,
  }).failedStage, "backtest");
  assert.equal(classifyMarketPickWatchlistFailure({
    historyAvailable: true,
    signalPassed: true,
    rewardToRisk: 2,
    backtestQualified: true,
  }), null);
});

test("explains exact SMC metric failures without changing qualification thresholds", () => {
  const plan = {
    dailyChangePercent: 1.2,
    fiveDayChangePercent: 16,
    volumeIncreased: false,
    volumeRatio: 1.1,
    rewardToRisk: 1.4,
  };
  assert.deepEqual(getSmcPendingSignalFailureReasons(plan), [
    "單日漲幅需介於 1.5%–9%，目前 1.20%",
    "五日漲幅需低於 15%，目前 16.00%",
    "成交量需高於前一交易日，目前未增加",
    "量比需高於 1.2，目前 1.10",
    "SMC 訊號的風險報酬需至少 1.5，目前 1.40:1",
  ]);
  assert.equal(getSmcPendingSignalFailureReasons({
    dailyChangePercent: 1.5,
    fiveDayChangePercent: 14.99,
    volumeIncreased: true,
    volumeRatio: 1.21,
    rewardToRisk: 1.5,
  }).length, 0);
});

test("uses the article's price-based daily volume thresholds in Taiwan shares", () => {
  assert.equal(dayTradeMinimumDailyShares(99.99), 10_000_000);
  assert.equal(dayTradeMinimumDailyShares(100), 5_000_000);
  assert.equal(isDayTradeLiquidityEligible(50, 9_999_999), false);
  assert.equal(isDayTradeLiquidityEligible(50, 10_000_000), true);
  assert.equal(isDayTradeLiquidityEligible(150, 5_000_000), true);
  assert.equal(isDayTradeLiquidityEligible(150, null), false);
});

test("calculates prior-session CDP levels and classifies price zones", () => {
  const levels = calculateCdpLevels(
    { date: "2026-10-22", high: 110, low: 90, close: 100 },
    112,
    105,
  );
  assert.deepEqual(levels, {
    referenceDate: "2026-10-22",
    cdp: 100,
    ah: 120,
    nh: 110,
    nl: 90,
    al: 80,
    currentZone: "ah_to_nh",
    openingZone: "nh_to_cdp",
  });
  assert.equal(calculateCdpLevels(
    { date: "2026-10-22", high: 100, low: 110, close: 105 },
    105,
  ), null);
});

test("restricts same-day scan mode to the lower-risk intraday window", () => {
  const taipei = (time) => new Date(`2026-10-23T${time}:00+08:00`);
  assert.equal(getTaiwanDayTradeScanMode(taipei("09:15")), "no_entry_window");
  assert.equal(getTaiwanDayTradeScanMode(taipei("09:30")), "no_entry_window");
  assert.equal(getTaiwanDayTradeScanMode(taipei("10:00")), "intraday");
  assert.equal(getTaiwanDayTradeScanMode(taipei("12:29")), "intraday");
  assert.equal(getTaiwanDayTradeScanMode(taipei("12:30")), "no_entry_window");
  assert.equal(getTaiwanDayTradeScanMode(taipei("15:00")), "next_session_watchlist");
  assert.equal(getTaiwanDayTradeScanMode(new Date("2026-10-24T10:00:00+08:00")), "next_session_watchlist");
});

test("calculates a same-direction five-day momentum hit rate without using future bars", () => {
  const bars = Array.from({ length: 51 }, (_, index) => ({ close: 100 + index }));
  const result = calculateBullishMomentumWinRate(bars, { lookback: 3, horizon: 2 });
  assert.equal(result.currentDirection, "bullish");
  assert.ok(result.sampleCount > 0);
  assert.equal(result.correctCount, result.sampleCount);
  assert.equal(result.hitRatePercent, 100);
});

test("uses the full five-year independent signal history instead of capping at twenty samples", () => {
  const bars = Array.from({ length: 1_220 }, (_, index) => ({ close: 100 + index }));
  const result = calculateBullishMomentumWinRate(bars, { maxSamples: 500 });
  assert.ok(result.sampleCount > 100);
  assert.equal(result.correctCount, result.sampleCount);
});

test("settles market-wide AI picks on the fifth later trading close", () => {
  const bars = Array.from({ length: 6 }, (_, index) => ({
    date: `2026-10-${String(16 + index).padStart(2, "0")}`,
    close: 100 + index,
  }));
  const result = settleMarketWideAiPick("2026-10-16", 100, bars);
  assert.equal(result?.targetTradingDate, "2026-10-21");
  assert.equal(result?.actualClose, 105);
  assert.equal(result?.actualDirection, "bullish");
});

test("withholds market-wide AI hit rate until one hundred forward outcomes settle", () => {
  const rows = Array.from({ length: MARKET_WIDE_AI_PICK_MINIMUM_SAMPLE_COUNT }, (_, index) => ({
    probabilityPercent: 70,
    actualDirection: index < 70 ? "bullish" : "bearish",
  }));
  const summary = summarizeMarketWideAiPickValidation(rows);
  assert.equal(summary.sampleCount, 100);
  assert.equal(summary.correctCount, 70);
  assert.equal(summary.hitRatePercent, 70);
  assert.ok(summary.lowerBoundPercent !== null && summary.lowerBoundPercent < 70);
  assert.ok(summary.upperBoundPercent !== null && summary.upperBoundPercent > 70);
  assert.ok(summary.brierScore !== null);
  assert.equal(summarizeMarketWideAiPickValidation(rows.slice(0, 99)).hitRatePercent, null);
});

test("calculates observed hit rates and 95% Wilson intervals from exact counts", () => {
  assert.deepEqual(calculateWilsonInterval(0, 0), {
    lowerBoundPercent: null,
    upperBoundPercent: null,
  });
  assert.equal(calculateWilsonInterval(3, 5).lowerBoundPercent?.toFixed(1), "23.1");
  assert.equal(calculateWilsonInterval(3, 5).upperBoundPercent?.toFixed(1), "88.2");
  assert.equal(calculateWilsonInterval(5, 5).lowerBoundPercent?.toFixed(1), "56.6");
  assert.equal(calculateWilsonInterval(5, 5).upperBoundPercent, 100);
});

test("calculates bullish-rule history even when the current trend is bearish", () => {
  const bearish = Array.from({ length: 51 }, (_, index) => ({ close: 200 - index }));
  assert.deepEqual(
    calculateBullishMomentumWinRate(bearish, { lookback: 3, horizon: 2 }),
    { currentDirection: "bearish", sampleCount: 0, correctCount: 0, hitRatePercent: null },
  );
  const mixed = [
    ...Array.from({ length: 30 }, (_, index) => ({ close: 100 + index })),
    ...Array.from({ length: 30 }, (_, index) => ({ close: 130 - index })),
  ];
  const result = calculateBullishMomentumWinRate(mixed, { lookback: 3, horizon: 2, maxSamples: 2 });
  assert.equal(result.currentDirection, "bearish");
  assert.ok(result.sampleCount > 0);
});

test("caps AI probabilities below certainty without artificial 5-point buckets", () => {
  assert.equal(isValidMarketPickProbability(67), true);
  assert.equal(isValidMarketPickProbability(95), true);
  assert.equal(isValidMarketPickProbability(96), false);
  assert.equal(isValidMarketPickProbability(null), true);
  assert.equal(isValidMarketPickProbability(60.5), false);
  assert.equal(isValidMarketPickProbability(101), false);
  assert.equal(isValidMarketPickProbability(undefined), false);
});

test("accepts only bullish candidates with a usable estimate and valid entry scenario", () => {
  const result = validateMarketPickSelection([
    { symbol: "6505", direction: "bullish", directionProbabilityPercent: 82, entryScenario: "pullback" },
  ], ["6505", "2330"]);
  assert.deepEqual(result, [
    { symbol: "6505", directionProbabilityPercent: 82, entryScenario: "pullback" },
  ]);
  assert.equal(validateMarketPickSelection([
    { symbol: "9999", direction: "bullish", directionProbabilityPercent: 82, entryScenario: "pullback" },
  ], ["6505"]), null);
  assert.equal(validateMarketPickSelection([
    { symbol: "6505", direction: "bullish", directionProbabilityPercent: 100, entryScenario: "direct" },
  ], ["6505"]), null);
  assert.equal(validateMarketPickSelection([
    { symbol: "2330", direction: "bearish", directionProbabilityPercent: 91, entryScenario: "direct" },
  ], ["2330"]), null);
  assert.deepEqual(validateMarketPickSelection([], ["6505"]), []);
});

test("market-pick buy plan prefers a pullback and blocks chasing a sharp daily rise", () => {
  const scenarios = {
    directEntry: { entryPrice: 110, targetPrice: 120, stopPrice: 105, rewardToRisk: 2 },
    pullbackEntry: { entryPrice: 100, targetPrice: 120, stopPrice: 90, rewardToRisk: 2 },
  };
  assert.equal(chooseMarketPickOperationPlan(scenarios, 10).action, "wait_for_pullback");
  assert.equal(chooseMarketPickOperationPlan(scenarios, 10, "direct").action, "wait_for_pullback");
  assert.equal(chooseMarketPickOperationPlan(scenarios, 10, "pullback").entryPrice, 100);
  assert.equal(chooseMarketPickOperationPlan({
    ...scenarios,
    pullbackEntry: { entryPrice: null, targetPrice: null, stopPrice: null, rewardToRisk: null },
  }, 10).action, "no_trade");
  assert.equal(chooseMarketPickOperationPlan({
    ...scenarios,
    pullbackEntry: { entryPrice: null, targetPrice: null, stopPrice: null, rewardToRisk: null },
  }, 2).action, "conditional_entry");
});

test("only retries a failed market batch when smaller input can address the failure", () => {
  assert.equal(shouldSplitPreliminaryBatchAfterFailure([
    { status: 429, failureKind: "http" },
    { status: 502, failureKind: "connection" },
  ]), false);
  assert.equal(shouldSplitPreliminaryBatchAfterFailure([
    { status: 502, failureKind: "invalid_output" },
  ]), true);
  assert.equal(shouldSplitPreliminaryBatchAfterFailure([
    { status: 413, failureKind: "http" },
  ]), true);
});

test("chunks the complete universe without dropping or duplicating symbols", () => {
  const universe = Array.from({ length: 1_037 }, (_, index) => `S${index}`);
  const batches = chunkArray(universe, 200);

  assert.equal(batches.length, 6);
  assert.deepEqual(batches.flat(), universe);
  assert.ok(batches.every((batch) => batch.length <= 200));
});

test("deduplicates same-exchange symbols while keeping distinct exchange tickers", () => {
  const result = dedupeMarketDailyQuotes([
    { symbol: "2330", exchange: "twse", close: 100 },
    { symbol: "2330", exchange: "twse", close: 101 },
    { symbol: "2330", exchange: "tpex", close: 102 },
  ]);
  assert.deepEqual(result, [
    { symbol: "2330", exchange: "twse", close: 100 },
    { symbol: "2330", exchange: "tpex", close: 102 },
  ]);
});

test("rejects invalid scan batch sizes", () => {
  assert.throws(() => chunkArray([1], 0), RangeError);
});

test("institutional evidence must match the official market date", () => {
  assert.equal(institutionalDataMatchesMarketDate("2026-10-16", "2026-10-16"), true);
  assert.equal(institutionalDataMatchesMarketDate("2026-10-15", "2026-10-16"), false);
  assert.equal(institutionalDataMatchesMarketDate(null, "2026-10-16"), false);
});

test("keeps numeric AI estimates below 60 so the best candidates are still ranked", () => {
  const result = filterPicksWithProbabilityEstimate([
    { symbol: "A", directionProbabilityPercent: 60 },
    { symbol: "B", directionProbabilityPercent: 65 },
    { symbol: "C", directionProbabilityPercent: null },
    { symbol: "D", directionProbabilityPercent: 55 },
    { symbol: "E", directionProbabilityPercent: 0 },
  ]);

  assert.deepEqual(result.map((pick) => pick.symbol), ["A", "B", "D", "E"]);
});

test("omits only estimates that are unavailable", () => {
  assert.deepEqual(
    filterPicksWithProbabilityEstimate([
      { symbol: "A", directionProbabilityPercent: 60 },
      { symbol: "B", directionProbabilityPercent: null },
    ]),
    [{ symbol: "A", directionProbabilityPercent: 60 }],
  );
});

test("returns null for unavailable or inconsistent historical hit-rate counts", () => {
  assert.equal(calculateHitRatePercent(3, 4), 75);
  assert.equal(calculateHitRatePercent(0, 0), null);
  assert.equal(calculateHitRatePercent(Number.NaN, 4), null);
  assert.equal(calculateHitRatePercent(5, 4), null);
});

test("backtests locally generated price plans on non-overlapping future windows", () => {
  const bars = Array.from({ length: 10 }, (_, index) => ({
    date: `D${index}`,
    high: index === 6 || index === 8 ? 103 : 101,
    low: 99.5,
  }));
  const result = calculateLocalPricePlanBacktest(
    bars,
    () => ({ entryPrice: 100, targetPrice: 102, stopPrice: 98 }),
    { lookbackBars: 2, horizon: 2, maxPeriods: 2 },
  );
  assert.equal(result.windowCount, 2);
  assert.equal(result.resolvedCount, 2);
  assert.equal(result.targetFirstCount, 2);
  assert.equal(result.winRatePercent, 100);
});

test("counts expired and ambiguous entered trades as non-wins in the backtest rate", () => {
  const bars = Array.from({ length: 10 }, (_, index) => ({
    date: `D${index}`,
    high: index === 3 || index === 7 || index === 8 ? 103 : 101,
    low: index === 7 || index === 8 ? 90 : 99,
  }));
  const result = calculateLocalPricePlanBacktest(
    bars,
    () => ({ entryPrice: 100, targetPrice: 102, stopPrice: 98 }),
    { lookbackBars: 1, horizon: 2, maxPeriods: 3 },
  );
  assert.equal(result.targetFirstCount, 1);
  assert.equal(result.expiredCount, 1);
  assert.equal(result.ambiguousCount, 1);
  assert.equal(result.resolvedCount, 3);
  assert.equal(result.winRatePercent?.toFixed(2), "33.33");
});

test("only qualifies a price plan with adequate samples and a lower confidence bound above fifty percent", () => {
  assert.equal(qualifiesAsReliablePricePlan({
    windowCount: 99,
    resolvedCount: 99,
    targetFirstCount: 99,
    stopFirstCount: 0,
    ambiguousCount: 0,
    noEntryCount: 0,
    expiredCount: 0,
    winRatePercent: 100,
  }), false);
  assert.equal(qualifiesAsReliablePricePlan({
    windowCount: 100,
    resolvedCount: 100,
    targetFirstCount: 65,
    stopFirstCount: 35,
    ambiguousCount: 0,
    noEntryCount: 0,
    expiredCount: 0,
    winRatePercent: 65,
  }), true);
  assert.equal(qualifiesAsReliablePricePlan({
    windowCount: 100,
    resolvedCount: 100,
    targetFirstCount: 50,
    stopFirstCount: 50,
    ambiguousCount: 0,
    noEntryCount: 0,
    expiredCount: 0,
    winRatePercent: 50,
  }), false);
});

test("does not recommend AI picks before prospective performance clears both gates", () => {
  assert.equal(passesAiForwardValidationGate({
    sampleCount: 99,
    minimumSampleCount: 100,
    lowerBoundPercent: 70,
  }), false);
  assert.equal(passesAiForwardValidationGate({
    sampleCount: 100,
    minimumSampleCount: 100,
    lowerBoundPercent: 50,
  }), false);
  assert.equal(passesAiForwardValidationGate({
    sampleCount: 100,
    minimumSampleCount: 100,
    lowerBoundPercent: 50.01,
  }), true);
});

test("a buy signal requires prospective AI validation, a reliable price-plan backtest, verified news, and adequate reward to risk", () => {
  const validInput = {
    forwardValidation: {
      sampleCount: 120,
      minimumSampleCount: 100,
      lowerBoundPercent: 52,
    },
    pricePlan: {
      windowCount: 120,
      resolvedCount: 120,
      targetFirstCount: 80,
      stopFirstCount: 40,
      ambiguousCount: 0,
      noEntryCount: 0,
      expiredCount: 0,
      winRatePercent: 80,
    },
    hasVerifiedNews: true,
    rewardToRisk: 1.5,
  };
  assert.equal(qualifiesAsBuySignal(validInput), true);
  assert.equal(qualifiesAsBuySignal({
    ...validInput,
    forwardValidation: { ...validInput.forwardValidation, sampleCount: 99 },
  }), false);
  assert.equal(qualifiesAsBuySignal({
    ...validInput,
    pricePlan: { ...validInput.pricePlan, targetFirstCount: 60, stopFirstCount: 60, winRatePercent: 50 },
  }), false);
  assert.equal(qualifiesAsBuySignal({ ...validInput, hasVerifiedNews: false }), false);
  assert.equal(qualifiesAsBuySignal({ ...validInput, rewardToRisk: 1.49 }), false);
});

test("requires both exchanges and a full candidate batch before final AI selection", () => {
  assert.equal(hasUsefulMarketCandidatePool(1, 30), false);
  assert.equal(hasUsefulMarketCandidatePool(2, 30), true);
  assert.equal(hasUsefulMarketCandidatePool(0, 30), false);
  assert.equal(hasUsefulMarketCandidatePool(1, 29), false);
});

function strictPick(symbol, score, probability, tradedValue, foreign, trust, directRr, pullbackRr) {
  const scenario = (rewardToRisk) => rewardToRisk == null
    ? { entryPrice: null, targetPrice: null, stopPrice: null, rewardToRisk: null }
    : { entryPrice: 100, targetPrice: 120, stopPrice: 100 - 20 / rewardToRisk, rewardToRisk };
  return {
    symbol,
    scorecard: {
      earnedPoints: score,
      items: [
        { id: "institution-外資", points: foreign },
        { id: "institution-投信", points: trust },
      ],
    },
    scenarios: {
      directEntry: scenario(directRr),
      pullbackEntry: scenario(pullbackRr),
    },
    entryScenario: directRr === null ? "pullback" : "direct",
    referenceChangePercent: 0,
    directionProbabilityPercent: probability,
    tradedValue,
  };
}

test("expanded final picks require at least one institutional net buyer and R/R of at least 1.5", () => {
  const result = rankQualifiedMarketPicks([
    strictPick("foreign-only", 95, 75, 500, 10, 0, 3, null),
    strictPick("trust-only", 94, 80, 400, 0, 10, 1.5, null),
    strictPick("low-rr", 93, 85, 450, 10, 10, 1.49, null),
    strictPick("passes", 80, 65, 300, 10, 10, null, 2),
  ]);

  assert.deepEqual(result.map((pick) => pick.symbol), ["trust-only", "foreign-only", "passes"]);
});

test("returns every qualified pick rather than arbitrarily capping the list at ten", () => {
  const picks = Array.from({ length: 7 }, (_, index) =>
    strictPick(`S${index}`, 100 - index, 65, 100, 10, 10, 2, null),
  );

  const result = rankQualifiedMarketPicks([
    ...picks,
    ...Array.from({ length: 6 }, (_, index) =>
      strictPick(`T${index}`, 90 - index, 65, 100, 10, 10, 2, null),
    ),
  ]);

  assert.equal(result.length, 13);
  assert.deepEqual(result.map((pick) => pick.symbol), [
    "S0", "S1", "S2", "S3", "S4", "S5", "S6", "T0", "T1", "T2", "T3", "T4", "T5",
  ]);
});

test("AI probability ranks candidates ahead of technical score", () => {
  const result = rankQualifiedMarketPicks([
    strictPick("HIGH-SCORE", 99, 68, 500, 10, 10, 2, null),
    strictPick("HIGH-AI", 40, 91, 200, 10, 10, 2, null),
  ]);
  assert.deepEqual(result.map((pick) => pick.symbol), ["HIGH-AI", "HIGH-SCORE"]);
});
