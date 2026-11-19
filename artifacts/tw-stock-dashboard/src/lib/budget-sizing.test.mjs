import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBudgetLotEstimate,
  calculateBudgetShareLimit,
  calculateRoundTripEstimate,
  isCurrentVerifiedEntryCandidate,
  isTaiwanStockBudgetEntryWindow,
  TAIWAN_STOCK_BUY_COMMISSION_RATE,
  TAIWAN_STOCK_SHARES_PER_LOT,
} from "./budget-sizing.ts";

test("calculates the largest whole-share amount within budget and estimated buy fee", () => {
  const budget = 1_000;
  const price = 30;
  const shares = calculateBudgetShareLimit(budget, price);

  assert.equal(shares, 33);
  assert.ok(shares * price * (1 + TAIWAN_STOCK_BUY_COMMISSION_RATE) <= budget);
  assert.ok((shares + 1) * price * (1 + TAIWAN_STOCK_BUY_COMMISSION_RATE) > budget);
});

test("returns zero when the budget cannot cover one share", () => {
  assert.equal(calculateBudgetShareLimit(20, 50), 0);
});

test("does not estimate shares for missing or invalid budget values", () => {
  assert.equal(calculateBudgetShareLimit(0, 50), null);
  assert.equal(calculateBudgetShareLimit(1_000, 0), null);
  assert.equal(calculateBudgetShareLimit(Number.NaN, 50), null);
});

test("estimates affordable whole lots and includes buy commission", () => {
  const budget = 50_000;
  const price = 40;
  const estimate = calculateBudgetLotEstimate(budget, price);

  assert.ok(estimate);
  assert.equal(estimate.lots, 1);
  assert.equal(estimate.shares, TAIWAN_STOCK_SHARES_PER_LOT);
  assert.equal(estimate.estimatedBuyNotional, 40_000);
  assert.equal(
    estimate.estimatedBuyCommission,
    40_000 * TAIWAN_STOCK_BUY_COMMISSION_RATE,
  );
  assert.ok(estimate.estimatedBuyCost <= budget);
  assert.ok(
    (estimate.shares + TAIWAN_STOCK_SHARES_PER_LOT) *
      price *
      (1 + TAIWAN_STOCK_BUY_COMMISSION_RATE) >
      budget,
  );
});

test("returns zero whole lots when the budget only covers odd shares", () => {
  const estimate = calculateBudgetLotEstimate(50_000, 60);

  assert.ok(estimate);
  assert.equal(estimate.lots, 0);
  assert.equal(estimate.shares, 0);
  assert.equal(estimate.estimatedBuyCost, 0);
});

test("accepts only a fresh verified quote inside the current conditional entry zone", () => {
  const now = Date.parse("2026-11-11T02:30:00.000Z");
  const candidate = {
    referenceType: "verified_trade",
    referenceAsOf: new Date(now - 60_000).toISOString(),
    referencePrice: 40,
    operationPlan: {
      action: "conditional_entry",
      entryPrice: 41,
      stopPrice: 38,
      targetPrice: 47,
    },
  };

  assert.equal(isTaiwanStockBudgetEntryWindow(now), true);
  assert.equal(isCurrentVerifiedEntryCandidate(candidate, now), true);
  assert.equal(
    isCurrentVerifiedEntryCandidate({
      ...candidate,
      referenceType: "official_daily_close",
    }, now),
    false,
  );
  assert.equal(
    isCurrentVerifiedEntryCandidate({
      ...candidate,
      referenceAsOf: new Date(now - 181_000).toISOString(),
    }, now),
    false,
  );
  assert.equal(
    isCurrentVerifiedEntryCandidate({
      ...candidate,
      operationPlan: { ...candidate.operationPlan, action: "wait_for_pullback" },
    }, now),
    false,
  );
  assert.equal(
    isCurrentVerifiedEntryCandidate({
      ...candidate,
      referencePrice: 37,
    }, now),
    false,
  );
});

test("does not mark an after-market quote as a current entry", () => {
  const afterMarket = Date.parse("2026-11-11T06:00:00.000Z");
  assert.equal(isTaiwanStockBudgetEntryWindow(afterMarket), false);
});

test("estimates round-trip cash flow and profit after standard commissions, before tax", () => {
  const estimate = calculateRoundTripEstimate(100, 110, 1_000);

  assert.ok(estimate);
  assert.equal(estimate.buyNotional, 100_000);
  assert.equal(
    estimate.buyCommission,
    100_000 * TAIWAN_STOCK_BUY_COMMISSION_RATE,
  );
  assert.equal(estimate.sellNotional, 110_000);
  assert.equal(
    estimate.sellCommission,
    110_000 * TAIWAN_STOCK_BUY_COMMISSION_RATE,
  );
  assert.equal(
    estimate.estimatedProfitLossBeforeTax,
    10_000 -
      210_000 * TAIWAN_STOCK_BUY_COMMISSION_RATE,
  );
});

test("rejects invalid prices and non-whole share counts for round-trip estimates", () => {
  assert.equal(calculateRoundTripEstimate(0, 110, 1_000), null);
  assert.equal(calculateRoundTripEstimate(100, Number.NaN, 1_000), null);
  assert.equal(calculateRoundTripEstimate(100, 110, 0), null);
  assert.equal(calculateRoundTripEstimate(100, 110, 1.5), null);
});
