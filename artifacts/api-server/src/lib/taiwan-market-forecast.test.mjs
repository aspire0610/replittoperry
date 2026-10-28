import assert from "node:assert/strict";
import test from "node:test";
import { calculateTaiwanMarketForecastEvidence } from "./taiwan-market-forecast-utils.ts";

test("backtests the same bullish rule against next-session opening gaps", () => {
  const bars = Array.from({ length: 130 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    open: 99.8 + index,
    close: 100 + index,
  }));
  const result = calculateTaiwanMarketForecastEvidence(bars);
  assert.ok(result);
  assert.equal(result.ruleDirection, "bullish");
  assert.equal(result.ruleScore, 4);
  assert.equal(result.nextOpenBacktest?.sampleCount, 69);
  assert.equal(result.nextOpenBacktest?.correctCount, 69);
  assert.equal(result.nextOpenBacktest?.hitRatePercent, 100);
  assert.equal(result.fiveDayBacktest?.hitRatePercent, 100);
  assert.match(result.targetDefinition, /開盤相對訊號日收盤/u);
});

test("does not publish hit rates below the minimum sample threshold", () => {
  const bars = Array.from({ length: 80 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    open: 99.8 + index,
    close: 100 + index,
  }));
  const result = calculateTaiwanMarketForecastEvidence(bars);
  assert.ok(result);
  assert.ok((result.nextOpenBacktest?.sampleCount ?? 0) < 20);
  assert.equal(result.nextOpenBacktest?.hitRatePercent, null);
  assert.equal(result.nextOpenBacktest?.lowerBound95Percent, null);
});

test("rejects insufficient or malformed index history", () => {
  assert.equal(calculateTaiwanMarketForecastEvidence([]), null);
  const invalidBars = Array.from({ length: 70 }, (_, index) => ({
    date: "invalid",
    open: 0,
    close: Number.NaN,
  }));
  assert.equal(calculateTaiwanMarketForecastEvidence(invalidBars), null);
});
