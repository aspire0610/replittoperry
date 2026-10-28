import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export type AiStockResearchReport = {
  status: "completed" | "failed";
  marketDate: string | null;
  asOf: string;
  answer: string;
  assessment?: Record<string, unknown>;
  error?: string;
};

export const aiStockResearchAgentsTable = pgTable(
  "ai_stock_research_agents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    mission: text("mission").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastMarketDate: text("last_market_date"),
    lastError: text("last_error"),
    reports: jsonb("reports").$type<AiStockResearchReport[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_stock_research_agents_user_symbol_idx").on(table.userId, table.symbol),
    index("ai_stock_research_agents_due_idx").on(table.enabled, table.nextRunAt),
  ],
);

export type AiStockResearchAgent = typeof aiStockResearchAgentsTable.$inferSelect;
