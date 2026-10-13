import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateStockAiDirectionForecast,
  summarizeStockAiDirectionValidation,
  toTaiwanTradingDate,
} from "./stock-ai-direction-validation-utils.ts";

test("converts source instants to the correct Taiwan trading date", () => {
  assert.equal(
    toTaiwanTradingDate(new Date("2026-10-09T16:30:00.000Z")),
    "2026-10-10",
  );
  assert.equal(toTaiwanTradingDate(new Date(Number.NaN)), null);
});

test("settles only against a later official daily close at the selected horizon", () => {
  const dailyBars = [
    { date: "2026-10-16", close: 105 },
    { date: "2026-10-09", close: 98 },
    { date: "2026-10-14", close: 103 },
    { date: "2026-10-12", close: 101 },
    { date: "2026-10-15", close: 99 },
    { date: "2026-10-13", close: 100 },
  ];
  const oneDay = evaluateStockAiDirectionForecast(
    { forecastDate: "2026-10-09", horizonDays: 1, referencePrice: 100 },
    dailyBars,
  );
  const fiveDays = evaluateStockAiDirectionForecast(
    { forecastDate: "2026-10-09", horizonDays: 5, referencePrice: 100 },
    dailyBars,
  );

  assert.deepEqual(oneDay, {
    targetTradingDate: "2026-10-12",
    actualClose: 101,
    actualReturnPercent: 1,
    actualDirection: "bullish",
  });
  assert.deepEqual(fiveDays, {
    targetTradingDate: "2026-10-16",
    actualClose: 105,
    actualReturnPercent: 5,
    actualDirection: "bullish",
  });
  assert.equal(
    evaluateStockAiDirectionForecast(
      { forecastDate: "2026-10-09", horizonDays: 1, referencePrice: 100 },
      [{ date: "2026-10-09", close: 101 }],
    ),
    null,
  );
});

test("excludes neutral and insufficient forecasts, and hides rates below 20 settled directions", () => {
  const rows = [
    ...Array.from({ length: 19 }, (_, index) => ({
      horizonDays: 1,
      forecastDirection: "bullish",
      status: "settled",
      actualDirection: index < 10 ? "bullish" : "bearish",
    })),
    {
      horizonDays: 1,
      forecastDirection: "neutral",
      status: "settled",
      actualDirection: "bullish",
    },
    {
      horizonDays: 1,
      forecastDirection: "insufficient",
      status: "pending",
      actualDirection: null,
    },
  ];
  const summaries = summarizeStockAiDirectionValidation(rows);
  assert.equal(summaries[0].directionalForecastCount, 19);
  assert.equal(summaries[0].evaluatedDirectionalForecastCount, 19);
  assert.equal(summaries[0].correctForecastCount, 10);
  assert.equal(summaries[0].neutralForecastCount, 1);
  assert.equal(summaries[0].insufficientForecastCount, 1);
  assert.equal(summaries[0].hitRatePercent, null);

  const enoughSamples = summarizeStockAiDirectionValidation([
    ...rows,
    {
      horizonDays: 1,
      forecastDirection: "bearish",
      status: "settled",
      actualDirection: "bearish",
    },
  ])[0];
  assert.equal(enoughSamples.hitRatePercent, 55);
});
