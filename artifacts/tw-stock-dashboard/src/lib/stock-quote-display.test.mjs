import assert from "node:assert/strict";
import test from "node:test";
import {
  getStockQuoteDisplayStatus,
  getStockQuoteFallbackReason,
} from "./stock-quote-display.ts";

const NOW = Date.parse("2026-10-08T03:54:40.000Z");

function makeQuote(overrides = {}) {
  return {
    available: true,
    price: 5_530,
    source: "Fugle MarketData · 成交時間",
    asOf: new Date(NOW - 138_000).toISOString(),
    ...overrides,
  };
}

test("labels a verified trade from the screenshot window as delayed, not live", () => {
  assert.deepEqual(
    getStockQuoteDisplayStatus(makeQuote(), true, NOW),
    { available: true, isDelayedLastTrade: true },
  );
});

test("keeps a fresh verified trade in the normal latest-trade state", () => {
  assert.deepEqual(
    getStockQuoteDisplayStatus(
      makeQuote({ asOf: new Date(NOW - 45_000).toISOString() }),
      true,
      NOW,
    ),
    { available: true, isDelayedLastTrade: false },
  );
});

test("hides a verified trade once it is older than three minutes", () => {
  assert.deepEqual(
    getStockQuoteDisplayStatus(
      makeQuote({ asOf: new Date(NOW - 181_000).toISOString() }),
      true,
      NOW,
    ),
    { available: false, isDelayedLastTrade: false },
  );
});

test("does not extend the display window for a quote-update timestamp", () => {
  assert.deepEqual(
    getStockQuoteDisplayStatus(
      makeQuote({
        source: "Fugle MarketData · 報價更新時間",
        asOf: new Date(NOW - 138_000).toISOString(),
      }),
      true,
      NOW,
    ),
    { available: false, isDelayedLastTrade: false },
  );
});

test("preserves the existing after-hours last-trade display", () => {
  assert.deepEqual(
    getStockQuoteDisplayStatus(
      makeQuote({
        source: "Fugle MarketData · 成交時間 · 盤後最後成交",
        asOf: "2026-10-07T05:30:00.000Z",
      }),
      false,
      NOW,
    ),
    { available: true, isDelayedLastTrade: false },
  );
});

test("explains when live quote sources have not updated within the display window", () => {
  assert.equal(
    getStockQuoteFallbackReason(
      "個股即時報價超過 180 秒未更新；備援來源：個股即時報價超過 180 秒未更新",
    ),
    "即時來源超過 3 分鐘未更新",
  );
});
