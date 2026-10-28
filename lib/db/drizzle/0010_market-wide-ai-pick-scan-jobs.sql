CREATE TABLE "market_wide_ai_pick_scan_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"completed_batches" integer DEFAULT 0 NOT NULL,
	"failed_batches" integer DEFAULT 0 NOT NULL,
	"total_batches" integer DEFAULT 0 NOT NULL,
	"scanned_count" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "market_wide_ai_pick_scan_jobs_status_check" CHECK ("market_wide_ai_pick_scan_jobs"."status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "market_wide_ai_pick_scan_jobs_progress_check" CHECK ("market_wide_ai_pick_scan_jobs"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE INDEX "market_wide_ai_pick_scan_jobs_status_created_idx" ON "market_wide_ai_pick_scan_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_wide_ai_pick_scan_jobs_single_active_uidx" ON "market_wide_ai_pick_scan_jobs" USING btree ("status") WHERE "market_wide_ai_pick_scan_jobs"."status" in ('queued', 'running');