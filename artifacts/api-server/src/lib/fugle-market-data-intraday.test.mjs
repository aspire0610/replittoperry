import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchFugleStockHistoricalDailyBars,
  splitFugleDailyHistoryRange,
  fetchFugleTaiexHistoricalIntradayCandles,
  fetchFugleTaiexHistoricalDailyBars,
  parseFugleTaiexIntradayCandles,
} from "./fugle-market-data.ts";

function payload(data, symbol = "IX0001") {
  return {
    date: "2026-10-08",
    type: "INDEX",
    exchange: "TWSE",
    market: "TSE",
    symbol,
    timeframe: "1",
    data,
  };
}

function candle(date, open = 49_000, high = 49_100, low = 48_900, close = 49_050) {
  return { date, open, high, low, close, volume: 1_000 };
}

test("parses ordered one-minute TAIEX candles from the 09:00 session open", () => {
  const result = parseFugleTaiexIntradayCandles(
    payload([
      candle("2026-10-08T09:00:00.000+08:00"),
      candle("2026-10-08T09:01:00.000+08:00", 49_050, 49_120, 49_000, 49_100),
    ]),
  );

  assert.equal(result.date, "2026-10-08");
  assert.equal(result.bars.length, 2);
  assert.equal(result.bars[0].time.toISOString(), "2026-10-08T01:00:00.000Z");
  assert.equal(result.bars[1].close, 49_100);
});

test("rejects the total-return index instead of the TAIEX price index", () => {
  assert.throws(
    () =>
      parseFugleTaiexIntradayCandles(
        payload([candle("2026-10-08T09:00:00.000+08:00")], "IR0001"),
      ),
    /代碼或週期不符/,
  );
});

test("rejects candles without the opening minute", () => {
  assert.throws(
    () =>
      parseFugleTaiexIntradayCandles(
        payload([candle("2026-10-08T09:01:00.000+08:00")]),
      ),
    /未包含 09:00/,
  );
});

test("identifies an empty live response as a missing-session condition", () => {
  assert.throws(
    () => parseFugleTaiexIntradayCandles(payload([])),
    /Fugle 尚未提供加權指數一分鐘分時資料/,
  );
});

test("rejects out-of-session and internally inconsistent candles", () => {
  assert.throws(
    () =>
      parseFugleTaiexIntradayCandles(
        payload([candle("2026-10-08T08:59:00.000+08:00")]),
      ),
    /不合理的時間或價格/,
  );
  assert.throws(
    () =>
      parseFugleTaiexIntradayCandles(
        payload([candle("2026-10-08T09:00:00.000+08:00", 49_000, 48_900, 49_100, 49_050)]),
      ),
    /不合理的時間或價格/,
  );
});

test("fetches and validates the requested official historical session", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.FUGLE_API_KEY;
  process.env.FUGLE_API_KEY = "test-key";
  let requestedUrl;
  globalThis.fetch = async (input) => {
    requestedUrl = new URL(String(input));
    return Response.json({
      symbol: "IX0001",
      exchange: "TWSE",
      timeframe: "1",
      sort: "desc",
      data: [
        candle("2026-10-08T09:01:00.000+08:00"),
        candle("2026-10-08T09:00:00.000+08:00"),
      ],
    });
  };

  try {
    const result = await fetchFugleTaiexHistoricalIntradayCandles("2026-10-08");
    assert.equal(result.date, "2026-10-08");
    assert.equal(requestedUrl.pathname, "/marketdata/v1.0/stock/historical/candles/IX0001");
    assert.equal(requestedUrl.searchParams.get("timeframe"), "1");
    assert.equal(requestedUrl.searchParams.get("from"), "2026-10-08");
    assert.equal(requestedUrl.searchParams.get("to"), "2026-10-08");
    assert.equal(result.bars[0].time.toISOString(), "2026-10-08T01:00:00.000Z");
    await assert.rejects(
      fetchFugleTaiexHistoricalIntradayCandles("2026-10-09"),
      /歷史分時日期與要求不符/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.FUGLE_API_KEY;
    else process.env.FUGLE_API_KEY = originalApiKey;
  }
});

