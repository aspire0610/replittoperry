import { and, desc, eq } from "drizzle-orm";
import { db, quantResearchRunsTable } from "@workspace/db";
import type { QuantSignalRule } from "./quant-signal-rules.js";

export type QuantResearchResultJson = {
  runId: number;
  hypothesis: string;
  tickerFilter?: string | null;
  rangeMonths: 3 | 6 | 12;
  startingCapital: number;
  topN: number;
  rebalance: "daily" | "weekly" | "monthly";
  strategy: {
    name: string;
    rationale: string;
    factorWeights: {
      momentum20: number;
      momentum60: number;
      liquidity20: number;
      lowVolatility20: number;
    };
    entryRule?: QuantSignalRule;
    exitRule?: QuantSignalRule;
    positionSizing?: {
      mode: "portfolio" | "fixed_shares" | "fixed_cash";
      sharesPerEntry: number | null;
      frequency: "daily" | "weekly" | "monthly";
      amountPerEntry?: number | null;
      weekday?: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | null;
    };
  };
  metrics: {
    totalReturnPercent: number;
    annualizedReturnPercent: number;
    maxDrawdownPercent: number;
    annualizedVolatilityPercent: number;
    sharpeRatio: number;
    tradeCount: number;
    closedTradeCount: number;
    winningTradeCount: number;
    winRatePercent: number | null;
    averageWinPercent?: number | null;
    averageLossPercent?: number | null;
    payoffRatio?: number | null;
    finalEquity: number;
    contributedCapital?: number;
    taiexReturnPercent: number;
  };
  equityCurve: Array<{
    date: string;
    equity: number;
    taiexEquity: number;
  }>;
  trades: Array<{
    date: string;
    ticker: string;
    name: string;
    side: "buy" | "sell";
    shares: number;
    price: number;
        slippageCost?: number;
    commission: number;
    transactionTax: number;
  }>;
  tradeLogTruncated: boolean;
  costStress?: {
    slippagePercentPerSide: number;
    costMultiplier: number;
    totalReturnPercent: number;
    maxDrawdownPercent: number;
    closedTradeCount: number;
    winRatePercent: number | null;
    averageWinPercent: number | null;
    averageLossPercent: number | null;
    payoffRatio: number | null;
  };
  timingComparison?: {
    calibrationStartDate: string;
    calibrationEndDate: string;
    validationStartDate: string;
    validationEndDate: string;
    selectedCandidate: string;
    calibrationCandidates: Array<{
      name: string;
      closedTradeCount: number;
      winRatePercent: number | null;
      totalReturnPercent: number;
      selected: boolean;
    }>;
    validation: {
      closedTradeCount: number;
      winRatePercent: number | null;
      totalReturnPercent: number;
      maxDrawdownPercent: number;
    };
  };
  aiSummary?: string | null;
  coverage: {
    requestedStartDate: string;
    dataStartDate: string;
    dataEndDate: string;
    tradingDays: number;
    eligibleSecurities: number;
    twseRows: number;
    tpexRows: number;
    fetchedDays: number;
    cachedDays: number;
    dataFingerprint: string;
    source: string;
  };
  // OpenRouter remains here only for previously saved research runs.
  aiProvider: "gemini" | "1min_ai" | "agnes_ai" | "groq" | "ollama" | "openrouter";
  createdAt: string;
  disclaimer: string;
};

export type QuantResearchResultDraft = Omit<QuantResearchResultJson, "runId">;

export async function saveQuantResearchRun(
  userId: string,
  result: QuantResearchResultDraft,
): Promise<QuantResearchResultJson> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(quantResearchRunsTable)
      .values({
        userId,
        hypothesis: result.hypothesis,
        result: result as unknown as Record<string, unknown>,
        dataStartDate: result.coverage.dataStartDate,
        dataEndDate: result.coverage.dataEndDate,
      })
      .returning({ id: quantResearchRunsTable.id });
    if (!created) {
      throw new Error("Research run was not saved.");
    }

    const savedResult: QuantResearchResultJson = {
      ...result,
      runId: created.id,
    };
    await tx
      .update(quantResearchRunsTable)
      .set({ result: savedResult as unknown as Record<string, unknown> })
      .where(
        and(
          eq(quantResearchRunsTable.id, created.id),
          eq(quantResearchRunsTable.userId, userId),
        ),
      );
    return savedResult;
  });
}

export async function listQuantResearchRuns(
  userId: string,
): Promise<
  Array<{
    runId: number;
    hypothesis: string;
    createdAt: string;
    totalReturnPercent: number;
    dataStartDate: string;
    dataEndDate: string;
  }>
> {
  const records = await db
    .select()
    .from(quantResearchRunsTable)
    .where(eq(quantResearchRunsTable.userId, userId))
    .orderBy(desc(quantResearchRunsTable.createdAt))
    .limit(100);
  return records.map((record) => {
    const result = record.result as Partial<QuantResearchResultJson>;
    return {
      runId: record.id,
      hypothesis: record.hypothesis,
      createdAt: record.createdAt.toISOString(),
      totalReturnPercent: Number(result.metrics?.totalReturnPercent ?? 0),
      dataStartDate: record.dataStartDate,
      dataEndDate: record.dataEndDate,
    };
  });
}

export async function deleteQuantResearchRuns(userId: string): Promise<void> {
  await db
    .delete(quantResearchRunsTable)
    .where(eq(quantResearchRunsTable.userId, userId));
}

export async function getQuantResearchRun(
  userId: string,
  runId: number,
): Promise<QuantResearchResultJson | null> {
  const [record] = await db
    .select({ result: quantResearchRunsTable.result })
    .from(quantResearchRunsTable)
    .where(
      and(
        eq(quantResearchRunsTable.id, runId),
        eq(quantResearchRunsTable.userId, userId),
      ),
    )
    .limit(1);
  if (!record) return null;
  const result = record.result as unknown as QuantResearchResultJson;
  if (result.runId !== runId) {
    throw new Error("Saved research result does not match its run identifier.");
  }
  return result;
}

export async function saveQuantResearchRunSummary(
  userId: string,
  runId: number,
  aiSummary: string,
): Promise<QuantResearchResultJson | null> {
  const [record] = await db
    .select({ result: quantResearchRunsTable.result })
    .from(quantResearchRunsTable)
    .where(
      and(
        eq(quantResearchRunsTable.id, runId),
        eq(quantResearchRunsTable.userId, userId),
      ),
    )
    .limit(1);
  if (!record) return null;

  const result = record.result as unknown as QuantResearchResultJson;
  if (result.runId !== runId) {
    throw new Error("Saved research result does not match its run identifier.");
  }
  if (result.aiSummary) return result;

  const updatedResult: QuantResearchResultJson = { ...result, aiSummary };
  await db
    .update(quantResearchRunsTable)
    .set({ result: updatedResult as unknown as Record<string, unknown> })
    .where(
      and(
        eq(quantResearchRunsTable.id, runId),
        eq(quantResearchRunsTable.userId, userId),
      ),
    );
  return updatedResult;
}
