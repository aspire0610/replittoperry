import { createInsertSchema } from "drizzle-zod";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export type LineAssistantMessage = {
  role: "user" | "assistant";
  content: string;
};

export const lineAssistantConversationsTable = pgTable(
  "line_assistant_conversations",
  {
    lineUserId: text("line_user_id").primaryKey(),
    ownerUserId: text("owner_user_id"),
    messages: jsonb("messages").$type<LineAssistantMessage[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const insertLineAssistantConversationSchema = createInsertSchema(
  lineAssistantConversationsTable,
).omit({ updatedAt: true });

export type InsertLineAssistantConversation = z.infer<
  typeof insertLineAssistantConversationSchema
>;
export type LineAssistantConversationRecord =
  typeof lineAssistantConversationsTable.$inferSelect;
