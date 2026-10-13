import assert from "node:assert/strict";
import test from "node:test";
import { evaluateChipExhaustion } from "./chip-exhaustion.ts";

function makeBars(direction, latest) {
  const bars = Array.from({ length: 24 }, (_, index) => {
    const close =
      direction === "down" ? 124 - index : 80 + index;
    return {
      date: `2026-09-${String(index + 1).padStart(2, "0")}`,
      close,
      high: close + 1,
      low: close - 1,
      volume: 1_000,
    };
  });
  bars.push({
    date: "2026-10-01",
    close: latest.close,
    high: latest.high,
    low: latest.low,
    volume: 1_500,
  });
  return bars;
}

test("marks possible seller exhaustion only when price, volume, close location, and official flows align", () => {
  const bars = makeBars("down", { close: 101, high: 101.5, low: 99 });
  const result = evaluateChipExhaustion(bars, {
    status: "available",
    observedAt: "2026-10-01",
    totalNetShares: 10_000,
  });

  assert.equal(result.status, "seller_exhaustion");
  assert.match(result.label, /賣方力道/);
  assert.equal(result.details?.date, "2026-10-01");
});

test("marks possible buyer exhaustion when the combined evidence reverses", () => {
  const bars = makeBars("up", { close: 102, high: 105, low: 101 });
  const result = evaluateChipExhaustion(bars, {
    status: "available",
    observedAt: "2026-10-01",
    totalNetShares: -10_000,
  });

  assert.equal(result.status, "buyer_exhaustion");
  assert.match(result.label, /買方力道/);
});

test("does not combine institutional and price data from different dates", () => {
  const result = evaluateChipExhaustion(
    makeBars("down", { close: 101, high: 102, low: 99 }),
    {
      status: "available",
      observedAt: "2026-09-30",
      totalNetShares: 10_000,
    },
  );

  assert.equal(result.status, "unavailable");
  assert.match(result.explanation, /日期不同/u);
});

test("reports mixed evidence instead of forcing a signal", () => {
  const result = evaluateChipExhaustion(
    makeBars("down", { close: 97, high: 100, low: 96 }),
    {
      status: "available",
      observedAt: "2026-10-01",
      totalNetShares: 10_000,
    },
  );

  assert.equal(result.status, "mixed");
});

test("requires a minimum volume and history sample", () => {
  const shortHistory = evaluateChipExhaustion(
    makeBars("down", { close: 101, high: 102, low: 99 }).slice(0, 20),
    {
      status: "available",
      observedAt: "2026-09-20",
      totalNetShares: 10_000,
    },
  );

  assert.equal(shortHistory.status, "unavailable");
  assert.match(shortHistory.explanation, /21 個交易日/u);
});
