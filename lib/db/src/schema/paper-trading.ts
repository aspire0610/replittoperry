import { createInsertSchema } from "drizzle-zod";
import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const paperTradingAccountsTable = pgTable(
  "paper_trading_accounts",
  {
    userId: text("user_id").primaryKey(),
    startingCash: numeric("starting_cash", { precision: 18, scale: 2 }).notNull(),
    cash: numeric("cash", { precision: 18, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export const paperTradingPositionsTable = pgTable(
  "paper_trading_positions",
  {
    userId: text("user_id").notNull(),
    ticker: text("ticker").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    shares: integer("shares").notNull(),
    averageCost: numeric("average_cost", {
      precision: 18,
      scale: 4,
    }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.ticker],
      name: "paper_trading_positions_pk",
    }),
    index("paper_trading_positions_user_idx").on(table.userId),
  ],
);

export const paperTradingTradesTable = pgTable(
  "paper_trading_trades",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    ticker: text("ticker").notNull(),
    name: text("name").notNull(),
    side: text("side").notNull(),
    shares: integer("shares").notNull(),
    price: numeric("price", { precision: 18, scale: 4 }).notNull(),
    grossAmount: numeric("gross_amount", {
      precision: 18,
      scale: 2,
    }).notNull(),
    commission: numeric("commission", {
      precision: 18,
      scale: 2,
    }).notNull(),
    transactionTax: numeric("transaction_tax", {
      precision: 18,
      scale: 2,
    }).notNull(),
    realizedPnl: numeric("realized_pnl", {
      precision: 18,
      scale: 2,
    }).notNull(),
    tradingDate: date("trading_date", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("paper_trading_trades_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export const insertPaperTradingTradeSchema = createInsertSchema(
  paperTradingTradesTable,
).omit({ id: true, createdAt: true });
export type InsertPaperTradingTrade = z.infer<
  typeof insertPaperTradingTradeSchema
>;
export type PaperTradingTradeRecord =
  typeof paperTradingTradesTable.$inferSelect;
