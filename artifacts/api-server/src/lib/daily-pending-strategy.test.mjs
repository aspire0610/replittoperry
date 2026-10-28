import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSmcPendingPlan,
  calculateDailyPendingBacktest,
  countDailyPendingHistoryBars,
  passesSmcPendingSignal,
  qualifiesDailyPendingBacktest,
} from "./daily-pending-strategy.ts";

function makeBars(count, overrides = new Map()) {
  const start = new Date("2025-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000,
      ...overrides.get(index),
    };
  });
}

function makeBacktestBars(outcomeBar) {
  const overrides = new Map([
    [3, { open: 131, high: 135, low: 129, close: 133 }],
    [5, { open: 108, high: 110, low: 106, close: 109 }],
    [7, { open: 97, high: 102, low: 95, close: 98 }],
    [10, { open: 103, high: 105, low: 101, close: 104 }],
    [12, { open: 92, high: 98, low: 90, close: 93 }],
    [18, { open: 110, high: 110, low: 103, close: 104 }],
    [19, { open: 108, high: 109, low: 102, close: 104 }],
    [20, { open: 108, high: 113, low: 107, close: 112, volume: 2_000 }],
    [21, { open: 112.2, ...outcomeBar }],
  ]);
  for (let index = 22; index <= 30; index += 1) {
    overrides.set(index, { open: 106, high: 110, low: 104, close: 108 });
  }
  return makeBars(32, overrides);
}

test("builds a CHoCH plan with OB stop, nearby resistance target, and R/R at least 2", () => {
  const bars = makeBars(21, new Map([
    [3, { open: 131, high: 135, low: 129, close: 133 }],
    [5, { open: 108, high: 110, low: 106, close: 109 }],
    [7, { open: 97, high: 102, low: 95, close: 98 }],
    [10, { open: 103, high: 105, low: 101, close: 104 }],
    [12, { open: 92, high: 98, low: 90, close: 93 }],
    [18, { open: 110, high: 110, low: 103, close: 104, volume: 1_000 }],
    [19, { open: 105, high: 106.5, low: 104, close: 106, volume: 1_000 }],
    [20, { open: 110, high: 113, low: 109.5, close: 112.5, volume: 2_000 }],
  ]));

  const plan = buildSmcPendingPlan(bars);

  assert.ok(plan);
  assert.equal(plan.triggerType, "CHoCH");
  assert.equal(plan.zoneType, "OB");
  assert.equal(plan.stopPrice, 103);
  assert.equal(plan.targetPrice, 135);
  assert.equal(plan.entryPrice, 112.5);
  assert.equal(plan.rewardToRisk, (135 - 112.5) / (112.5 - 103));
  assert.equal(plan.volumeRatio, 2);
  assert.equal(passesSmcPendingSignal(plan), true);
});

test("rejects an incomplete sample and applies the relaxed strict volume and R/R limits", () => {
  assert.equal(buildSmcPendingPlan(makeBars(19)), null);
  const plan = {
    triggerType: "BOS",
    triggerDate: "2026-01-01",
    zoneType: "OB",
    zoneLower: 95,
    zoneUpper: 100,
    stopPrice: 95,
    targetPrice: 115,
    entryPrice: 105,
    rewardToRisk: 2,
    volumeRatio: 1.2,
    dailyChangePercent: 1.5,
    fiveDayChangePercent: 14.9,
    volumeIncreased: true,
  };
  assert.equal(passesSmcPendingSignal({ ...plan, volumeRatio: 1.21, rewardToRisk: 1.5 }), true);
  assert.equal(passesSmcPendingSignal({ ...plan, volumeRatio: 1.19 }), false);
  assert.equal(passesSmcPendingSignal({ ...plan, volumeRatio: 1.2 }), false);
  assert.equal(passesSmcPendingSignal({ ...plan, volumeRatio: 3.01 }), true);
  assert.equal(passesSmcPendingSignal({ ...plan, rewardToRisk: 1.49 }), false);
  assert.equal(passesSmcPendingSignal({ ...plan, dailyChangePercent: 9.01 }), false);
  assert.equal(passesSmcPendingSignal({ ...plan, volumeIncreased: false }), false);
});

test("requires 5 settled samples and 50% wins, without an extra payoff-ratio gate", () => {
  const result = {
    wins: 3,
    losses: 2,
    noTouchCount: 4,
    sampleCount: 5,
    winRatePercent: 60,
    payoffRatio: null,
  };
  assert.equal(qualifiesDailyPendingBacktest(result), true);
  assert.equal(qualifiesDailyPendingBacktest({ ...result, sampleCount: 4 }), false);
  assert.equal(qualifiesDailyPendingBacktest({ ...result, winRatePercent: 49.9 }), false);
});

test("backtests against fixed SMC stop and target prices, with same-day ties counted as losses", () => {
  const bars = makeBacktestBars({ high: 136, low: 101, close: 120 });
  const asOf = bars.at(-1).date;
  assert.equal(countDailyPendingHistoryBars(bars, asOf), 32);
  const result = calculateDailyPendingBacktest(bars, asOf);
  assert.equal(result.sampleCount, 1);
  assert.equal(result.losses, 1);
  assert.equal(result.wins, 0);
});
