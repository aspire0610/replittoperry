import assert from "node:assert/strict";
import test from "node:test";
import { fetchFugleStockQuote } from "./fugle-market-data.ts";

test("normalizes Fugle cumulative lot volume to shares and keeps live OHLC", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.FUGLE_API_KEY;
  process.env.FUGLE_API_KEY = "test-only";
  globalThis.fetch = async () => new Response(JSON.stringify({
    stockName: "測試股票",
    lastPrice: 105,
    previousClose: 100,
    change: 5,
    changePercent: 5,
    openPrice: 101,
    highPrice: 106,
    lowPrice: 99,
    lastUpdated: 1_792_378_800_000_000,
    lastTrade: { time: 1_792_378_800_000_000, price: 105 },
    total: { tradeVolume: 1_234 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const quote = await fetchFugleStockQuote("2330");
    assert.equal(quote.volume, 1_234_000);
    assert.equal(quote.openPrice, 101);
    assert.equal(quote.highPrice, 106);
    assert.equal(quote.lowPrice, 99);
    assert.equal(quote.price, 105);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.FUGLE_API_KEY;
    else process.env.FUGLE_API_KEY = originalApiKey;
  }
});
