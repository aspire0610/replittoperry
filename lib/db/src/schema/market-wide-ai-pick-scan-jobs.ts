import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const marketWideAiPickScanJobsTable = pgTable(
  "market_wide_ai_pick_scan_jobs",
  {
    id: serial("id").primaryKey(),
    status: text("status").notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    completedBatches: integer("completed_batches").notNull().default(0),
    failedBatches: integer("failed_batches").notNull().default(0),
    totalBatches: integer("total_batches").notNull().default(0),
    scannedCount: integer("scanned_count").notNull().default(0),
    candidateCount: integer("candidate_count").notNull().default(0),
    completedCandidates: integer("completed_candidates").notNull().default(0),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("market_wide_ai_pick_scan_jobs_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    uniqueIndex("market_wide_ai_pick_scan_jobs_single_active_uidx")
      .on(table.status)
      .where(sql`${table.status} in ('queued', 'running')`),
    check(
      "market_wide_ai_pick_scan_jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed')`,
    ),
    check(
      "market_wide_ai_pick_scan_jobs_progress_check",
      sql`${table.progress} between 0 and 100`,
    ),
  ],
);

export const insertMarketWideAiPickScanJobSchema = createInsertSchema(
  marketWideAiPickScanJobsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertMarketWideAiPickScanJob = z.infer<
  typeof insertMarketWideAiPickScanJobSchema
>;
export type MarketWideAiPickScanJob =
  typeof marketWideAiPickScanJobsTable.$inferSelect;
