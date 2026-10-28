import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const marketWideAiPickForecastsTable = pgTable(
  "market_wide_ai_pick_forecasts",
  {
    id: serial("id").primaryKey(),
    ticker: text("ticker").notNull(),
    forecastDate: date("forecast_date", { mode: "string" }).notNull(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull(),
    referencePrice: numeric("reference_price", { precision: 18, scale: 6 }).notNull(),
    referenceType: text("reference_type").notNull(),
    probabilityPercent: integer("probability_percent").notNull(),
    aiProvider: text("ai_provider").notNull(),
    methodVersion: text("method_version").notNull().default("v1"),
    targetTradingDate: date("target_trading_date", { mode: "string" }),
    actualClose: numeric("actual_close", { precision: 18, scale: 6 }),
    actualReturnPercent: numeric("actual_return_percent", { precision: 12, scale: 6 }),
    actualDirection: text("actual_direction"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("market_wide_ai_pick_forecasts_ticker_day_uidx").on(
      table.ticker,
      table.forecastDate,
    ),
    index("market_wide_ai_pick_forecasts_status_idx").on(table.status),
    index("market_wide_ai_pick_forecasts_date_idx").on(table.forecastDate),
    check(
      "market_wide_ai_pick_forecasts_reference_type_check",
      sql`${table.referenceType} in ('verified_trade', 'official_daily_close')`,
    ),
    check(
      "market_wide_ai_pick_forecasts_probability_check",
      sql`${table.probabilityPercent} between 0 and 95`,
    ),
    check(
      "market_wide_ai_pick_forecasts_actual_direction_check",
      sql`${table.actualDirection} is null or ${table.actualDirection} in ('bullish', 'bearish', 'neutral')`,
    ),
    check(
      "market_wide_ai_pick_forecasts_status_check",
      sql`${table.status} in ('pending', 'settled')`,
    ),
  ],
);

export const insertMarketWideAiPickForecastSchema = createInsertSchema(
  marketWideAiPickForecastsTable,
).omit({ id: true, createdAt: true });

export type InsertMarketWideAiPickForecast = z.infer<
  typeof insertMarketWideAiPickForecastSchema
>;
export type MarketWideAiPickForecastRecord =
  typeof marketWideAiPickForecastsTable.$inferSelect;
