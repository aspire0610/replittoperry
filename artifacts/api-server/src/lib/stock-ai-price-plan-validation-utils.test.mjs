import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateStockAiPricePlan,
  summarizeStockAiPricePlanValidation,
} from "./stock-ai-price-plan-validation-utils.ts";

const plan = {
  forecastDate: "2026-10-01",
  horizonDays: 5,
  entryPrice: 100,
  stopLossPrice: 95,
  takeProfitPrice: 110,
};

test("settles a target-first plan after entry is touched", () => {
  assert.deepEqual(
    evaluateStockAiPricePlan(plan, [
      { date: "2026-10-02", high: 105, low: 99 },
      { date: "2026-10-05", high: 111, low: 101 },
      { date: "2026-10-06", high: 112, low: 109 },
      { date: "2026-10-07", high: 113, low: 108 },
      { date: "2026-10-08", high: 114, low: 109 },
    ]),
    { status: "target_first", outcomeDate: "2026-10-05" },
  );
});

test("excludes same-day stop and target touches as ambiguous", () => {
  assert.deepEqual(
    evaluateStockAiPricePlan(plan, [
      { date: "2026-10-02", high: 111, low: 94 },
      { date: "2026-10-05", high: 104, low: 99 },
      { date: "2026-10-06", high: 106, low: 100 },
      { date: "2026-10-07", high: 108, low: 101 },
      { date: "2026-10-08", high: 109, low: 100 },
    ]),
    { status: "ambiguous", outcomeDate: "2026-10-02" },
  );
});

test("does not count a missed entry or an incomplete horizon as a trade win", () => {
  const missedEntry = [
    102, 103, 104, 105, 106,
  ].map((high, index) => ({
    date: `2026-10-0${index + 2}`,
    high,
    low: 101,
  }));
  assert.deepEqual(evaluateStockAiPricePlan(plan, missedEntry), {
    status: "no_entry",
    outcomeDate: "2026-10-06",
  });
  assert.equal(evaluateStockAiPricePlan(plan, missedEntry.slice(0, 4)), null);
});

test("reports an 80 percent win rate only after the minimum resolved sample", () => {
  assert.equal(summarizeStockAiPricePlanValidation([
    ...Array(16).fill("target_first"),
    ...Array(4).fill("stop_first"),
    "ambiguous",
    "no_entry",
  ]).winRatePercent, 80);
  assert.equal(summarizeStockAiPricePlanValidation([
    ...Array(15).fill("target_first"),
    ...Array(4).fill("stop_first"),
  ]).winRatePercent, null);
});
