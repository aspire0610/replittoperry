export const STOCK_AI_HISTORICAL_VALIDATION_FORECAST_LIMIT = 20;

export type Direction = "bullish" | "bearish" | "neutral";

export function predictDirectionByCloseMomentum(
  closes: number[],
  forecastIndex: number,
  lookback = 20,
): Direction | null {
  if (
    !Number.isInteger(forecastIndex) ||
    !Number.isInteger(lookback) ||
    lookback < 1 ||
    forecastIndex < lookback ||
    forecastIndex >= closes.length
  ) return null;
  const current = closes[forecastIndex];
  const reference = closes[forecastIndex - lookback];
  if (
    typeof current !== "number" ||
    typeof reference !== "number" ||
    !Number.isFinite(current) ||
    !Number.isFinite(reference) ||
    current <= 0 ||
    reference <= 0
  ) return null;
  return current > reference ? "bullish" : current < reference ? "bearish" : "neutral";
}

export function calculateProbabilityCalibration(
  rows: Array<{ forecastProbabilityPercent: number | null; directionCorrect: boolean }>,
): { sampleCount: number; meanForecastProbabilityPercent: number | null; hitRatePercent: number | null; gapPercent: number | null } {
  const calibratedRows = rows.filter(
    (row): row is { forecastProbabilityPercent: number; directionCorrect: boolean } =>
      row.forecastProbabilityPercent !== null &&
      Number.isFinite(row.forecastProbabilityPercent) &&
      row.forecastProbabilityPercent >= 0 &&
      row.forecastProbabilityPercent <= 100,
  );
  if (!calibratedRows.length) {
    return { sampleCount: 0, meanForecastProbabilityPercent: null, hitRatePercent: null, gapPercent: null };
  }
  const meanForecastProbabilityPercent = calibratedRows.reduce(
    (sum, row) => sum + row.forecastProbabilityPercent,
    0,
  ) / calibratedRows.length;
  const hitRatePercent =
    (calibratedRows.filter((row) => row.directionCorrect).length / calibratedRows.length) * 100;
  return {
    sampleCount: calibratedRows.length,
    meanForecastProbabilityPercent,
    hitRatePercent,
    gapPercent: hitRatePercent - meanForecastProbabilityPercent,
  };
}

export function eligibleStockAiForecastIndexes(
  barCount: number,
  options: {
    lookbackBars?: number;
    forecastHorizon?: number;
    step?: number;
    limit?: number;
  } = {},
): number[] {
  const lookbackBars = options.lookbackBars ?? 40;
  const forecastHorizon = options.forecastHorizon ?? 5;
  const step = options.step ?? forecastHorizon;
  const limit = options.limit ?? STOCK_AI_HISTORICAL_VALIDATION_FORECAST_LIMIT;
  if (
    !Number.isInteger(barCount) ||
    !Number.isInteger(lookbackBars) ||
    !Number.isInteger(forecastHorizon) ||
    !Number.isInteger(step) ||
    !Number.isInteger(limit) ||
    barCount < 0 ||
    lookbackBars < 1 ||
    forecastHorizon < 1 ||
    step < 1 ||
    limit < 1
  ) {
    return [];
  }

  const lastForecastIndex = barCount - forecastHorizon - 1;
  const eligible: number[] = [];
  for (let index = lookbackBars - 1; index <= lastForecastIndex; index += step) {
    eligible.push(index);
  }
  return eligible.slice(-limit);
}
