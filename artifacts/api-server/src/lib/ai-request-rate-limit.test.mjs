import assert from "node:assert/strict";
import test from "node:test";
import { createAiRequestRateLimiter } from "./ai-request-rate-limit.ts";

test("rate limits one operation without exhausting unrelated AI requests", () => {
  const limiter = createAiRequestRateLimiter({
    windowMs: 60_000,
    globalLimit: 20,
    operationLimit: 2,
  });
  const base = { clientKey: "client", operationKey: "assessment:2330" };

  assert.equal(limiter.isLimited(base, 1_000), false);
  assert.equal(limiter.isLimited(base, 1_001), false);
  assert.equal(limiter.isLimited(base, 1_002), true);
  assert.equal(limiter.isLimited({ ...base, operationKey: "assessment:2317" }, 1_003), false);
  assert.equal(limiter.isLimited({ ...base, operationKey: "summary" }, 1_004), false);
});

test("keeps an overall per-client ceiling across operations", () => {
  const limiter = createAiRequestRateLimiter({
    windowMs: 60_000,
    globalLimit: 2,
    operationLimit: 10,
  });
  assert.equal(limiter.isLimited({ clientKey: "client", operationKey: "one" }, 1_000), false);
  assert.equal(limiter.isLimited({ clientKey: "client", operationKey: "two" }, 1_001), false);
  assert.equal(limiter.isLimited({ clientKey: "client", operationKey: "three" }, 1_002), true);
});
