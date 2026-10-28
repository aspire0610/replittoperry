CREATE TABLE "stock_ai_historical_validation_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"prompt_version" text NOT NULL,
	"forecast_date" date NOT NULL,
	"reference_price" numeric(18, 6) NOT NULL,
	"forecast_direction" text NOT NULL,
	"action" text NOT NULL,
	"ai_provider" text,
	"entry_price" numeric(18, 6),
	"stop_loss_price" numeric(18, 6),
	"take_profit_price" numeric(18, 6),
	"actual_close" numeric(18, 6) NOT NULL,
	"actual_direction" text NOT NULL,
	"direction_correct" boolean NOT NULL,
	"price_plan_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_ai_historical_validation_direction_check" CHECK ("stock_ai_historical_validation_samples"."forecast_direction" in ('bullish', 'bearish', 'neutral', 'insufficient')),
	CONSTRAINT "stock_ai_historical_validation_action_check" CHECK ("stock_ai_historical_validation_samples"."action" in ('buy', 'hold', 'sell', 'wait', 'insufficient')),
	CONSTRAINT "stock_ai_historical_validation_actual_direction_check" CHECK ("stock_ai_historical_validation_samples"."actual_direction" in ('bullish', 'bearish', 'neutral')),
	CONSTRAINT "stock_ai_historical_validation_plan_outcome_check" CHECK ("stock_ai_historical_validation_samples"."price_plan_outcome" is null or "stock_ai_historical_validation_samples"."price_plan_outcome" in ('target_first', 'stop_first', 'no_entry', 'ambiguous', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_ai_historical_validation_symbol_version_day_uidx" ON "stock_ai_historical_validation_samples" USING btree ("symbol","prompt_version","forecast_date");--> statement-breakpoint
CREATE INDEX "stock_ai_historical_validation_symbol_version_idx" ON "stock_ai_historical_validation_samples" USING btree ("symbol","prompt_version");