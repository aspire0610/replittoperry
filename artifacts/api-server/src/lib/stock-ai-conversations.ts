import type {
  StockAiConversation,
  StockAiConversationMessage,
  StockAiConversationUpdate,
} from "@workspace/api-zod";

export class ConversationStorageUnavailableError extends Error {
  constructor() {
    super("Account conversation storage is not configured.");
    this.name = "ConversationStorageUnavailableError";
  }
}

async function loadDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new ConversationStorageUnavailableError();
  }

  const [databaseModule, schemaModule, drizzleModule] = await Promise.all([
    import("@workspace/db"),
    import("@workspace/db/schema"),
    import("drizzle-orm"),
  ]);

  return {
    db: databaseModule.db,
    table: schemaModule.stockAiConversationsTable,
    and: drizzleModule.and,
    eq: drizzleModule.eq,
  };
}

export async function getStockAiConversation(
  userId: string,
  symbol: string,
): Promise<StockAiConversation> {
  const { db, table, and, eq } = await loadDatabase();
  const [row] = await db
    .select({ messages: table.messages })
    .from(table)
    .where(and(eq(table.userId, userId), eq(table.symbol, symbol)))
    .limit(1);

  return {
    symbol,
    messages: (row?.messages ?? []) as StockAiConversationMessage[],
  };
}

export async function saveStockAiConversation(
  userId: string,
  conversation: StockAiConversationUpdate,
): Promise<StockAiConversation> {
  const { db, table } = await loadDatabase();
  const symbol = conversation.symbol.trim().toUpperCase();
  const messages = conversation.messages.slice(-50);
  const [row] = await db
    .insert(table)
    .values({ userId, symbol, messages })
    .onConflictDoUpdate({
      target: [table.userId, table.symbol],
      set: { messages, updatedAt: new Date() },
    })
    .returning({ messages: table.messages });

  return {
    symbol,
    messages: (row?.messages ?? messages) as StockAiConversationMessage[],
  };
}

export async function deleteStockAiConversation(
  userId: string,
  symbol: string,
): Promise<void> {
  const { db, table, and, eq } = await loadDatabase();
  await db
    .delete(table)
    .where(and(eq(table.userId, userId), eq(table.symbol, symbol)));
}