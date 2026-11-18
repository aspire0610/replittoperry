CREATE TABLE "paper_trading_automation" (
	"user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"starting_cash" numeric(18, 2) NOT NULL,
	"cash" numeric(18, 2) NOT NULL,
	"risk_per_trade_percent" numeric(5, 2) DEFAULT '0.5' NOT NULL,
	"daily_loss_limit_percent" numeric(5, 2) DEFAULT '2' NOT NULL,
	"max_open_positions" integer DEFAULT 3 NOT NULL,
	"state" jsonb DEFAULT '{"positions":[],"pendingEntries":[],"events":[],"dailyDate":null,"dailyStartEquity":null,"dailyStopTriggered":false,"lastProcessedAt":null}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
