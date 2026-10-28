export const MARKET_WIDE_AI_PICK_HORIZON_DAYS = 5 as const;
export const MARKET_WIDE_AI_PICK_MINIMUM_SAMPLE_COUNT = 100;

export type MarketWideAiPickDailyBar = { date: string; close: number };

export function settleMarketWideAiPick(
  forecastDate: string,
  referencePrice: number,
  bars: MarketWideAiPickDailyBar[],
) {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null;
  const future = bars
    .filter((bar) =>
      bar.date > forecastDate &&
      Number.isFinite(bar.close) &&
      bar.close > 0
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  const target = future[MARKET_WIDE_AI_PICK_HORIZON_DAYS - 1];
  if (!target) return null;
  const actualReturnPercent = ((target.close - referencePrice) / referencePrice) * 100;
  return {
    targetTradingDate: target.date,
    actualClose: target.close,
    actualReturnPercent,
    actualDirection: target.close > referencePrice
      ? "bullish" as const
      : target.close < referencePrice
        ? "bearish" as const
        : "neutral" as const,
  };
}

export function summarizeMarketWideAiPickValidation(
  rows: Array<{ probabilityPercent: number; actualDirection: string }>,
) {
  const settledCount = rows.length;
  const correctCount = rows.filter((row) => row.actualDirection === "bullish").length;
  const brierScore = settledCount
    ? rows.reduce((sum, row) => {
        const probability = Math.min(1, Math.max(0, row.probabilityPercent / 100));
        const actual = row.actualDirection === "bullish" ? 1 : 0;
        return sum + (probability - actual) ** 2;
      }, 0) / settledCount
    : null;
  const hitRatePercent = settledCount >= MARKET_WIDE_AI_PICK_MINIMUM_SAMPLE_COUNT
    ? (correctCount / settledCount) * 100
    : null;
  const z = 1.959963984540054;
  const p = settledCount ? correctCount / settledCount : 0;
  const d = 1 + z * z / settledCount;
  const center = (p + z * z / (2 * settledCount)) / d;
  const margin = z * Math.sqrt(p * (1 - p) / settledCount + z * z / (4 * settledCount ** 2)) / d;
  return {
    sampleCount: settledCount,
    correctCount,
    hitRatePercent,
    lowerBoundPercent: hitRatePercent === null ? null : Math.max(0, center - margin) * 100,
    upperBoundPercent: hitRatePercent === null ? null : Math.min(1, center + margin) * 100,
    brierScore,
    minimumSampleCount: MARKET_WIDE_AI_PICK_MINIMUM_SAMPLE_COUNT,
  };
}
