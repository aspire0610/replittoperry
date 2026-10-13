import assert from "node:assert/strict";
import test from "node:test";
import { parseFugleTaiexIntradayCandles } from "./fugle-market-data.ts";

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
