import assert from "node:assert/strict";
import test from "node:test";
import {
  areQuotesSynchronized,
  isFreshIntradayTaiexQuote,
  isFreshMarketQuote,
  sameQuoteSnapshot,
} from "./futures-ai-day-strategy-guards.ts";

const now = Date.UTC(2026, 9, 9, 2, 0, 0);

function makeQuote(overrides = {}) {
  return {
    key: "taiex",
    name: "加權指數",
    ticker: "^TWII",
    price: 22_000,
    change: 80,
    changePercent: 0.36,
    source: "Fugle MarketData · TWSE IX0001",
    asOf: new Date(now - 30_000),
    available: true,
    error: null,
    ...overrides,
  };
}

test("requires a positive, available quote within the freshness window", () => {
  assert.equal(isFreshMarketQuote(makeQuote(), now), true);
  assert.equal(
    isFreshMarketQuote(makeQuote({ asOf: new Date(now - 90_001) }), now),
    false,
  );
  assert.equal(
    isFreshMarketQuote(makeQuote({ asOf: new Date(now + 60_001) }), now),
    false,
  );
  assert.equal(isFreshMarketQuote(makeQuote({ price: 0 }), now), false);
  assert.equal(isFreshMarketQuote(makeQuote({ available: false }), now), false);
});

test("rejects daily-close fallback even when its retrieval timestamp looks fresh", () => {
  assert.equal(
    isFreshIntradayTaiexQuote(
      makeQuote({ source: "TWSE Open Data · 最近收盤價" }),
      now,
    ),
    false,
  );
  assert.equal(
    isFreshIntradayTaiexQuote(makeQuote({ source: "TWSE MIS" }), now),
    true,
  );
});

test("rejects futures and index quotes whose timestamps are not synchronized", () => {
  const recentFutures = makeQuote({
    key: "futures_day",
    asOf: new Date(now + 30_000),
  });
  const olderIndex = makeQuote({ asOf: new Date(now - 61_000) });
  assert.equal(isFreshMarketQuote(recentFutures, now), true);
  assert.equal(isFreshIntradayTaiexQuote(olderIndex, now), true);
  assert.equal(areQuotesSynchronized(recentFutures, olderIndex), false);
  assert.equal(
    areQuotesSynchronized(recentFutures, {
      ...olderIndex,
      asOf: new Date(now - 60_000),
    }),
    true,
  );
});

test("reuses a cached strategy only for the same complete quote snapshot", () => {
  const quote = makeQuote();
  assert.equal(sameQuoteSnapshot(quote, makeQuote()), true);
  assert.equal(
    sameQuoteSnapshot(quote, makeQuote({ price: quote.price + 1 })),
    false,
  );
  assert.equal(
    sameQuoteSnapshot(quote, makeQuote({ asOf: new Date(now - 20_000) })),
    false,
  );
  assert.equal(
    sameQuoteSnapshot(quote, makeQuote({ source: "TWSE MIS" })),
    false,
  );
});
