export const STOCK_AI_DIRECTION_VALIDATION_HORIZONS = [1, 2, 3, 4, 5] as const;
export const STOCK_AI_DIRECTION_VALIDATION_MINIMUM_SAMPLE_COUNT = 20;

export const STOCK_AI_DIRECTION_VALIDATION_METHOD_NOTE =
  "每檔股票每天只記第一次 AI 判讀；以判讀日之後第 N 個官方交易日收盤價，和判讀時的參考價比較方向。預測中性或資料不足不計入命中率；相同收盤價視為中性。每個期間至少累積 20 筆已結算的上漲／下跌判讀才顯示百分比。只從啟用後累積，不回填舊預測；未還原除權息或拆併股。";

export type StockAiForecastDirection =
  | "bullish"
  | "bearish"
  | "neutral"
  | "insufficient";

export type StockAiDirectionOutcome = "bullish" | "bearish" | "neutral";

export type StockAiForecastStatus = "pending" | "settled";

export type StockAiDirectionValidationRow = {
  horizonDays: number;
  forecastDirection: StockAiForecastDirection;
  status: StockAiForecastStatus;
  actualDirection: StockAiDirectionOutcome | null;
};

export type StockAiDirectionValidationHorizonSummary = {
  horizonDays: number;
  forecastCount: number;
  directionalForecastCount: number;
  evaluatedDirectionalForecastCount: number;
  correctForecastCount: number;
  pendingDirectionalForecastCount: number;
  neutralForecastCount: number;
  insufficientForecastCount: number;
  hitRatePercent: number | null;
};

export type StockAiDirectionDailyBar = {
  date: string;
  close: number;
};

export type StockAiDirectionForecastToSettle = {
  forecastDate: string;
  horizonDays: number;
  referencePrice: number;
};

export type StockAiDirectionSettlement = {
  targetTradingDate: string;
  actualClose: number;
  actualReturnPercent: number;
  actualDirection: StockAiDirectionOutcome;
};

export function toTaiwanTradingDate(value: Date): string | null {
  if (!Number.isFinite(value.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function evaluateStockAiDirectionForecast(
  forecast: StockAiDirectionForecastToSettle,
  dailyBars: StockAiDirectionDailyBar[],
): StockAiDirectionSettlement | null {
  if (
    !Number.isInteger(forecast.horizonDays) ||
    forecast.horizonDays < 1 ||
    forecast.horizonDays > 5 ||
    !Number.isFinite(forecast.referencePrice) ||
    forecast.referencePrice <= 0
  ) {
    return null;
  }

  const futureBars = dailyBars
    .filter(
      (bar) =>
        bar.date > forecast.forecastDate &&
        Number.isFinite(bar.close) &&
        bar.close > 0,
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  const target = futureBars[forecast.horizonDays - 1];
  if (!target) return null;

  const actualReturnPercent =
    ((target.close - forecast.referencePrice) / forecast.referencePrice) * 100;
  const roundedReturn = Math.round(actualReturnPercent * 1_000_000) / 1_000_000;
  return {
    targetTradingDate: target.date,
    actualClose: target.close,
    actualReturnPercent: roundedReturn,
    actualDirection:
      target.close > forecast.referencePrice
        ? "bullish"
        : target.close < forecast.referencePrice
          ? "bearish"
          : "neutral",
  };
}

export function summarizeStockAiDirectionValidation(
  rows: StockAiDirectionValidationRow[],
  minimumSampleCount = STOCK_AI_DIRECTION_VALIDATION_MINIMUM_SAMPLE_COUNT,
): StockAiDirectionValidationHorizonSummary[] {
  return STOCK_AI_DIRECTION_VALIDATION_HORIZONS.map((horizonDays) => {
    const horizonRows = rows.filter((row) => row.horizonDays === horizonDays);
    const directionalRows = horizonRows.filter(
      (row) =>
        row.forecastDirection === "bullish" ||
        row.forecastDirection === "bearish",
    );
    const evaluatedDirectionalRows = directionalRows.filter(
      (row) => row.status === "settled" && row.actualDirection !== null,
    );
    const correctForecastCount = evaluatedDirectionalRows.filter(
      (row) => row.forecastDirection === row.actualDirection,
    ).length;
    const evaluatedDirectionalForecastCount =
      evaluatedDirectionalRows.length;

    return {
      horizonDays,
      forecastCount: horizonRows.length,
      directionalForecastCount: directionalRows.length,
      evaluatedDirectionalForecastCount,
      correctForecastCount,
      pendingDirectionalForecastCount:
        directionalRows.length - evaluatedDirectionalForecastCount,
      neutralForecastCount: horizonRows.filter(
        (row) => row.forecastDirection === "neutral",
      ).length,
      insufficientForecastCount: horizonRows.filter(
        (row) => row.forecastDirection === "insufficient",
      ).length,
      hitRatePercent:
        evaluatedDirectionalForecastCount >= minimumSampleCount
          ? Math.round(
              (correctForecastCount / evaluatedDirectionalForecastCount) *
                1_000,
            ) / 10
          : null,
    };
  });
}
