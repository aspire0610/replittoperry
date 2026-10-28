import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";

type PgClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
};

type Pool = {
  connect: () => Promise<PgClient>;
};

export type ProviderLease = {
  provider: string;
  leaseId: string;
  backend: "postgres" | "process";
};

export type ProviderSlotResult =
  | { state: "acquired"; lease: ProviderLease }
  | { state: "cooldown"; remainingMs: number; status: number }
  | { state: "busy" };

const localLeases = new Map<
  string,
  Map<string, { expiresAt: number }>
>();
const localCooldowns = new Map<string, { until: number; status: number }>();
let poolPromise: Promise<Pool> | null = null;
let lastDatabaseWarningAt = 0;

async function getPool(): Promise<Pool> {
  if (process.env.AI_PROVIDER_COORDINATION_MODE === "memory") {
    throw new Error("In-memory AI provider coordination is enabled");
  }
  if (!poolPromise) {
    poolPromise = import("@workspace/db").then(
      (database) => database.pool as unknown as Pool,
    );
  }
  return poolPromise;
}

function reportDatabaseFallback(error: unknown): void {
  if (process.env.AI_PROVIDER_COORDINATION_MODE === "memory") return;
  const now = Date.now();
  if (now - lastDatabaseWarningAt < 60_000) return;
  lastDatabaseWarningAt = now;
  const errorCode =
    error && typeof error === "object" && "code" in error &&
    typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
      ? error.code
      : "coordination_store_unavailable";
  logger.warn(
    {
      operation: "ai_provider_coordination",
      reason: errorCode,
    },
    "Shared AI provider coordination unavailable; using per-process limits",
  );
}

function localAcquire(
  provider: string,
  maxConcurrent: number,
  leaseMs: number,
): ProviderSlotResult {
  const now = Date.now();
  const cooldown = localCooldowns.get(provider);
  if (cooldown && cooldown.until > now) {
    return {
      state: "cooldown",
      remainingMs: cooldown.until - now,
      status: cooldown.status,
    };
  }

  const providerLeases = localLeases.get(provider) ?? new Map();
  for (const [id, lease] of providerLeases) {
    if (lease.expiresAt <= now) providerLeases.delete(id);
  }
  localLeases.set(provider, providerLeases);
  if (providerLeases.size >= maxConcurrent) return { state: "busy" };

  const leaseId = randomUUID();
  providerLeases.set(leaseId, { expiresAt: now + leaseMs });
  return {
    state: "acquired",
    lease: { provider, leaseId, backend: "process" },
  };
}

export async function acquireProviderSlot(
  provider: string,
  maxConcurrent: number,
  leaseMs: number,
): Promise<ProviderSlotResult> {
  let client: PgClient | null = null;
  try {
    const pool = await getPool();
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [provider],
    );
    await client.query(
      "DELETE FROM ai_provider_leases WHERE provider = $1 AND expires_at <= now()",
      [provider],
    );
    const cooldown = await client.query(
      "SELECT cooldown_until, cooldown_status FROM ai_provider_cooldowns WHERE provider = $1",
      [provider],
    );
    const cooldownUntil = cooldown.rows[0]?.cooldown_until;
    const cooldownTime =
      cooldownUntil instanceof Date
        ? cooldownUntil.getTime()
        : typeof cooldownUntil === "string"
          ? Date.parse(cooldownUntil)
          : 0;
    const now = Date.now();
    if (cooldownTime > now) {
      await client.query("COMMIT");
      return {
        state: "cooldown",
        remainingMs: cooldownTime - now,
        status: Number(cooldown.rows[0]?.cooldown_status ?? 429),
      };
    }

    const active = await client.query(
      "SELECT count(*)::int AS active_count FROM ai_provider_leases WHERE provider = $1 AND expires_at > now()",
      [provider],
    );
    if (Number(active.rows[0]?.active_count ?? 0) >= maxConcurrent) {
      await client.query("COMMIT");
      return { state: "busy" };
    }

    const leaseId = randomUUID();
    await client.query(
      "INSERT INTO ai_provider_leases (lease_id, provider, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 millisecond'))",
      [leaseId, provider, leaseMs],
    );
    await client.query("COMMIT");
    return {
      state: "acquired",
      lease: { provider, leaseId, backend: "postgres" },
    };
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection may already have been dropped.
      }
    }
    reportDatabaseFallback(error);
    return localAcquire(provider, maxConcurrent, leaseMs);
  } finally {
    client?.release();
  }
}

export async function releaseProviderSlot(lease: ProviderLease): Promise<void> {
  if (lease.backend === "process") {
    localLeases.get(lease.provider)?.delete(lease.leaseId);
    return;
  }
  try {
    const pool = await getPool();
    await pool.connect().then(async (client) => {
      try {
        await client.query(
          "DELETE FROM ai_provider_leases WHERE lease_id = $1 AND provider = $2",
          [lease.leaseId, lease.provider],
        );
      } finally {
        client.release();
      }
    });
  } catch (error) {
    reportDatabaseFallback(error);
  }
}

export async function setProviderCooldown(
  provider: string,
  cooldownMs: number,
  status: number,
): Promise<void> {
  const cooldownUntil = Date.now() + cooldownMs;
  const current = localCooldowns.get(provider);
  if (!current || current.until < cooldownUntil) {
    localCooldowns.set(provider, { until: cooldownUntil, status });
  }
  try {
    const pool = await getPool();
    await pool.connect().then(async (client) => {
      try {
        await client.query(
          `INSERT INTO ai_provider_cooldowns (provider, cooldown_until, cooldown_status, updated_at)
           VALUES ($1, to_timestamp($2 / 1000.0), $3, now())
           ON CONFLICT (provider) DO UPDATE
           SET cooldown_until = GREATEST(
                 COALESCE(ai_provider_cooldowns.cooldown_until, '-infinity'::timestamptz),
                 EXCLUDED.cooldown_until
               ),
               cooldown_status = CASE
                 WHEN ai_provider_cooldowns.cooldown_until IS NULL
                   OR ai_provider_cooldowns.cooldown_until < EXCLUDED.cooldown_until
                 THEN EXCLUDED.cooldown_status
                 ELSE ai_provider_cooldowns.cooldown_status
               END,
               updated_at = now()`,
          [provider, cooldownUntil, status],
        );
      } finally {
        client.release();
      }
    });
  } catch (error) {
    reportDatabaseFallback(error);
  }
}

export function resetProviderCoordinationForTests(): void {
  localLeases.clear();
  localCooldowns.clear();
  poolPromise = null;
  lastDatabaseWarningAt = 0;
}
