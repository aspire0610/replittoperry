CREATE TABLE "line_assistant_conversations" (
	"line_user_id" text PRIMARY KEY NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
