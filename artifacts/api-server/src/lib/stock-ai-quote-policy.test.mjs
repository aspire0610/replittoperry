import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveStockAiQuote } from "./stock-ai-quote-policy.ts";

const now = new Date("2026-10-08T01:18:00.000Z");

function makeQuote(overrides = {}) {
  return {
    name: "測試股票",
    price: 100,
    previousClose: 98,
    change: 2,
    changePercent: 2.04,
    source: "TWSE MIS · 成交時間",
    asOf: new Date(now.getTime() - 30_000),
    available: true,
    error: null,
    ...overrides,
  };
}

const closeQuote = makeQuote({
  price: 95,
  source: "TWSE 官方日線 · 最近收盤價",
  asOf: new Date("2026-10-07T05:30:00.000Z"),
});

test("uses a fresh, timestamped in-session quote during trading", () => {
  const result = resolveStockAiQuote({
    providerQuote: makeQuote(),
    closeQuote,
    sessionOpen: true,
    providerQuoteIsInSession: true,
    now,
  });

  assert.equal(result.usable, true);
  if (!result.usable) throw new Error(result.error);
  assert.equal(result.referenceType, "verified_trade");
  assert.equal(result.quote.price, 100);
});

test("does not substitute the official close when the in-session quote is missing", () => {
  const result = resolveStockAiQuote({
    providerQuote: null,
    closeQuote,
    sessionOpen: true,
    providerQuoteIsInSession: false,
    now,
  });

  assert.equal(result.usable, false);
  if (result.usable) throw new Error("Expected missing live quote to be rejected");
  assert.match(result.error, /不會以最近收盤價代替/u);
});

test("accepts a verified in-session trade that is 158 seconds old", () => {
  const result = resolveStockAiQuote({
    providerQuote: makeQuote({
      asOf: new Date(now.getTime() - 158_000),
    }),
    closeQuote,
    sessionOpen: true,
    providerQuoteIsInSession: true,
    now,
  });

  assert.equal(result.usable, true);
  if (!result.usable) throw new Error(result.error);
  assert.equal(result.referenceType, "verified_trade");
  assert.equal(result.quote.price, 100);
});

test("does not treat a recent quote-update timestamp as a verified trade", () => {
  const result = resolveStockAiQuote({
    providerQuote: makeQuote({
      source: "Fugle MarketData · 報價更新時間",
      asOf: new Date(now.getTime() - 30_000),
    }),
    closeQuote,
    sessionOpen: true,
    providerQuoteIsInSession: true,
    now,
  });

  assert.equal(result.usable, false);
  if (result.usable) throw new Error("Expected a quote update to be rejected for AI trading analysis");
});

test("rejects stale in-session quotes instead of falling back to the close", () => {
  const result = resolveStockAiQuote({
    providerQuote: makeQuote({
      asOf: new Date(now.getTime() - 4 * 60_000),
    }),
    closeQuote,
    sessionOpen: true,
    providerQuoteIsInSession: true,
    now,
  });

  assert.equal(result.usable, false);
});

test("uses the official close outside the session, not an after-hours trade", () => {
  const result = resolveStockAiQuote({
    providerQuote: makeQuote({
      source: "TWSE MIS · 盤後最後成交",
    }),
    closeQuote,
    sessionOpen: false,
    providerQuoteIsInSession: false,
    now,
  });

  assert.equal(result.usable, true);
  if (!result.usable) throw new Error(result.error);
  assert.equal(result.referenceType, "official_daily_close");
  assert.equal(result.quote.price, 95);
});
