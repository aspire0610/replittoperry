import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const stockAiHistoricalValidationSamplesTable = pgTable(
  "stock_ai_historical_validation_samples",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    promptVersion: text("prompt_version").notNull(),
    forecastDate: date("forecast_date", { mode: "string" }).notNull(),
    referencePrice: numeric("reference_price", { precision: 18, scale: 6 }).notNull(),
    forecastDirection: text("forecast_direction").notNull(),
    forecastProbabilityPercent: numeric("forecast_probability_percent", { precision: 5, scale: 2 }),
    action: text("action").notNull(),
    aiProvider: text("ai_provider"),
    entryPrice: numeric("entry_price", { precision: 18, scale: 6 }),
    stopLossPrice: numeric("stop_loss_price", { precision: 18, scale: 6 }),
    takeProfitPrice: numeric("take_profit_price", { precision: 18, scale: 6 }),
    actualClose: numeric("actual_close", { precision: 18, scale: 6 }).notNull(),
    actualDirection: text("actual_direction").notNull(),
    directionCorrect: boolean("direction_correct").notNull(),
    pricePlanOutcome: text("price_plan_outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_ai_historical_validation_symbol_version_day_uidx").on(
      table.symbol,
      table.promptVersion,
      table.forecastDate,
    ),
    index("stock_ai_historical_validation_symbol_version_idx").on(
      table.symbol,
      table.promptVersion,
    ),
    check(
      "stock_ai_historical_validation_direction_check",
      sql`${table.forecastDirection} in ('bullish', 'bearish', 'neutral', 'insufficient')`,
    ),
    check(
      "stock_ai_historical_validation_action_check",
      sql`${table.action} in ('buy', 'hold', 'sell', 'wait', 'insufficient')`,
    ),
    check(
      "stock_ai_historical_validation_actual_direction_check",
      sql`${table.actualDirection} in ('bullish', 'bearish', 'neutral')`,
    ),
    check(
      "stock_ai_historical_validation_plan_outcome_check",
      sql`${table.pricePlanOutcome} is null or ${table.pricePlanOutcome} in ('target_first', 'stop_first', 'no_entry', 'ambiguous', 'expired')`,
    ),
  ],
);

export const insertStockAiHistoricalValidationSampleSchema = createInsertSchema(
  stockAiHistoricalValidationSamplesTable,
).omit({ id: true, createdAt: true });

export type InsertStockAiHistoricalValidationSample = z.infer<
  typeof insertStockAiHistoricalValidationSampleSchema
>;
export type StockAiHistoricalValidationSample =
  typeof stockAiHistoricalValidationSamplesTable.$inferSelect;
