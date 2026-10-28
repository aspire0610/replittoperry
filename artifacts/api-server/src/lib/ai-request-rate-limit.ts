type RateLimitEntry = {
  resetAt: number;
  count: number;
};

type AiRequestIdentity = {
  clientKey: string;
  operationKey: string;
};

export function createAiRequestRateLimiter(options: {
  windowMs?: number;
  globalLimit?: number;
  operationLimit?: number;
} = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const globalLimit = options.globalLimit ?? 60;
  const operationLimit = options.operationLimit ?? 12;
  const globalEntries = new Map<string, RateLimitEntry>();
  const operationEntries = new Map<string, RateLimitEntry>();

  function consume(
    entries: Map<string, RateLimitEntry>,
    key: string,
    now: number,
    limit: number,
  ): boolean {
    const current = entries.get(key);
    if (current && current.resetAt > now) {
      if (current.count >= limit) return false;
      current.count += 1;
    } else {
      entries.set(key, { resetAt: now + windowMs, count: 1 });
    }
    return true;
  }

  function pruneExpired(entries: Map<string, RateLimitEntry>, now: number) {
    if (entries.size <= 2_000) return;
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
  }

  return {
    isLimited(identity: AiRequestIdentity, now = Date.now()): boolean {
      const allowedByGlobal = consume(
        globalEntries,
        identity.clientKey,
        now,
        globalLimit,
      );
      const operationKey = `${identity.clientKey}:${identity.operationKey}`;
      const allowedByOperation = consume(
        operationEntries,
        operationKey,
        now,
        operationLimit,
      );
      pruneExpired(globalEntries, now);
      pruneExpired(operationEntries, now);
      return !allowedByGlobal || !allowedByOperation;
    },
  };
}
