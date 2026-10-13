CREATE TABLE "stock_ai_direction_forecasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"forecast_date" date NOT NULL,
	"horizon_days" integer NOT NULL,
	"analyzed_at" timestamp with time zone NOT NULL,
	"quote_as_of" timestamp with time zone NOT NULL,
	"reference_price" numeric(18, 6) NOT NULL,
	"reference_type" text NOT NULL,
	"forecast_direction" text NOT NULL,
	"confidence" text NOT NULL,
	"ai_provider" text,
	"target_trading_date" date,
	"actual_close" numeric(18, 6),
	"actual_return_percent" numeric(12, 6),
	"actual_direction" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_at" timestamp with time zone,
	CONSTRAINT "stock_ai_direction_forecasts_horizon_days_check" CHECK ("stock_ai_direction_forecasts"."horizon_days" between 1 and 5),
	CONSTRAINT "stock_ai_direction_forecasts_reference_type_check" CHECK ("stock_ai_direction_forecasts"."reference_type" in ('verified_trade', 'official_daily_close')),
	CONSTRAINT "stock_ai_direction_forecasts_direction_check" CHECK ("stock_ai_direction_forecasts"."forecast_direction" in ('bullish', 'bearish', 'neutral', 'insufficient')),
	CONSTRAINT "stock_ai_direction_forecasts_actual_direction_check" CHECK ("stock_ai_direction_forecasts"."actual_direction" is null or "stock_ai_direction_forecasts"."actual_direction" in ('bullish', 'bearish', 'neutral')),
	CONSTRAINT "stock_ai_direction_forecasts_status_check" CHECK ("stock_ai_direction_forecasts"."status" in ('pending', 'settled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_ai_direction_forecasts_symbol_day_horizon_uidx" ON "stock_ai_direction_forecasts" USING btree ("symbol","forecast_date","horizon_days");--> statement-breakpoint
CREATE INDEX "stock_ai_direction_forecasts_symbol_status_idx" ON "stock_ai_direction_forecasts" USING btree ("symbol","status");