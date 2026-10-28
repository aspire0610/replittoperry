import { db, marketWideAiPickScanJobsTable as jobs } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { getTaiwanCalendarDayWindow } from "./market-wide-ai-pick-scan-day.js";

function taiwanDayPredicate(date: string) {
  return sql`(${jobs.createdAt} AT TIME ZONE 'Asia/Taipei')::date = ${date}::date`;
}

export async function getMarketWideAiPickScanJobForToday(now = new Date()) {
  const { date } = getTaiwanCalendarDayWindow(now);
  const [active] = await db
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running"]))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (active) return active;

  const [completed] = await db
    .select()
    .from(jobs)
    .where(and(taiwanDayPredicate(date), eq(jobs.status, "completed"), isNotNull(jobs.result)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (completed) return completed;
  const [job] = await db
    .select()
    .from(jobs)
    .where(taiwanDayPredicate(date))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return job ?? null;
}

export async function startMarketWideAiPickScanJob(
  now = new Date(),
  { force = false }: { force?: boolean } = {},
) {
  const { date } = getTaiwanCalendarDayWindow(now);
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`market-wide-ai-pick-scan:${date}`}, 0)
      )
    `);

    const [active] = await tx
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running"]))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (active) return active;

    if (!force) {
      const [completedToday] = await tx
        .select()
        .from(jobs)
        .where(and(taiwanDayPredicate(date), eq(jobs.status, "completed"), isNotNull(jobs.result)))
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      if (completedToday) return completedToday;

      const [today] = await tx
        .select()
        .from(jobs)
        .where(taiwanDayPredicate(date))
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      if (today) return today;
    }

    const [created] = await tx
      .insert(jobs)
      .values({ status: "queued", stage: "idle", progress: 0 })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [racedActive] = await tx
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running"]))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (racedActive) return racedActive;

    const [racedToday] = await tx
      .select()
      .from(jobs)
      .where(taiwanDayPredicate(date))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (!racedToday) throw new Error("Unable to enqueue market-wide AI scan");
    return racedToday;
  });
}

export async function getMarketWideAiPickScanJob(id: number) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return job ?? null;
}

export async function getLatestCompletedMarketWideAiPickScanJobBefore(date: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(
      eq(jobs.status, "completed"),
      isNotNull(jobs.result),
      sql`(((${jobs.result}->>'marketDate')::timestamptz AT TIME ZONE 'Asia/Taipei')::date < ${date}::date)`,
    ))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return job ?? null;
}

export async function claimMarketWideAiPickScanJob() {
  const [queued] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.status, "queued"))
    .orderBy(jobs.createdAt)
    .limit(1);
  if (!queued) return null;
  const [claimed] = await db
    .update(jobs)
    .set({ status: "running", stage: "market_data", startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(jobs.id, queued.id), eq(jobs.status, "queued")))
    .returning();
  return claimed ?? null;
}

export async function failStaleMarketWideAiPickScanJobs(now = new Date()) {
  const staleBefore = new Date(now.getTime() - 120_000);
  return db
    .update(jobs)
    .set({
      status: "failed",
      stage: "error",
      errorMessage: "掃描 worker 中斷；為避免同日重複掃描，未完成工作不會自動重跑。",
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(eq(jobs.status, "running"), lt(jobs.updatedAt, staleBefore)))
    .returning({ id: jobs.id });
}

export async function updateMarketWideAiPickScanJob(
  id: number,
  values: Partial<typeof jobs.$inferInsert>,
) {
  await db.update(jobs).set({ ...values, updatedAt: new Date() }).where(eq(jobs.id, id));
}
