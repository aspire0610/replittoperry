import { getStockHistory } from "./market-data.js";
import { logger } from "./logger.js";
import {
  MARKET_WIDE_AI_PICK_HORIZON_DAYS,
  summarizeMarketWideAiPickValidation,
  settleMarketWideAiPick,
  type MarketWideAiPickDailyBar,
} from "./market-wide-ai-pick-validation-utils.js";

export type MarketWideAiPickSnapshot = {
  ticker: string;
  forecastDate: string;
  analyzedAt: Date;
  referencePrice: number;
  referenceType: "verified_trade" | "official_daily_close";
  probabilityPercent: number;
  aiProvider: string;
};

export type MarketWideAiPickValidation = ReturnType<
  typeof summarizeMarketWideAiPickValidation
> & {
  status: "collecting" | "available" | "unavailable";
  horizonDays: typeof MARKET_WIDE_AI_PICK_HORIZON_DAYS;
  updatedAt: Date | null;
  methodNote: string;
};

const METHOD_NOTE =
  "保存每個交易日每檔入選股票第一次掃描時的 AI 五日收漲估計與參考價；第五個後續官方交易日收盤後結算。相同收盤價算方向未命中。至少 100 筆已結算樣本才顯示命中率；AI 預測不回填歷史。95% Wilson 區間未調整同日股票間的相關性，Brier 分數越低代表機率校準越好。";
const METHOD_VERSION = "v2";

async function loadDatabase() {
  if (!process.env.DATABASE_URL) throw new Error("Forward market-wide validation database is not configured.");
  const [databaseModule, schemaModule, drizzleModule] = await Promise.all([
    import("@workspace/db"),
    import("@workspace/db/schema"),
    import("drizzle-orm"),
  ]);
  return {
    db: databaseModule.db,
    table: schemaModule.marketWideAiPickForecastsTable,
    and: drizzleModule.and,
    eq: drizzleModule.eq,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

function unavailable(): MarketWideAiPickValidation {
  return {
    ...summarizeMarketWideAiPickValidation([]),
    status: "unavailable",
    horizonDays: MARKET_WIDE_AI_PICK_HORIZON_DAYS,
    updatedAt: null,
    methodNote: METHOD_NOTE,
  };
}

export async function recordAndEvaluateMarketWideAiPickForecasts(
  snapshots: MarketWideAiPickSnapshot[],
  currentMarketDate: string,
): Promise<MarketWideAiPickValidation> {
  try {
    const { db, table, and, eq } = await loadDatabase();
    if (snapshots.length > 0) {
      await db.insert(table).values(snapshots.map((snapshot) => ({
        ticker: snapshot.ticker,
        forecastDate: snapshot.forecastDate,
        analyzedAt: snapshot.analyzedAt,
        referencePrice: snapshot.referencePrice.toFixed(6),
        referenceType: snapshot.referenceType,
        probabilityPercent: snapshot.probabilityPercent,
        aiProvider: snapshot.aiProvider,
        methodVersion: METHOD_VERSION,
      }))).onConflictDoNothing({ target: [table.ticker, table.forecastDate] });
    }

    const pending = await db.select({
      id: table.id,
      ticker: table.ticker,
      forecastDate: table.forecastDate,
      referencePrice: table.referencePrice,
    }).from(table).where(eq(table.status, "pending"));
    const tickerGroups = new Map<string, typeof pending>();
    for (const row of pending) {
      const calendarDaysElapsed = (
        Date.parse(`${currentMarketDate}T00:00:00Z`) -
        Date.parse(`${row.forecastDate}T00:00:00Z`)
      ) / 86_400_000;
      if (row.forecastDate >= currentMarketDate || calendarDaysElapsed < 7) continue;
      const group = tickerGroups.get(row.ticker) ?? [];
      group.push(row);
      tickerGroups.set(row.ticker, group);
    }

    await mapWithConcurrency([...tickerGroups.entries()], 5, async ([ticker, rows]) => {
      try {
        const history = await getStockHistory(ticker, "1mo");
        const bars: MarketWideAiPickDailyBar[] = history.bars.map(({ date, close }) => ({ date, close }));
        for (const forecast of rows) {
          const outcome = settleMarketWideAiPick(
            forecast.forecastDate,
            Number(forecast.referencePrice),
            bars,
          );
          if (!outcome) continue;
          await db.update(table).set({
            status: "settled",
            targetTradingDate: outcome.targetTradingDate,
            actualClose: outcome.actualClose.toFixed(6),
            actualReturnPercent: outcome.actualReturnPercent.toFixed(6),
            actualDirection: outcome.actualDirection,
            evaluatedAt: new Date(),
          }).where(and(eq(table.id, forecast.id), eq(table.status, "pending")));
        }
      } catch (error) {
        logger.warn({ err: error, ticker }, "Unable to settle market-wide AI pick forecast");
      }
    });

    const settled = await db.select({
      probabilityPercent: table.probabilityPercent,
      actualDirection: table.actualDirection,
    }).from(table).where(and(
      eq(table.status, "settled"),
      eq(table.methodVersion, METHOD_VERSION),
    ));
    const result = summarizeMarketWideAiPickValidation(settled.flatMap((row) =>
      row.actualDirection === null
        ? []
        : [{ probabilityPercent: row.probabilityPercent, actualDirection: row.actualDirection }],
    ));
    return {
      ...result,
      status: result.hitRatePercent === null ? "collecting" : "available",
      horizonDays: MARKET_WIDE_AI_PICK_HORIZON_DAYS,
      updatedAt: new Date(),
      methodNote: METHOD_NOTE,
    };
  } catch (error) {
    logger.warn({ err: error }, "Unable to record or evaluate market-wide AI pick forecasts");
    return unavailable();
  }
}
