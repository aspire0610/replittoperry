import { createInsertSchema } from "drizzle-zod";
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const stockAiConversationsTable = pgTable(
  "stock_ai_conversations",
  {
    userId: text("user_id").notNull(),
    symbol: text("symbol").notNull(),
    messages: jsonb("messages").$type<unknown[]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.symbol],
      name: "stock_ai_conversations_pk",
    }),
  ],
);

export const insertStockAiConversationSchema = createInsertSchema(
  stockAiConversationsTable,
).omit({ updatedAt: true });

export type InsertStockAiConversation = z.infer<
  typeof insertStockAiConversationSchema
>;
export type StockAiConversationRecord =
  typeof stockAiConversationsTable.$inferSelect;