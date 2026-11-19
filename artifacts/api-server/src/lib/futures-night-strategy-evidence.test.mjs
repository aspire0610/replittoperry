import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFuturesNightEvidence } from "./futures-night-strategy-evidence.ts";
import { resolveFuturesSession } from "./futures-session.ts";

const time = (value) => Date.parse(`${value}+08:00`);
const source = "價格：Yuanta SPARK · TXF8；分 K：Yuanta SPARK · TXF8 逐筆成交彙整的一分 K";

function risingNightBars(now, count = 75) {
  const endMinute = Math.floor(now / 60_000) * 60_000 - 60_000;
  const start = endMinute - (count - 1) * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const close = 40_000 + index * 2;
    return {
      time: new Date(start + index * 60_000).toISOString(),
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
    };
  });
}

test("night evidence aggregates complete TXF8 bars across midnight", () => {
  const now = time("2026-11-06T02:00:45");
  const session = resolveFuturesSession(now);
  const bars = risingNightBars(now);
  const result = analyzeFuturesNightEvidence({
    bars,
    price: 40_128,
    quoteAsOf: new Date(now - 20_000),
    source,
    session,
    now,
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.evidence.direction, "long");
  assert.equal(result.evidence.trendBars.length, 13);
  assert.equal(result.evidence.minuteBars.length, 16);
  assert.ok(result.evidence.entryConfirmed);
  assert.equal(
    Date.parse(result.evidence.trendBars.at(-1).time) -
      Date.parse(result.evidence.trendBars[0].time),
    12 * 5 * 60_000,
  );
});

test("night evidence rejects day bars and missing one-minute data", () => {
  const now = time("2026-11-06T02:00:45");
  const session = resolveFuturesSession(now);
  const bars = risingNightBars(now);
  const dayBars = bars.map((bar) => ({
    ...bar,
    time: new Date(time("2026-11-05T08:45:00") + (Date.parse(bar.time) % 60_000)).toISOString(),
  }));
  const wrongSession = analyzeFuturesNightEvidence({
    bars: dayBars,
    price: 40_128,
    quoteAsOf: new Date(now - 20_000),
    source,
    session,
    now,
  });
  assert.equal(wrongSession.available, false);
  if (!wrongSession.available) assert.match(wrongSession.reason, /1 分 K 不足/u);

  const missingMinute = bars.filter((_, index) => index !== bars.length - 2);
  const gap = analyzeFuturesNightEvidence({
    bars: missingMinute,
    price: 40_128,
    quoteAsOf: new Date(now - 20_000),
    source,
    session,
    now,
  });
  assert.equal(gap.available, false);
});

test("night evidence rejects stale and date-only quotes", () => {
  const now = time("2026-11-06T02:00:45");
  const session = resolveFuturesSession(now);
  const bars = risingNightBars(now);
  for (const quoteAsOf of [
    new Date(now - 90_001),
    new Date(time("2026-11-06T00:00:00")),
  ]) {
    const result = analyzeFuturesNightEvidence({
      bars,
      price: 40_150,
      quoteAsOf,
      source,
      session,
      now,
    });
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, /報價/u);
  }
});
