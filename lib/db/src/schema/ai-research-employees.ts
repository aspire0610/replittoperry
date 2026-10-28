import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const aiResearchEmployeesTable = pgTable(
  "ai_research_employees",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    stockName: text("stock_name").notNull(),
    runTime: text("run_time").notNull(),
    timeZone: text("time_zone").notNull().default("Asia/Taipei"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ai_research_employees_user_active_idx").on(table.userId, table.active),
  ],
);

export type AiResearchEmployee = typeof aiResearchEmployeesTable.$inferSelect;
