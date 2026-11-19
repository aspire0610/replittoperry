import assert from "node:assert/strict";
import test from "node:test";
import { resolveYuantaSparkTickPriceScale, resolveYuantaSparkDateOnlyTickScale } from "./yuanta-spark-price-scale.ts";

test("recognizes matching quote and tick-bar scales", () => {
  assert.equal(resolveYuantaSparkTickPriceScale(43_376, 43_376), 1);
  assert.equal(resolveYuantaSparkTickPriceScale(4_337.6, 43_376), 10);
  assert.equal(resolveYuantaSparkTickPriceScale(4_300, 43_376), 10);
});

test("rejects unknown or invalid quote-to-bar ratios", () => {
  assert.equal(resolveYuantaSparkTickPriceScale(4_000, 43_376), null);
  assert.equal(resolveYuantaSparkTickPriceScale(0, 43_376), null);
  assert.equal(resolveYuantaSparkTickPriceScale(4_337.6, Number.NaN), null);
});

test("date-only quote validates same-day tick scale without becoming a live quote", () => {
  const midnight = new Date("2026-11-04T00:00:00+08:00");
  const lastBar = new Date("2026-11-04T13:44:00+08:00");
  assert.equal(resolveYuantaSparkDateOnlyTickScale(4320.4, 43204, midnight, lastBar), 10);
  assert.equal(resolveYuantaSparkDateOnlyTickScale(43204, 43204, midnight, lastBar), 1);
});

test("date-only references require exact prices and cannot weaken stale-quote checks", () => {
  const lastBar = new Date("2026-11-04T13:44:00+08:00");
  assert.equal(resolveYuantaSparkDateOnlyTickScale(4320.4, 43205, new Date("2026-11-04T00:00:00+08:00"), lastBar), null);
  assert.equal(resolveYuantaSparkDateOnlyTickScale(4320.4, 43204, new Date("2026-11-03T00:00:00+08:00"), lastBar), null);
  assert.equal(resolveYuantaSparkDateOnlyTickScale(4320.4, 43204, new Date("2026-11-04T12:00:00+08:00"), lastBar), null);
  assert.equal(resolveYuantaSparkDateOnlyTickScale(4320.4, 43204, null, lastBar), null);
  assert.equal(resolveYuantaSparkDateOnlyTickScale(4320.4, 43204, new Date(NaN), lastBar), null);
});
