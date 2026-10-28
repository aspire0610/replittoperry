import { eq } from "drizzle-orm";
import {
  aiResearchJobsTable,
  aiStockResearchAgentsTable,
  db,
  paperTradingAccountsTable,
  paperTradingPositionsTable,
  paperTradingTradesTable,
  quantResearchRunsTable,
  stockAiConversationsTable,
} from "@workspace/db";

export async function deleteAccountData(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(stockAiConversationsTable)
      .where(eq(stockAiConversationsTable.userId, userId));
    await tx
      .delete(aiResearchJobsTable)
      .where(eq(aiResearchJobsTable.userId, userId));
    await tx
      .delete(aiStockResearchAgentsTable)
      .where(eq(aiStockResearchAgentsTable.userId, userId));
    await tx
      .delete(quantResearchRunsTable)
      .where(eq(quantResearchRunsTable.userId, userId));
    await tx
      .delete(paperTradingTradesTable)
      .where(eq(paperTradingTradesTable.userId, userId));
    await tx
      .delete(paperTradingPositionsTable)
      .where(eq(paperTradingPositionsTable.userId, userId));
    await tx
      .delete(paperTradingAccountsTable)
      .where(eq(paperTradingAccountsTable.userId, userId));
  });
}
