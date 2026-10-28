export const STOCK_AI_PRICE_PLAN_VALIDATION_HORIZON_DAYS = 5;
export const STOCK_AI_PRICE_PLAN_MINIMUM_SAMPLE_COUNT = 20;

export const STOCK_AI_PRICE_PLAN_METHOD_NOTE =
  "只追蹤有完整進場、停損、目標價的買進方案；從判讀日後第一個官方交易日起，最多追蹤 5 個交易日。日線同時碰到停損與目標時，無法判定先後，列為模糊樣本，不計入勝率。未觸及進場、或進場後 5 日未觸及出場價也不計入勝率。這是價位先後觸及率，不含交易成本，也不等於獲利率。至少 20 筆已判定先後的交易才顯示勝率；資料未調整除權息與拆併股，相關期間可能影響結果。";

export type StockAiPricePlanStatus =
  | "pending"
  | "target_first"
  | "stop_first"
  | "no_entry"
  | "ambiguous"
  | "expired";

export type StockAiPricePlanForecast = {
  forecastDate: string;
  horizonDays: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
};

export type StockAiPricePlanDailyBar = {
  date: string;
  high: number;
  low: number;
};

export type StockAiPricePlanSettlement = {
  status: Exclude<StockAiPricePlanStatus, "pending">;
  outcomeDate: string | null;
};

export function evaluateStockAiPricePlan(
  forecast: StockAiPricePlanForecast,
  dailyBars: StockAiPricePlanDailyBar[],
): StockAiPricePlanSettlement | null {
  if (
    !Number.isInteger(forecast.horizonDays) ||
    forecast.horizonDays < 1 ||
    forecast.horizonDays > STOCK_AI_PRICE_PLAN_VALIDATION_HORIZON_DAYS ||
    !Number.isFinite(forecast.entryPrice) ||
    !Number.isFinite(forecast.stopLossPrice) ||
    !Number.isFinite(forecast.takeProfitPrice) ||
    !(forecast.stopLossPrice < forecast.entryPrice &&
      forecast.entryPrice < forecast.takeProfitPrice)
  ) return null;

  const bars = dailyBars
    .filter((bar) =>
      bar.date > forecast.forecastDate &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      bar.low > 0 &&
      bar.high >= bar.low,
    )
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, forecast.horizonDays);
  if (bars.length < forecast.horizonDays) return null;

  let entered = false;
  for (const bar of bars) {
    if (!entered) {
      if (bar.low > forecast.entryPrice || bar.high < forecast.entryPrice) continue;
      entered = true;
    }
    const stopTouched = bar.low <= forecast.stopLossPrice;
    const targetTouched = bar.high >= forecast.takeProfitPrice;
    if (stopTouched && targetTouched) {
      return { status: "ambiguous", outcomeDate: bar.date };
    }
    if (targetTouched) return { status: "target_first", outcomeDate: bar.date };
    if (stopTouched) return { status: "stop_first", outcomeDate: bar.date };
  }

  return {
    status: entered ? "expired" : "no_entry",
    outcomeDate: bars.at(-1)?.date ?? null,
  };
}

export type StockAiPricePlanValidationSummary = {
  forecastCount: number;
  pendingCount: number;
  targetFirstCount: number;
  stopFirstCount: number;
  noEntryCount: number;
  ambiguousCount: number;
  expiredCount: number;
  resolvedTradeCount: number;
  winRatePercent: number | null;
};

export function summarizeStockAiPricePlanValidation(
  statuses: StockAiPricePlanStatus[],
  minimumSampleCount = STOCK_AI_PRICE_PLAN_MINIMUM_SAMPLE_COUNT,
): StockAiPricePlanValidationSummary {
  const count = (status: StockAiPricePlanStatus) =>
    statuses.filter((item) => item === status).length;
  const targetFirstCount = count("target_first");
  const stopFirstCount = count("stop_first");
  const resolvedTradeCount = targetFirstCount + stopFirstCount;
  return {
    forecastCount: statuses.length,
    pendingCount: count("pending"),
    targetFirstCount,
    stopFirstCount,
    noEntryCount: count("no_entry"),
    ambiguousCount: count("ambiguous"),
    expiredCount: count("expired"),
    resolvedTradeCount,
    winRatePercent: resolvedTradeCount >= minimumSampleCount
      ? Math.round((targetFirstCount / resolvedTradeCount) * 1_000) / 10
      : null,
  };
}
