import assert from "node:assert/strict";
import test from "node:test";
import { aggregateFuturesPhoneBars, calculateFuturesPhoneLine } from "./futures-phone-line.ts";

function bars(values, start = "2026-11-04T00:45:00.000Z") {
  const base = Date.parse(start);
  return values.map(([low, high], index) => ({
    time: new Date(base + index * 60_000).toISOString(),
    open: low + 1,
    high,
    low,
    close: high - 1,
    volume: index + 1,
  }));
}

test("aggregates minute bars by Taipei session timeframe", () => {
  const source = bars([[9, 12], [8, 14], [10, 15], [11, 16], [12, 17], [13, 18]]);
  const result = aggregateFuturesPhoneBars(source, 5);
  assert.equal(result.length, 2);
  assert.equal(result[0].time, "2026-11-04T00:45:00.000Z");
  assert.equal(result[0].open, source[0].open);
  assert.equal(result[0].high, 17);
  assert.equal(result[0].low, 8);
  assert.equal(result[0].close, source[4].close);
  assert.equal(result[0].volume, 15);
  assert.equal(result[1].time, "2026-11-04T00:50:00.000Z");
  assert.equal(result[1].open, source[5].open);
  assert.equal(result[1].close, source[5].close);
});

test("confirms a bullish higher-low step after two windows", () => {
  const source = bars([[8, 12], [9, 14], [10, 15], [11, 16]]);
  const result = calculateFuturesPhoneLine(source, 1, 2);
  assert.equal(result.trend, "bullish");
  assert.equal(result.linePrice, 10);
  assert.equal(result.broken, false);
});

test("confirms a bearish lower-high step after two windows", () => {
  const source = bars([[8, 16], [9, 15], [7, 14], [6, 13]]);
  const result = calculateFuturesPhoneLine(source, 1, 2);
  assert.equal(result.trend, "bearish");
  assert.equal(result.linePrice, 14);
  assert.equal(result.broken, false);
});

test("flags price crossing the trailing line", () => {
  const bullish = bars([[8, 12], [9, 14], [10, 15], [11, 16], [7, 15]]);
  bullish[4].close = 8;
  const bearish = bars([[8, 16], [9, 15], [7, 14], [6, 13], [10, 18]]);
  bearish[4].close = 17;
  assert.equal(calculateFuturesPhoneLine(bullish, 1, 2).broken, true);
  assert.equal(calculateFuturesPhoneLine(bearish, 1, 2).broken, true);
});

test("keeps the line unavailable until enough bars exist", () => {
  const result = calculateFuturesPhoneLine(bars([[8, 12], [9, 14], [10, 15]]), 1, 2);
  assert.equal(result.trend, "neutral");
  assert.equal(result.linePrice, null);
  assert.equal(result.broken, null);
});
