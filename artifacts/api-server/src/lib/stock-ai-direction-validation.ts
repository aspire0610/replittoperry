import type {
  StockAiAssessment,
  StockAiDirectionValidation,
} from "@workspace/api-zod";
import { logger } from "./logger.js";
import {
  STOCK_AI_DIRECTION_VALIDATION_HORIZONS,
  STOCK_AI_DIRECTION_VALIDATION_METHOD_NOTE,
  STOCK_AI_DIRECTION_VALIDATION_MINIMUM_SAMPLE_COUNT,
  evaluateStockAiDirectionForecast,
  summarizeStockAiDirectionValidation,
  type StockAiDirectionDailyBar,
  type StockAiDirectionValidationRow,
} from "./stock-ai-direction-validation-utils.js";

type ForecastSnapshot = Pick<
  StockAiAssessment,
  | "aiProvider"
  | "analyzedAt"
  | "confidence"
  | "direction"
  | "quoteAsOf"
  | "referencePrice"
  | "referenceType"
  | "symbol"
> & {
  forecastDate: string;
};

function makeUnavailableValidation(
  source: string,
  message: string,
): StockAiDirectionValidation {
  return {
    status: "unavailable",
    source,
    updatedAt: null,
    minimumSampleCount: STOCK_AI_DIRECTION_VALIDATION_MINIMUM_SAMPLE_COUNT,
    horizons: summarizeStockAiDirectionValidation([]),
    message,
    methodNote: STOCK_AI_DIRECTION_VALIDATION_METHOD_NOTE,
  };
}

async function loadDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Forward direction validation database is not configured.");
  }

  const [databaseModule, schemaModule, drizzleModule] = await Promise.all([
    import("@workspace/db"),
    import("@workspace/db/schema"),
    import("drizzle-orm"),
  ]);
  return {
    db: databaseModule.db,
    table: schemaModule.stockAiDirectionForecastsTable,
    and: drizzleModule.and,
    eq: drizzleModule.eq,
  };
}

export async function recordAndEvaluateStockAiDirectionForecast(
  assessment: ForecastSnapshot,
  dailyBars: StockAiDirectionDailyBar[],
  source: string,
): Promise<StockAiDirectionValidation> {
  if (
    !assessment.quoteAsOf ||
    !Number.isFinite(assessment.quoteAsOf.getTime()) ||
    !assessment.forecastDate ||
    !Number.isFinite(assessment.referencePrice) ||
    assessment.referencePrice <= 0
  ) {
    return makeUnavailableValidation(
      source,
      "判讀缺少有效來源時間或參考價格，無法建立可驗證的前向樣本。",
    );
  }

  try {
    const { db, table, and, eq } = await loadDatabase();
    const horizons = [...STOCK_AI_DIRECTION_VALIDATION_HORIZONS];
    await db.transaction(async (transaction) => {
      await transaction
        .insert(table)
        .values(
          horizons.map((horizonDays) => ({
            symbol: assessment.symbol,
            forecastDate: assessment.forecastDate,
            horizonDays,
            analyzedAt: assessment.analyzedAt,
            quoteAsOf: assessment.quoteAsOf!,
            referencePrice: assessment.referencePrice.toFixed(6),
            referenceType: assessment.referenceType,
            forecastDirection: assessment.direction,
            confidence: assessment.confidence,
            aiProvider: assessment.aiProvider,
          })),
        )
        .onConflictDoNothing({
          target: [table.symbol, table.forecastDate, table.horizonDays],
        });

      const pendingForecasts = await transaction
        .select({
          id: table.id,
          forecastDate: table.forecastDate,
          horizonDays: table.horizonDays,
          referencePrice: table.referencePrice,
        })
        .from(table)
        .where(
          and(
            eq(table.symbol, assessment.symbol),
            eq(table.status, "pending"),
          ),
        );

      for (const forecast of pendingForecasts) {
        const settlement = evaluateStockAiDirectionForecast(
          {
            forecastDate: forecast.forecastDate,
            horizonDays: forecast.horizonDays,
            referencePrice: Number(forecast.referencePrice),
          },
          dailyBars,
        );
        if (!settlement) continue;
        await transaction
          .update(table)
          .set({
            status: "settled",
            targetTradingDate: settlement.targetTradingDate,
            actualClose: settlement.actualClose.toFixed(6),
            actualReturnPercent: settlement.actualReturnPercent.toFixed(6),
            actualDirection: settlement.actualDirection,
            evaluatedAt: new Date(),
          })
          .where(
            and(
              eq(table.id, forecast.id),
              eq(table.status, "pending"),
            ),
          );
      }
    });

    const records = await db
      .select({
        horizonDays: table.horizonDays,
        forecastDirection: table.forecastDirection,
        status: table.status,
        actualDirection: table.actualDirection,
      })
      .from(table)
      .where(eq(table.symbol, assessment.symbol));
    const validationRows: StockAiDirectionValidationRow[] = records.map(
      (record) => ({
        horizonDays: record.horizonDays,
        forecastDirection:
          record.forecastDirection as StockAiDirectionValidationRow["forecastDirection"],
        status: record.status as StockAiDirectionValidationRow["status"],
        actualDirection:
          record.actualDirection as StockAiDirectionValidationRow["actualDirection"],
      }),
    );

    return {
      status: "collecting",
      source,
      updatedAt: new Date(),
      minimumSampleCount: STOCK_AI_DIRECTION_VALIDATION_MINIMUM_SAMPLE_COUNT,
      horizons: summarizeStockAiDirectionValidation(validationRows),
      message: null,
      methodNote: STOCK_AI_DIRECTION_VALIDATION_METHOD_NOTE,
    };
  } catch (error) {
    logger.warn(
      { err: error, symbol: assessment.symbol },
      "Unable to record or evaluate stock AI direction forecast",
    );
    return makeUnavailableValidation(
      source,
      "前向追蹤資料庫目前無法使用；AI 判讀仍可查看，但本次不會計入驗證。",
    );
  }
}
