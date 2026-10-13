import { createInsertSchema } from "drizzle-zod";
import {
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const quantMarketSnapshotsTable = pgTable(
  "quant_market_snapshots",
  {
    exchange: text("exchange").notNull(),
    tradingDate: date("trading_date", { mode: "string" }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.exchange, table.tradingDate],
      name: "quant_market_snapshots_pk",
    }),
    index("quant_market_snapshots_trading_date_idx").on(table.tradingDate),
  ],
);

export const quantResearchRunsTable = pgTable(
  "quant_research_runs",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    hypothesis: text("hypothesis").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    dataStartDate: date("data_start_date", { mode: "string" }).notNull(),
    dataEndDate: date("data_end_date", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("quant_research_runs_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export const insertQuantResearchRunSchema = createInsertSchema(
  quantResearchRunsTable,
).omit({ id: true, createdAt: true });
export type InsertQuantResearchRun = z.infer<
  typeof insertQuantResearchRunSchema
>;
export type QuantResearchRunRecord = typeof quantResearchRunsTable.$inferSelect;
