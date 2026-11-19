import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { fetchYuantaSparkFuturesTickBars } from "./yuanta-spark-relay.ts";

test("fetches signed SPARK futures tick bars and caches the same session briefly", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.YUANTA_SPARK_RELAY_URL;
  const originalSecret = process.env.YUANTA_SPARK_RELAY_SECRET;
  process.env.YUANTA_SPARK_RELAY_URL = "https://relay.example";
  process.env.YUANTA_SPARK_RELAY_SECRET = "test-only-secret";
  let requestCount = 0;
  globalThis.fetch = async (input, init) => {
    requestCount += 1;
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const timestamp = headers.get("X-Yuanta-Timestamp");
    const nonce = headers.get("X-Yuanta-Nonce");
    assert.equal(url.pathname, "/v1/ticks");
    assert.equal(url.searchParams.get("market"), "futures");
    assert.equal(url.searchParams.get("symbol"), "TXF1");
    assert.equal(headers.get("X-Yuanta-Signature"), createHmac(
      "sha256",
      "test-only-secret",
    ).update(`GET\n${url.pathname}${url.search}\n${timestamp}\n${nonce}`).digest("hex"));
    return Response.json({
      tickCount: 2,
      bars: [
        {
          time: "2026-11-03T08:46:00+08:00",
          open: 49002,
          high: 49008,
          low: 48998,
          close: 49005,
          volume: 12,
        },
        {
          time: "2026-11-03T08:45:00+08:00",
          open: 49000,
          high: 49003,
          low: 48997,
          close: 49002,
          volume: 8,
        },
        {
          time: "2026-11-03T08:47:00+08:00",
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          volume: 1,
        },
      ],
    });
  };

  try {
    const first = await fetchYuantaSparkFuturesTickBars("TXF1");
    const second = await fetchYuantaSparkFuturesTickBars("TXF1");
    assert.equal(requestCount, 1);
    assert.deepEqual(first, second);
    assert.deepEqual(first.map((bar) => bar.time.toISOString()), [
      "2026-11-03T00:45:00.000Z",
      "2026-11-03T00:46:00.000Z",
    ]);
    assert.equal(first[0].volume, 8);
    assert.equal(first[1].close, 49005);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.YUANTA_SPARK_RELAY_URL;
    else process.env.YUANTA_SPARK_RELAY_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.YUANTA_SPARK_RELAY_SECRET;
    else process.env.YUANTA_SPARK_RELAY_SECRET = originalSecret;
  }
});
