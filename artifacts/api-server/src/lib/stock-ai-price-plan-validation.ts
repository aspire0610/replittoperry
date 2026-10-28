import type {
  StockAiAssessment,
  StockAiPricePlanValidation,
} from "@workspace/api-zod";
import { logger } from "./logger.js";
import {
  evaluateStockAiPricePlan,
  STOCK_AI_PRICE_PLAN_METHOD_NOTE,
  STOCK_AI_PRICE_PLAN_MINIMUM_SAMPLE_COUNT,
  STOCK_AI_PRICE_PLAN_VALIDATION_HORIZON_DAYS,
  summarizeStockAiPricePlanValidation,
  type StockAiPricePlanDailyBar,
  type StockAiPricePlanStatus,
} from "./stock-ai-price-plan-validation-utils.js";

type PricePlanSnapshot = Pick<
  StockAiAssessment,
  | "action"
  | "analyzedAt"
  | "entryPrice"
  | "pricePlanStatus"
  | "quoteAsOf"
  | "referencePrice"
  | "stopLossPrice"
  | "symbol"
  | "takeProfitPrice"
> & { forecastDate: string | null };

function unavailable(source: string, message: string): StockAiPricePlanValidation {
  return {
    status: "unavailable",
    source,
    updatedAt: null,
    minimumSampleCount: STOCK_AI_PRICE_PLAN_MINIMUM_SAMPLE_COUNT,
    forecastCount: 0,
    pendingCount: 0,
    targetFirstCount: 0,
    stopFirstCount: 0,
    noEntryCount: 0,
    ambiguousCount: 0,
    expiredCount: 0,
    resolvedTradeCount: 0,
    winRatePercent: null,
    message,
    methodNote: STOCK_AI_PRICE_PLAN_METHOD_NOTE,
  };
}

async function loadDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Price-plan validation database is not configured.");
  }
  const [databaseModule, schemaModule, drizzleModule] = await Promise.all([
    import("@workspace/db"),
    import("@workspace/db/schema"),
    import("drizzle-orm"),
  ]);
  return {
    db: databaseModule.db,
    table: schemaModule.stockAiPricePlanForecastsTable,
    and: drizzleModule.and,
    eq: drizzleModule.eq,
  };
}

export async function recordAndEvaluateStockAiPricePlan(
  assessment: PricePlanSnapshot,
  dailyBars: StockAiPricePlanDailyBar[],
  source: string,
): Promise<StockAiPricePlanValidation> {
  try {
    const { db, table, and, eq } = await loadDatabase();
    const hasValidBuyPlan =
      assessment.action === "buy" &&
      assessment.pricePlanStatus === "available" &&
      assessment.forecastDate !== null &&
      assessment.quoteAsOf !== null &&
      Number.isFinite(assessment.referencePrice) &&
      assessment.referencePrice > 0 &&
      assessment.entryPrice !== null &&
      assessment.stopLossPrice !== null &&
      assessment.takeProfitPrice !== null &&
      assessment.stopLossPrice < assessment.entryPrice &&
      assessment.entryPrice < assessment.takeProfitPrice;

    await db.transaction(async (transaction) => {
      if (hasValidBuyPlan) {
        await transaction.insert(table).values({
          symbol: assessment.symbol,
          forecastDate: assessment.forecastDate!,
          analyzedAt: assessment.analyzedAt,
          quoteAsOf: assessment.quoteAsOf!,
          referencePrice: assessment.referencePrice.toFixed(6),
          entryPrice: assessment.entryPrice!.toFixed(6),
          stopLossPrice: assessment.stopLossPrice!.toFixed(6),
          takeProfitPrice: assessment.takeProfitPrice!.toFixed(6),
        }).onConflictDoNothing({
          target: [table.symbol, table.forecastDate],
        });
      }

      const pending = await transaction
        .select({
          id: table.id,
          forecastDate: table.forecastDate,
          entryPrice: table.entryPrice,
          stopLossPrice: table.stopLossPrice,
          takeProfitPrice: table.takeProfitPrice,
        })
        .from(table)
        .where(and(eq(table.symbol, assessment.symbol), eq(table.status, "pending")));

      for (const forecast of pending) {
        const outcome = evaluateStockAiPricePlan({
          forecastDate: forecast.forecastDate,
          horizonDays: STOCK_AI_PRICE_PLAN_VALIDATION_HORIZON_DAYS,
          entryPrice: Number(forecast.entryPrice),
          stopLossPrice: Number(forecast.stopLossPrice),
          takeProfitPrice: Number(forecast.takeProfitPrice),
        }, dailyBars);
        if (!outcome) continue;
        await transaction.update(table).set({
          status: outcome.status,
          outcomeDate: outcome.outcomeDate,
          evaluatedAt: new Date(),
        }).where(and(eq(table.id, forecast.id), eq(table.status, "pending")));
      }
    });

    const records = await db.select({ status: table.status })
      .from(table)
      .where(eq(table.symbol, assessment.symbol));
    const summary = summarizeStockAiPricePlanValidation(
      records.map((record) => record.status as StockAiPricePlanStatus),
    );
    return {
      status: "collecting",
      source,
      updatedAt: new Date(),
      minimumSampleCount: STOCK_AI_PRICE_PLAN_MINIMUM_SAMPLE_COUNT,
      ...summary,
      message: null,
      methodNote: STOCK_AI_PRICE_PLAN_METHOD_NOTE,
    };
  } catch (error) {
    logger.warn(
      { err: error, symbol: assessment.symbol },
      "Unable to record or evaluate stock AI price-plan forecast",
    );
    return unavailable(
      source,
      "價位方案前向追蹤資料庫目前無法使用；本次不會計入勝率。",
    );
  }
}
