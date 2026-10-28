import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateProbabilityCalibration,
  eligibleStockAiForecastIndexes,
  predictDirectionByCloseMomentum,
  STOCK_AI_HISTORICAL_VALIDATION_FORECAST_LIMIT,
} from "./stock-ai-historical-validation-utils.ts";

test("fixed 20-day momentum baseline only uses closes available at forecast time", () => {
  assert.equal(predictDirectionByCloseMomentum(
    Array.from({ length: 22 }, (_, index) => index + 10),
    20,
  ), "bullish");
  assert.equal(predictDirectionByCloseMomentum(
    Array.from({ length: 22 }, (_, index) => 40 - index),
    20,
  ), "bearish");
  assert.equal(predictDirectionByCloseMomentum(Array(25).fill(100), 20), "neutral");
  assert.equal(predictDirectionByCloseMomentum([1, 2], 1), null);
  assert.equal(predictDirectionByCloseMomentum([1, 2], 1, 0), null);
});

test("calibrates forecast probabilities against later observed directions", () => {
  const result = calculateProbabilityCalibration([
    { forecastProbabilityPercent: 80, directionCorrect: true },
    { forecastProbabilityPercent: 60, directionCorrect: false },
    { forecastProbabilityPercent: null, directionCorrect: true },
  ]);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.meanForecastProbabilityPercent, 70);
  assert.equal(result.hitRatePercent, 50);
  assert.equal(result.gapPercent, -20);
});

test("selects only the most recent 20 non-overlapping historical AI forecasts", () => {
  const indexes = eligibleStockAiForecastIndexes(1_300);
  assert.equal(STOCK_AI_HISTORICAL_VALIDATION_FORECAST_LIMIT, 20);
  assert.equal(indexes.length, 20);
  assert.deepEqual(indexes.slice(1).map((index, offset) => index - indexes[offset]), Array(19).fill(5));
  assert.equal(indexes.at(-1), 1_294);
});

test("uses all available dates when fewer than 20 historical forecasts exist", () => {
  assert.deepEqual(eligibleStockAiForecastIndexes(50), [39, 44]);
  assert.deepEqual(eligibleStockAiForecastIndexes(44), []);
  assert.deepEqual(eligibleStockAiForecastIndexes(-1), []);
});
