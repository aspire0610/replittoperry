import { randomUUID } from "node:crypto";
import type {
  AiResearchAgentTask,
  AiResearchJobStatus,
} from "@workspace/db/schema";

export type ResearchJobChannel = "web" | "line";
export type ResearchJobInput = {
  userId?: string;
  lineUserId?: string;
  channel: ResearchJobChannel;
};

export type ResearchAgent = AiResearchAgentTask;
export type ResearchJob = {
  id: string;
  userId: string | null;
  lineUserId: string | null;
  channel: ResearchJobChannel;
  question: string;
  status: AiResearchJobStatus;
  answer: string;
  agents: ResearchAgent[];
  createdAt: Date;
  updatedAt: Date;
};

async function loadStore() {
  if (!process.env.DATABASE_URL) throw new Error("Research storage is not configured.");
  const [databaseModule, schemaModule, drizzleModule] = await Promise.all([
    import("@workspace/db"),
    import("@workspace/db/schema"),
    import("drizzle-orm"),
  ]);
  return {
    db: databaseModule.db,
    table: schemaModule.aiResearchJobsTable,
    desc: drizzleModule.desc,
    eq: drizzleModule.eq,
    and: drizzleModule.and,
    asc: drizzleModule.asc,
    lt: drizzleModule.lt,
    isNull: drizzleModule.isNull,
    or: drizzleModule.or,
  };
}

export async function createResearchJob(input: {
  owner: ResearchJobInput;
  question: string;
  agents: ResearchAgent[];
  answer?: string;
}): Promise<ResearchJob> {
  const { db, table } = await loadStore();
  const now = new Date();
  const [row] = await db.insert(table).values({
    id: randomUUID(),
    userId: input.owner.userId ?? null,
    lineUserId: input.owner.lineUserId ?? null,
    channel: input.owner.channel,
    question: input.question,
    status: "queued",
    answer: input.answer ?? "",
    agents: input.agents,
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (!row) throw new Error("Unable to save CEO research job.");
  return row as ResearchJob;
}

export async function claimQueuedResearchJob(): Promise<ResearchJob | null> {
  const { db, table, eq, and, asc, isNull } = await loadStore();
  const [candidate] = await db.select().from(table)
    .where(and(eq(table.status, "queued"), isNull(table.employeeId)))
    .orderBy(asc(table.createdAt))
    .limit(1);
  if (!candidate) return null;
  const [claimed] = await db.update(table)
    .set({ status: "running", updatedAt: new Date() })
    .where(and(eq(table.id, candidate.id), eq(table.status, "queued")))
    .returning();
  return (claimed as ResearchJob | undefined) ?? null;
}

export async function requeueStaleResearchJobs(
  staleBefore = new Date(Date.now() - 10 * 60_000),
): Promise<number> {
  const { db, table, and, eq, isNull, lt } = await loadStore();
  const rows = await db.update(table)
    .set({ status: "queued", updatedAt: new Date() })
    .where(and(
      eq(table.status, "running"),
      isNull(table.employeeId),
      lt(table.updatedAt, staleBefore),
    ))
    .returning({ id: table.id });
  return rows.length;
}

export async function updateResearchJob(
  id: string,
  patch: {
    status?: AiResearchJobStatus;
    answer?: string;
    agents?: ResearchAgent[];
  },
): Promise<void> {
  const { db, table, eq } = await loadStore();
  await db.update(table).set({ ...patch, updatedAt: new Date() }).where(eq(table.id, id));
}

export async function listResearchJobs(
  userId: string,
  lineUserId?: string,
): Promise<ResearchJob[]> {
  const { db, table, desc, eq, or } = await loadStore();
  const ownership = [eq(table.userId, userId)];
  if (lineUserId) ownership.push(eq(table.lineUserId, lineUserId));
  return await db.select().from(table).where(or(...ownership)).orderBy(desc(table.createdAt)).limit(100) as ResearchJob[];
}
