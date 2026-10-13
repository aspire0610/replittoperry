import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBudgetShareLimit,
  calculateRoundTripEstimate,
  TAIWAN_STOCK_BUY_COMMISSION_RATE,
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
