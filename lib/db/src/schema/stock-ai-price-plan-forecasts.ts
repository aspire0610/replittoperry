import { sql } from "drizzle-orm";
import {
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

export const stockAiPricePlanForecastsTable = pgTable(
  "stock_ai_price_plan_forecasts",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    forecastDate: date("forecast_date", { mode: "string" }).notNull(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull(),
    quoteAsOf: timestamp("quote_as_of", { withTimezone: true }).notNull(),
    referencePrice: numeric("reference_price", { precision: 18, scale: 6 }).notNull(),
    entryPrice: numeric("entry_price", { precision: 18, scale: 6 }).notNull(),
    stopLossPrice: numeric("stop_loss_price", { precision: 18, scale: 6 }).notNull(),
    takeProfitPrice: numeric("take_profit_price", { precision: 18, scale: 6 }).notNull(),
    status: text("status").notNull().default("pending"),
    outcomeDate: date("outcome_date", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("stock_ai_price_plan_forecasts_symbol_day_uidx").on(
      table.symbol,
      table.forecastDate,
    ),
    index("stock_ai_price_plan_forecasts_symbol_status_idx").on(
      table.symbol,
      table.status,
    ),
    check(
      "stock_ai_price_plan_forecasts_status_check",
      sql`${table.status} in ('pending', 'target_first', 'stop_first', 'no_entry', 'ambiguous', 'expired')`,
    ),
    check(
      "stock_ai_price_plan_forecasts_price_order_check",
      sql`${table.stopLossPrice} < ${table.entryPrice} and ${table.entryPrice} < ${table.takeProfitPrice}`,
    ),
  ],
);

export type StockAiPricePlanForecastRecord =
  typeof stockAiPricePlanForecastsTable.$inferSelect;
