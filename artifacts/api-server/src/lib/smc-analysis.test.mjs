import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDailySmc } from "./smc-analysis.ts";

function makeBars(length = 20) {
  return Array.from({ length }, (_, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    open: 12,
    high: 13,
    low: 11,
    close: 12,
  }));
}

test("marks an insufficient sample without inventing structure", () => {
  const result = analyzeDailySmc(makeBars(19));

  assert.equal(result.status, "insufficient");
  assert.equal(result.structure, "insufficient");
  assert.equal(result.latestBreak.kind, null);
  assert.deepEqual(result.fairValueGaps, []);
});

test("requires two later daily bars to confirm a swing", () => {
  const bars = makeBars();
  bars[15] = { ...bars[15], high: 20, low: 8 };
  bars[18] = { ...bars[18], high: 30, low: 7 };

  const result = analyzeDailySmc(bars);

  assert.equal(result.swingHigh.date.toISOString().slice(0, 10), "2026-01-16");
  assert.equal(result.swingHigh.price, 20);
  assert.equal(result.swingLow.date.toISOString().slice(0, 10), "2026-01-16");
  assert.equal(result.swingLow.price, 8);
});

test("detects a close-reclaimed sweep of a confirmed prior high", () => {
  const bars = makeBars();
  bars[10] = { ...bars[10], open: 14, high: 15, low: 13, close: 14.5 };
  bars[11] = { ...bars[11], open: 13, high: 14, low: 12, close: 13 };
  bars[12] = { ...bars[12], open: 13, high: 14, low: 12, close: 13 };
  bars[13] = { ...bars[13], open: 14.5, high: 16, low: 14.2, close: 14.8 };

  const result = analyzeDailySmc(bars);

  assert.equal(result.liquiditySweeps[0].side, "buy_side");
  assert.equal(
    result.liquiditySweeps[0].date.toISOString().slice(0, 10),
    "2026-01-14",
  );
  assert.equal(result.liquiditySweeps[0].level, 15);
  assert.equal(result.liquiditySweeps[0].wickExtreme, 16);
  assert.equal(result.liquiditySweeps[0].close, 14.8);
});

test("marks an upward close break and a candidate order block", () => {
  const bars = makeBars();
  bars[10] = { ...bars[10], open: 14, high: 15, low: 13, close: 14 };
  bars[11] = { ...bars[11], open: 13, high: 14, low: 12, close: 13 };
  bars[12] = { ...bars[12], open: 14, high: 14, low: 12, close: 13 };
  bars[13] = { ...bars[13], open: 14, high: 16.3, low: 13.8, close: 16 };
  for (let index = 14; index < bars.length; index += 1) {
    bars[index] = {
      ...bars[index],
      open: 16,
      high: 16.5,
      low: 15.5,
      close: 16.1,
    };
  }

  const result = analyzeDailySmc(bars);

  assert.equal(result.latestBreak.kind, "bullish_break");
  assert.equal(
    result.latestBreak.date.toISOString().slice(0, 10),
    "2026-01-14",
  );
  assert.equal(result.candidateOrderBlocks[0].direction, "bullish");
  assert.equal(
    result.candidateOrderBlocks[0].date.toISOString().slice(0, 10),
    "2026-01-13",
  );
  assert.equal(result.candidateOrderBlocks[0].lower, 12);
  assert.equal(result.candidateOrderBlocks[0].upper, 14);
  assert.equal(result.candidateOrderBlocks[0].status, "unretested");
  assert.equal(
    result.candidateOrderBlocks[0].breakDate.toISOString().slice(0, 10),
    "2026-01-14",
  );
});

test("finds a three-candle gap and tracks whether it is filled", () => {
  const bars = makeBars();
  bars[10] = { ...bars[10], open: 9.2, high: 10, low: 8.8, close: 9.7 };
  bars[11] = { ...bars[11], open: 10.1, high: 12, low: 9.9, close: 11.8 };
  bars[12] = { ...bars[12], open: 11.3, high: 12.2, low: 11, close: 11.9 };
  for (let index = 13; index < bars.length; index += 1) {
    bars[index] = {
      ...bars[index],
      open: 11.3,
      high: 12,
      low: 11.1,
      close: 11.7,
    };
  }

  const result = analyzeDailySmc(bars);

  assert.equal(result.fairValueGaps[0].direction, "bullish");
  assert.equal(
    result.fairValueGaps[0].date.toISOString().slice(0, 10),
    "2026-01-13",
  );
  assert.equal(result.fairValueGaps[0].lower, 10);
  assert.equal(result.fairValueGaps[0].upper, 11);
  assert.equal(result.fairValueGaps[0].status, "open");
});
