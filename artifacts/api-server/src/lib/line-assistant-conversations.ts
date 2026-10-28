import type { LineAssistantMessage } from "@workspace/db/schema";

export class LineAssistantStorageUnavailableError extends Error {
  constructor() {
    super("LINE assistant conversation storage is not configured.");
    this.name = "LineAssistantStorageUnavailableError";
  }
}

async function loadDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new LineAssistantStorageUnavailableError();
  }
  const [databaseModule, schemaModule, drizzleModule] = await Promise.all([
    import("@workspace/db"),
    import("@workspace/db/schema"),
    import("drizzle-orm"),
  ]);
  return {
    db: databaseModule.db,
    table: schemaModule.lineAssistantConversationsTable,
    eq: drizzleModule.eq,
  };
}

export async function getLineAssistantHistory(
  lineUserId: string,
): Promise<LineAssistantMessage[]> {
  const { db, table, eq } = await loadDatabase();
  const [row] = await db
    .select({ messages: table.messages })
    .from(table)
    .where(eq(table.lineUserId, lineUserId))
    .limit(1);
  return (row?.messages ?? []).slice(-12);
}

export async function saveLineAssistantTurn(
  lineUserId: string,
  userMessage: string,
  assistantMessage: string,
): Promise<void> {
  const { db, table, eq } = await loadDatabase();
  await db.transaction(async (tx) => {
    await tx
      .insert(table)
      .values({ lineUserId, messages: [] })
      .onConflictDoNothing({ target: table.lineUserId });
    const [row] = await tx
      .select({ messages: table.messages })
      .from(table)
      .where(eq(table.lineUserId, lineUserId))
      .for("update")
      .limit(1);
    if (!row) throw new Error("Unable to lock the LINE assistant conversation.");
    const messages: LineAssistantMessage[] = [
      ...row.messages,
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: assistantMessage },
    ].slice(-12);
    await tx
      .update(table)
      .set({ messages, updatedAt: new Date() })
      .where(eq(table.lineUserId, lineUserId));
  });
}

export async function appendLineAssistantTurn(
  lineUserId: string,
  assistantMessage: string,
): Promise<void> {
  const { db, table, eq } = await loadDatabase();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ messages: table.messages })
      .from(table)
      .where(eq(table.lineUserId, lineUserId))
      .for("update")
      .limit(1);
    if (!row) return;
    const messages: LineAssistantMessage[] = [
      ...row.messages,
      { role: "assistant" as const, content: assistantMessage },
    ].slice(-12);
    await tx
      .update(table)
      .set({ messages, updatedAt: new Date() })
      .where(eq(table.lineUserId, lineUserId));
  });
}

export async function clearLineAssistantHistory(lineUserId: string): Promise<void> {
  const { db, table, eq } = await loadDatabase();
  await db.delete(table).where(eq(table.lineUserId, lineUserId));
}

export async function setLineAssistantOwner(
  lineUserId: string,
  ownerUserId: string,
): Promise<void> {
  const { db, table } = await loadDatabase();
  await db
    .insert(table)
    .values({ lineUserId, ownerUserId, messages: [] })
    .onConflictDoUpdate({
      target: table.lineUserId,
      set: { ownerUserId, updatedAt: new Date() },
    });
}

export async function getLineAssistantOwner(
  lineUserId: string,
): Promise<string | null> {
  const { db, table, eq } = await loadDatabase();
  const [row] = await db
    .select({ ownerUserId: table.ownerUserId })
    .from(table)
    .where(eq(table.lineUserId, lineUserId))
    .limit(1);
  return row?.ownerUserId ?? null;
}
