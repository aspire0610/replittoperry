import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const aiProviderCooldownsTable = pgTable(
  "ai_provider_cooldowns",
  {
    provider: text("provider").primaryKey(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    cooldownStatus: integer("cooldown_status"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const aiProviderLeasesTable = pgTable(
  "ai_provider_leases",
  {
    leaseId: text("lease_id").primaryKey(),
    provider: text("provider").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("ai_provider_leases_provider_expiry_idx").on(
      table.provider,
      table.expiresAt,
    ),
  ],
);
