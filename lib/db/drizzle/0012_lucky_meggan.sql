CREATE TABLE "ai_research_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"line_user_id" text,
	"channel" text DEFAULT 'web' NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"answer" text,
	"agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
