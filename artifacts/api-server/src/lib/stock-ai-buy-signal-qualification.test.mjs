import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateStockAiBuySignalQualification,
  wilsonLowerBound,
} from "./stock-ai-buy-signal-qualification.ts";

test("does not qualify with too few perfect observations when the Wilson bound is below 80%", () => {
  const result = evaluateStockAiBuySignalQualification({
    directionSuccesses: 15,
    directionSampleCount: 15,
    pricePlanSuccesses: 15,
    pricePlanSampleCount: 15,
  });
  assert.equal(result.qualified, false);
  assert.equal(result.failures.length, 2);
  assert.ok((result.directionLowerBoundPercent ?? 100) < 80);
});

test("allows fewer than 100 samples when both Wilson lower bounds pass 80%", () => {
  const result = evaluateStockAiBuySignalQualification({
    directionSuccesses: 16,
    directionSampleCount: 16,
    pricePlanSuccesses: 16,
    pricePlanSampleCount: 16,
  });
  assert.equal(result.qualified, true);
  assert.ok((result.directionLowerBoundPercent ?? 0) >= 80);
  assert.ok((result.pricePlanLowerBoundPercent ?? 0) >= 80);
});

test("an observed 80 percent rate does not pass an 80 percent lower-confidence gate", () => {
  const result = evaluateStockAiBuySignalQualification({
    directionSuccesses: 80,
    directionSampleCount: 100,
    pricePlanSuccesses: 80,
    pricePlanSampleCount: 100,
  });
  assert.equal(result.qualified, false);
  assert.ok((result.directionLowerBoundPercent ?? 100) < 80);
  assert.ok((result.pricePlanLowerBoundPercent ?? 100) < 80);
});

test("requires both the five-day direction and price-plan lower bounds to pass", () => {
  const result = evaluateStockAiBuySignalQualification({
    directionSuccesses: 96,
    directionSampleCount: 100,
    pricePlanSuccesses: 80,
    pricePlanSampleCount: 100,
  });
  assert.equal(result.qualified, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /價位方案 95% 下限/);
});

test("qualifies only when both independent 95 percent lower bounds exceed 80 percent", () => {
  const result = evaluateStockAiBuySignalQualification({
    directionSuccesses: 96,
    directionSampleCount: 100,
    pricePlanSuccesses: 96,
    pricePlanSampleCount: 100,
  });
  assert.equal(result.qualified, true);
  assert.ok((result.directionLowerBoundPercent ?? 0) >= 80);
  assert.ok((result.pricePlanLowerBoundPercent ?? 0) >= 80);
});

test("rejects invalid counts rather than treating them as a qualified rate", () => {
  assert.equal(wilsonLowerBound(101, 100), null);
  const result = evaluateStockAiBuySignalQualification({
    directionSuccesses: 110,
    directionSampleCount: 100,
    pricePlanSuccesses: 96,
    pricePlanSampleCount: 100,
  });
  assert.equal(result.qualified, false);
  assert.ok(result.failures.some((failure) => failure.includes("5 日方向")));
});
