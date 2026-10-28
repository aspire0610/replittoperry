CREATE TABLE "market_wide_ai_pick_forecasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"forecast_date" date NOT NULL,
	"analyzed_at" timestamp with time zone NOT NULL,
	"reference_price" numeric(18, 6) NOT NULL,
	"reference_type" text NOT NULL,
	"probability_percent" integer NOT NULL,
	"ai_provider" text NOT NULL,
	"target_trading_date" date,
	"actual_close" numeric(18, 6),
	"actual_return_percent" numeric(12, 6),
	"actual_direction" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_at" timestamp with time zone,
	CONSTRAINT "market_wide_ai_pick_forecasts_reference_type_check" CHECK ("market_wide_ai_pick_forecasts"."reference_type" in ('verified_trade', 'official_daily_close')),
	CONSTRAINT "market_wide_ai_pick_forecasts_probability_check" CHECK ("market_wide_ai_pick_forecasts"."probability_percent" between 0 and 95),
	CONSTRAINT "market_wide_ai_pick_forecasts_actual_direction_check" CHECK ("market_wide_ai_pick_forecasts"."actual_direction" is null or "market_wide_ai_pick_forecasts"."actual_direction" in ('bullish', 'bearish', 'neutral')),
	CONSTRAINT "market_wide_ai_pick_forecasts_status_check" CHECK ("market_wide_ai_pick_forecasts"."status" in ('pending', 'settled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "market_wide_ai_pick_forecasts_ticker_day_uidx" ON "market_wide_ai_pick_forecasts" USING btree ("ticker","forecast_date");--> statement-breakpoint
CREATE INDEX "market_wide_ai_pick_forecasts_status_idx" ON "market_wide_ai_pick_forecasts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "market_wide_ai_pick_forecasts_date_idx" ON "market_wide_ai_pick_forecasts" USING btree ("forecast_date");