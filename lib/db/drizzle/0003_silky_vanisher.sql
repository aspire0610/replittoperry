CREATE TABLE "stock_ai_price_plan_forecasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"forecast_date" date NOT NULL,
	"analyzed_at" timestamp with time zone NOT NULL,
	"quote_as_of" timestamp with time zone NOT NULL,
	"reference_price" numeric(18, 6) NOT NULL,
	"entry_price" numeric(18, 6) NOT NULL,
	"stop_loss_price" numeric(18, 6) NOT NULL,
	"take_profit_price" numeric(18, 6) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_at" timestamp with time zone,
	CONSTRAINT "stock_ai_price_plan_forecasts_status_check" CHECK ("stock_ai_price_plan_forecasts"."status" in ('pending', 'target_first', 'stop_first', 'no_entry', 'ambiguous', 'expired')),
	CONSTRAINT "stock_ai_price_plan_forecasts_price_order_check" CHECK ("stock_ai_price_plan_forecasts"."stop_loss_price" < "stock_ai_price_plan_forecasts"."entry_price" and "stock_ai_price_plan_forecasts"."entry_price" < "stock_ai_price_plan_forecasts"."take_profit_price")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_ai_price_plan_forecasts_symbol_day_uidx" ON "stock_ai_price_plan_forecasts" USING btree ("symbol","forecast_date");--> statement-breakpoint
CREATE INDEX "stock_ai_price_plan_forecasts_symbol_status_idx" ON "stock_ai_price_plan_forecasts" USING btree ("symbol","status");