test("fetches and validates daily stock history from Fugle as an exchange-data fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.FUGLE_API_KEY;
  process.env.FUGLE_API_KEY = "test-key";
  let requestedUrl;
  globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("X-API-KEY"), "test-key");
    return Response.json({
      symbol: "6505",
      type: "EQUITY",
      exchange: "TWSE",
      timeframe: "D",
      sort: "desc",
      data: [
        { date: "2026-10-16", open: 50, high: 52, low: 49, close: 51, volume: 1_000_000 },
        { date: "2026-10-15", open: 49, high: 51, low: 48, close: 50, volume: 1_100_000 },
      ],
    });
  };
  try {
    const result = await fetchFugleStockHistoricalDailyBars("6505.TW", "2026-10-01", "2026-10-31");
    assert.equal(requestedUrl.pathname, "/marketdata/v1.0/stock/historical/candles/6505");
    assert.equal(requestedUrl.searchParams.get("timeframe"), "D");
    assert.equal(requestedUrl.searchParams.get("from"), "2026-10-01");
    assert.equal(requestedUrl.searchParams.get("to"), "2026-10-31");
    assert.deepEqual(result.bars.map((bar) => bar.date), ["2026-10-15", "2026-10-16"]);
    assert.equal(result.exchange, "TWSE");
    assert.equal(result.bars[0].volume, 1_100_000);
    await assert.rejects(
      fetchFugleStockHistoricalDailyBars("6505", "2025-10-01", "2026-10-01"),
      /區間達一年/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.FUGLE_API_KEY;
    else process.env.FUGLE_API_KEY = originalApiKey;
  }
});

test("cancels an in-flight Fugle history request when the caller aborts", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.FUGLE_API_KEY;
  process.env.FUGLE_API_KEY = "test-key";
  const controller = new AbortController();
  let requestSignal;
  globalThis.fetch = async (_input, init) => {
    requestSignal = init.signal;
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  try {
    const request = fetchFugleStockHistoricalDailyBars(
      "6505",
      "2026-10-01",
      "2026-10-31",
      controller.signal,
    );
    controller.abort(new DOMException("scan deadline reached", "AbortError"));
    await assert.rejects(request, /scan deadline reached/);
    assert.equal(requestSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.FUGLE_API_KEY;
    else process.env.FUGLE_API_KEY = originalApiKey;
  }
});

test("backs off and retries Fugle history on 429 but does not retry 403", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.FUGLE_API_KEY;
  process.env.FUGLE_API_KEY = "test-key";
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response("", { status: 429, headers: { "retry-after": "0.001" } });
    }
    return Response.json({
      symbol: "6505",
      exchange: "TWSE",
      timeframe: "D",
      data: [
        { date: "2026-10-16", open: 50, high: 52, low: 49, close: 51, volume: 1_000_000 },
      ],
    });
  };

  try {
    const result = await fetchFugleStockHistoricalDailyBars("6505", "2026-10-01", "2026-10-31");
    assert.equal(result.bars.length, 1);
    assert.equal(requests, 2);

    requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response("", { status: 403 });
    };
    await assert.rejects(
      fetchFugleStockHistoricalDailyBars("6505", "2026-10-01", "2026-10-31"),
      /HTTP 403/,
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.FUGLE_API_KEY;
    else process.env.FUGLE_API_KEY = originalApiKey;
  }
});

test("fetches validated daily TAIEX candles from Fugle when TWSE history is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.FUGLE_API_KEY;
  process.env.FUGLE_API_KEY = "test-key";
  let requestedUrl;
  globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("X-API-KEY"), "test-key");
    return Response.json({
      symbol: "IX0001",
      type: "INDEX",
      exchange: "TWSE",
      timeframe: "D",
      data: [
        { date: "2026-10-16", open: 48_000, high: 48_500, low: 47_900, close: 48_200 },
        { date: "2026-10-15", open: 47_500, high: 48_100, low: 47_400, close: 48_000 },
      ],
    });
  };
  try {
    const bars = await fetchFugleTaiexHistoricalDailyBars("2026-10-01", "2026-10-31");
    assert.equal(requestedUrl.pathname, "/marketdata/v1.0/stock/historical/candles/IX0001");
    assert.equal(requestedUrl.searchParams.get("timeframe"), "D");
    assert.deepEqual(bars.map(({ date }) => date), ["2026-10-15", "2026-10-16"]);
    assert.equal(bars.at(-1).close, 48_200);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.FUGLE_API_KEY;
    else process.env.FUGLE_API_KEY = originalApiKey;
  }
});

test("splits a five-year Fugle history request into complete non-overlapping ranges under the provider limit", () => {
  const ranges = splitFugleDailyHistoryRange("2021-10-18", "2026-10-18");
  assert.equal(ranges.length, 6);
  assert.equal(ranges[0].from, "2021-10-18");
  assert.equal(ranges.at(-1).to, "2026-10-18");
  for (let index = 1; index < ranges.length; index += 1) {
    const previousEnd = Date.parse(`${ranges[index - 1].to}T00:00:00Z`);
    const currentStart = Date.parse(`${ranges[index].from}T00:00:00Z`);
    assert.equal(currentStart - previousEnd, 86_400_000);
  }
  assert.ok(ranges.every(({ from, to }) =>
    Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) < 365 * 86_400_000
  ));
});
