import assert from "node:assert/strict";
import test from "node:test";
import { analyzeGranvilleRules } from "./granville-analysis.ts";

function makeBars(closes, range = 1) {
  return closes.map((close, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1))
      .toISOString()
      .slice(0, 10);
    return {
      date,
      close,
      high: close + range,
      low: close - range,
    };
  });
}

function status(analysis, id) {
  return analysis.signals.find((signal) => signal.id === id)?.status;
}

test("Granville analysis requires enough daily history for its slope window", () => {
  const result = analyzeGranvilleRules(makeBars(Array(24).fill(100)));
  assert.equal(result.status, "insufficient");
  assert.ok(result.signals.every((signal) => signal.status === "insufficient"));
});

test("a flat moving average with no interaction produces no candidate signal", () => {
  const result = analyzeGranvilleRules(makeBars(Array(30).fill(100)));
  assert.equal(result.averageTrend, "flat");
  assert.ok(result.signals.every((signal) => signal.status === "not_detected"));
});

test("the eight Granville patterns are independently detected as candidates", () => {
  const breakoutCloses = Array(30).fill(100);
  breakoutCloses[28] = 99;
  breakoutCloses[29] = 101;
  assert.equal(
    status(analyzeGranvilleRules(makeBars(breakoutCloses)), "buy_breakout"),
    "candidate",
  );

  const risingCloses = Array.from({ length: 35 }, (_, index) => 90 + index * 0.5);
  const supportBars = makeBars(risingCloses);
  const supportAverage = risingCloses.slice(-20).reduce((sum, close) => sum + close, 0) / 20;
  supportBars.at(-1).low = supportAverage;
  assert.equal(
    status(analyzeGranvilleRules(supportBars), "buy_retest"),
    "candidate",
  );

  const falseBreakdownCloses = Array.from(
    { length: 35 },
    (_, index) => 90 + index * 0.5,
  );
  const falseBreakdownBars = makeBars(falseBreakdownCloses);
  const falseBreakdownAverage =
    falseBreakdownCloses.slice(-20).reduce((sum, close) => sum + close, 0) / 20;
  falseBreakdownBars.at(-1).low = falseBreakdownAverage - 0.1;
  assert.equal(
    status(
      analyzeGranvilleRules(falseBreakdownBars),
      "buy_false_breakdown",
    ),
    "candidate",
  );

  const fallingCloses = Array.from({ length: 35 }, (_, index) => 130 - index);
  const rebound = analyzeGranvilleRules(makeBars(fallingCloses));
  assert.equal(status(rebound, "buy_rebound"), "contextual");
  assert.match(
    rebound.signals.find((signal) => signal.id === "buy_rebound").explanation,
    /沒有固定門檻/,
  );

  const breakdownCloses = Array(30).fill(100);
  breakdownCloses[28] = 101;
  breakdownCloses[29] = 99;
  assert.equal(
    status(analyzeGranvilleRules(makeBars(breakdownCloses)), "sell_breakdown"),
    "candidate",
  );

  const resistanceCloses = Array.from(
    { length: 35 },
    (_, index) => 130 - index * 0.5,
  );
  const resistanceBars = makeBars(resistanceCloses);
  const resistanceAverage =
    resistanceCloses.slice(-20).reduce((sum, close) => sum + close, 0) / 20;
  resistanceBars.at(-1).close = resistanceAverage - 1;
  const adjustedResistanceAverage =
    (resistanceCloses.slice(-20, -1).reduce((sum, close) => sum + close, 0) +
      resistanceBars.at(-1).close) /
    20;
  resistanceBars.at(-1).high = adjustedResistanceAverage + 0.1;
  resistanceBars.at(-1).low = resistanceBars.at(-1).close - 2;
  assert.equal(
    status(analyzeGranvilleRules(resistanceBars), "sell_resistance"),
    "candidate",
  );

  const falseBreakoutCloses = Array.from(
    { length: 35 },
    (_, index) => 130 - index * 0.5,
  );
  const falseBreakoutBars = makeBars(falseBreakoutCloses);
  const falseBreakoutAverage =
    falseBreakoutCloses.slice(-20).reduce((sum, close) => sum + close, 0) / 20;
  falseBreakoutBars.at(-1).high = falseBreakoutAverage + 0.1;
  assert.equal(
    status(
      analyzeGranvilleRules(falseBreakoutBars),
      "sell_false_breakout",
    ),
    "candidate",
  );

  const overextensionCloses = Array.from(
    { length: 35 },
    (_, index) => 90 + index * 0.5,
  );
  const overextension = analyzeGranvilleRules(makeBars(overextensionCloses));
  assert.equal(
    status(overextension, "sell_overextension"),
    "contextual",
  );
  assert.match(
    overextension.signals.find((signal) => signal.id === "sell_overextension")
      .explanation,
    /沒有固定門檻/,
  );
});
