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

export const stockAiDirectionForecastsTable = pgTable(
  "stock_ai_direction_forecasts",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    forecastDate: date("forecast_date", { mode: "string" }).notNull(),
    horizonDays: integer("horizon_days").notNull(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull(),
    quoteAsOf: timestamp("quote_as_of", { withTimezone: true }).notNull(),
    referencePrice: numeric("reference_price", {
      precision: 18,
      scale: 6,
    }).notNull(),
    referenceType: text("reference_type").notNull(),
    forecastDirection: text("forecast_direction").notNull(),
    confidence: text("confidence").notNull(),
    aiProvider: text("ai_provider"),
    targetTradingDate: date("target_trading_date", { mode: "string" }),
    actualClose: numeric("actual_close", { precision: 18, scale: 6 }),
    actualReturnPercent: numeric("actual_return_percent", {
      precision: 12,
      scale: 6,
    }),
    actualDirection: text("actual_direction"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("stock_ai_direction_forecasts_symbol_day_horizon_uidx").on(
      table.symbol,
      table.forecastDate,
      table.horizonDays,
    ),
    index("stock_ai_direction_forecasts_symbol_status_idx").on(
      table.symbol,
      table.status,
    ),
    check(
      "stock_ai_direction_forecasts_horizon_days_check",
      sql`${table.horizonDays} between 1 and 5`,
    ),
    check(
      "stock_ai_direction_forecasts_reference_type_check",
      sql`${table.referenceType} in ('verified_trade', 'official_daily_close')`,
    ),
    check(
      "stock_ai_direction_forecasts_direction_check",
      sql`${table.forecastDirection} in ('bullish', 'bearish', 'neutral', 'insufficient')`,
    ),
    check(
      "stock_ai_direction_forecasts_actual_direction_check",
      sql`${table.actualDirection} is null or ${table.actualDirection} in ('bullish', 'bearish', 'neutral')`,
    ),
    check(
      "stock_ai_direction_forecasts_status_check",
      sql`${table.status} in ('pending', 'settled')`,
    ),
  ],
);

export const insertStockAiDirectionForecastSchema = createInsertSchema(
  stockAiDirectionForecastsTable,
).omit({ id: true, createdAt: true });

export type InsertStockAiDirectionForecast = z.infer<
  typeof insertStockAiDirectionForecastSchema
>;
export type StockAiDirectionForecastRecord =
  typeof stockAiDirectionForecastsTable.$inferSelect;
