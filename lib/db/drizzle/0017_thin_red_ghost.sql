CREATE TABLE "ai_stock_research_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"mission" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_market_date" text,
	"last_error" text,
	"reports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_stock_research_agents_user_symbol_idx" ON "ai_stock_research_agents" USING btree ("user_id","symbol");--> statement-breakpoint
CREATE INDEX "ai_stock_research_agents_due_idx" ON "ai_stock_research_agents" USING btree ("enabled","next_run_at");