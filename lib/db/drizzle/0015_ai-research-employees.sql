ALTER TABLE "ai_research_jobs"
  ADD COLUMN IF NOT EXISTS "employee_id" text,
  ADD COLUMN IF NOT EXISTS "scheduled_date" date;

CREATE UNIQUE INDEX IF NOT EXISTS "ai_research_jobs_employee_date_uidx"
  ON "ai_research_jobs" ("employee_id", "scheduled_date");

CREATE TABLE IF NOT EXISTS "ai_research_employees" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "symbol" text NOT NULL,
  "stock_name" text NOT NULL,
  "run_time" text NOT NULL,
  "time_zone" text DEFAULT 'Asia/Taipei' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_research_employees_user_active_idx"
  ON "ai_research_employees" ("user_id", "active");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_research_jobs_employee_id_ai_research_employees_id_fk'
  ) THEN
    ALTER TABLE "ai_research_jobs"
      ADD CONSTRAINT "ai_research_jobs_employee_id_ai_research_employees_id_fk"
      FOREIGN KEY ("employee_id") REFERENCES "ai_research_employees"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
