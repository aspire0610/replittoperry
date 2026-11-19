import assert from "node:assert/strict";
import test from "node:test";
import { parseYahooUsQuote, recoverUsMarketQuote } from "./us-market-fallback.ts";

const now = Date.parse("2026-11-07T07:30:00+08:00");
const quoteTime = Date.parse("2026-11-06T21:00:00Z") / 1000;
const fixture = (symbol = "^SOX") => ({
  chart: { result: [{
    meta: { symbol, regularMarketPrice: 9390.25, regularMarketTime: quoteTime, chartPreviousClose: 10688.8 },
    timestamp: [Date.parse("2026-11-04T14:30:00Z") / 1000, Date.parse("2026-11-05T14:30:00Z") / 1000, Date.parse("2026-11-06T14:30:00Z") / 1000],
    indicators: { quote: [{ close: [10268.65, 9011.14, 9390.25] }] },
  }] },
});
const unavailable = {
  key: "us_sox", name: "費城半導體指數", ticker: "SOX", price: null, change: null,
  changePercent: null, asOf: null, source: null, available: false, error: "Nasdaq 回應 HTTP 403",
};

test("daily change uses previous session, not five-day chartPreviousClose", () => {
  const result = parseYahooUsQuote(fixture(), "^SOX", now);
  assert.ok(Math.abs(result.change - 379.11) < 0.00001);
  assert.ok(Math.abs(result.changePercent - 4.20713) < 0.0001);
  assert.equal(result.asOf.toISOString(), "2026-11-06T21:00:00.000Z");
  assert.match(result.source, /備援.*可能延遲.*2026-11-06/);
});
test("rejects wrong instrument, missing/invalid fields, stale and future timestamps", () => {
  assert.throws(() => parseYahooUsQuote(fixture("SOXX"), "^SOX", now), /商品代碼/);
  for (const value of [null, {}, { chart: { result: null } }]) {
    assert.throws(() => parseYahooUsQuote(value, "^SOX", now));
  }
  for (const time of [0, now / 1000 + 120, now / 1000 - 8 * 86400]) {
    const data = fixture();
    data.chart.result[0].meta.regularMarketTime = time;
    assert.throws(() => parseYahooUsQuote(data, "^SOX", now));
  }
  const data = fixture();
  data.chart.result[0].indicators.quote[0].close = [null, null, 9390.25];
  assert.throws(() => parseYahooUsQuote(data, "^SOX", now), /前一交易日/);
});
test("handles weekend, Eastern daylight saving, unordered bars and null gaps", () => {
  const data = fixture("TSM");
  const row = data.chart.result[0];
  row.meta.regularMarketTime = Date.parse("2026-07-06T20:00:00Z") / 1000;
  row.meta.regularMarketPrice = 110;
  row.timestamp = ["2026-07-06T13:30:00Z", "2026-07-02T13:30:00Z", "2026-07-01T13:30:00Z"].map(t => Date.parse(t) / 1000);
  row.indicators.quote[0].close = [110, 100, null];
  const result = parseYahooUsQuote(data, "TSM", Date.parse("2026-07-07T00:00:00Z"));
  assert.equal(result.changePercent, 10);
  assert.match(result.source, /2026-07-06/);
});
test("primary 403 uses independent fallback; success avoids request; failures remain explicit", async () => {
  const nativeFetch = globalThis.fetch;
  const nativeNow = Date.now;
  Date.now = () => now;
  const calls = [];
  try {
    globalThis.fetch = async url => { calls.push(String(url)); return Response.json(fixture()); };
    const primary = { ...unavailable, available: true };
    assert.equal(await recoverUsMarketQuote(primary, "^SOX"), primary);
    assert.equal(calls.length, 0);
    const recovered = await recoverUsMarketQuote(unavailable, "^SOX");
    assert.equal(recovered.available, true);
    assert.equal(recovered.ticker, "SOX");
    assert.equal(recovered.key, "us_sox");
    assert.equal(recovered.error, null);
    assert.match(calls[0], /chart\/%5ESOX/);
    globalThis.fetch = async () => new Response(null, { status: 429 });
    const failed = await recoverUsMarketQuote(unavailable, "^SOX");
    assert.equal(failed.available, false);
    assert.equal(failed.price, null);
    assert.match(failed.error, /Nasdaq.*403.*Yahoo.*429/);
    globalThis.fetch = async () => { throw new Error("timeout"); };
    assert.match((await recoverUsMarketQuote(unavailable, "^SOX")).error, /timeout/);
  } finally {
    globalThis.fetch = nativeFetch;
    Date.now = nativeNow;
  }
});
