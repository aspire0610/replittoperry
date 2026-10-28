CREATE TABLE "ai_provider_cooldowns" (
	"provider" text PRIMARY KEY NOT NULL,
	"cooldown_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_leases" (
	"lease_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ai_provider_leases_provider_expiry_idx" ON "ai_provider_leases" USING btree ("provider","expires_at");