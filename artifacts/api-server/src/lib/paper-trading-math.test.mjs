import assert from "node:assert/strict";
import test from "node:test";
import { calculatePaperTradeCosts } from "./paper-trading-math.ts";

test("uses the user's entered price to calculate buy amount and commission", () => {
  assert.deepEqual(
    calculatePaperTradeCosts({
      side: "buy",
      shares: 100,
      price: 10,
      isFundOrEtf: false,
    }),
    {
      price: 10,
      grossAmount: 1000,
      commission: 1.43,
      transactionTax: 0,
    },
  );
});

test("applies the ETF sell tax to the entered transaction amount", () => {
  assert.deepEqual(
    calculatePaperTradeCosts({
      side: "sell",
      shares: 100,
      price: 20,
      isFundOrEtf: true,
    }),
    {
      price: 20,
      grossAmount: 2000,
      commission: 2.85,
      transactionTax: 2,
    },
  );
});
