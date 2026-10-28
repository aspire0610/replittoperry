import { randomUUID } from "node:crypto";
import { db, aiStockResearchAgentsTable as agents } from "@workspace/db";
import { and, asc, eq, lte } from "drizzle-orm";
import type { AiStockResearchReport } from "@workspace/db/schema";

export function nextTaiwanCloseRunAt(from = new Date()) {
  const shifted = new Date(from.getTime() + 8 * 60 * 60 * 1000);
  let target = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    7,
    35,
  );
  if (target <= from.getTime()) target += 24 * 60 * 60 * 1000;
  return new Date(target);
}

export async function listStockResearchAgents(userId: string) {
  return db.select().from(agents).where(eq(agents.userId, userId)).orderBy(asc(agents.createdAt));
}

export async function createStockResearchAgent(input: {
  userId: string; symbol: string; name: string; mission: string;
}) {
  const now = new Date();
  const [agent] = await db.insert(agents).values({
    id: randomUUID(), userId: input.userId, symbol: input.symbol,
    name: input.name, mission: input.mission, enabled: true,
    nextRunAt: new Date(now.getTime() + 60_000),
  }).returning();
  return agent;
}

export async function setStockResearchAgentEnabled(userId: string, id: string, enabled: boolean) {
  const [agent] = await db.update(agents)
    .set({ enabled, nextRunAt: enabled ? new Date() : undefined, updatedAt: new Date() })
    .where(and(eq(agents.id, id), eq(agents.userId, userId))).returning();
  return agent ?? null;
}

export async function deleteStockResearchAgent(userId: string, id: string) {
  const [agent] = await db.delete(agents)
    .where(and(eq(agents.id, id), eq(agents.userId, userId))).returning({ id: agents.id });
  return Boolean(agent);
}

export async function claimDueStockResearchAgent(now = new Date()) {
  const [candidate] = await db.select().from(agents)
    .where(and(eq(agents.enabled, true), lte(agents.nextRunAt, now)))
    .orderBy(asc(agents.nextRunAt)).limit(1);
  if (!candidate) return null;
  const [claimed] = await db.update(agents).set({
    nextRunAt: nextTaiwanCloseRunAt(now),
    lastRunAt: now,
    lastError: null,
    updatedAt: now,
  }).where(and(eq(agents.id, candidate.id), eq(agents.enabled, true), lte(agents.nextRunAt, now))).returning();
  return claimed ?? null;
}

export async function saveStockResearchAgentReport(
  id: string,
  report: AiStockResearchReport,
) {
  const [current] = await db.select({ reports: agents.reports }).from(agents)
    .where(eq(agents.id, id)).limit(1);
  const reports = [report, ...(current?.reports ?? [])].slice(0, 90);
  await db.update(agents).set({
    reports,
    lastMarketDate: report.marketDate,
    lastError: report.status === "failed" ? report.error ?? "研究執行失敗" : null,
    updatedAt: new Date(),
  }).where(eq(agents.id, id));
}
