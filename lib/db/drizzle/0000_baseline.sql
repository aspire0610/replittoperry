CREATE TABLE IF NOT EXISTS "stock_ai_conversations" (
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"messages" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_ai_conversations_pk" PRIMARY KEY("user_id","symbol")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quant_market_snapshots" (
	"exchange" text NOT NULL,
	"trading_date" date NOT NULL,
	"payload" jsonb NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quant_market_snapshots_pk" PRIMARY KEY("exchange","trading_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quant_research_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"hypothesis" text NOT NULL,
	"result" jsonb NOT NULL,
	"data_start_date" date NOT NULL,
	"data_end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_trading_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"starting_cash" numeric(18, 2) NOT NULL,
	"cash" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_trading_positions" (
	"user_id" text NOT NULL,
	"ticker" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"shares" integer NOT NULL,
	"average_cost" numeric(18, 4) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_trading_positions_pk" PRIMARY KEY("user_id","ticker")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_trading_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"ticker" text NOT NULL,
	"name" text NOT NULL,
	"side" text NOT NULL,
	"shares" integer NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"gross_amount" numeric(18, 2) NOT NULL,
	"commission" numeric(18, 2) NOT NULL,
	"transaction_tax" numeric(18, 2) NOT NULL,
	"realized_pnl" numeric(18, 2) NOT NULL,
	"trading_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quant_market_snapshots_trading_date_idx" ON "quant_market_snapshots" USING btree ("trading_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quant_research_runs_user_created_idx" ON "quant_research_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_trading_positions_user_idx" ON "paper_trading_positions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_trading_trades_user_created_idx" ON "paper_trading_trades" USING btree ("user_id","created_at");