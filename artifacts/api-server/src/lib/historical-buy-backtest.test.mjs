import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateHistoricalStrategyBacktest,
  simulateHistoricalBuyTrades,
} from "./historical-buy-backtest.ts";

function tradingDates(length) {
  const dates = [];
  const date = new Date("2025-01-01T00:00:00.000Z");
  while (dates.length < length) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(date.toISOString().slice(0, 10));
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

function risingBars(length = 260) {
  const dates = tradingDates(length);
  return dates.map((date, index) => {
    const close = 40 + index * 0.2;
    return {
      date,
      open: close - 0.05,
      high: close + 0.1,
      low: close - 0.1,
      close,
    };
  });
}

test("uses only completed, non-overlapping trades and waits for both sample gates", () => {
  const bars = risingBars(170);
  const result = calculateHistoricalStrategyBacktest(bars, "TWSE Open Data");

  assert.equal(result.status, "insufficient_data");
  assert.ok(result.sampleCount > 0);
  assert.ok(result.sampleCount < 30);
  assert.equal(result.winRatePercent, null);
  assert.equal(result.wins, null);
  assert.equal(result.confidenceIntervalLowPercent, null);
  assert.equal(result.dataStartDate.toISOString().slice(0, 10), bars[0].date);
  assert.equal(result.dataEndDate.toISOString().slice(0, 10), bars.at(-1).date);
  assert.equal(result.source, "TWSE Open Data");
});

test("reports a Wilson interval only after the fixed sample and date-window gates pass", () => {
  const bars = risingBars();
  bars[26] = {
    ...bars[26],
    high: 46,
    low: 44,
  };
  const result = calculateHistoricalStrategyBacktest(bars, "TWSE Open Data");

  assert.equal(result.status, "calibrated");
  assert.ok(result.sampleCount >= result.minimumSampleCount);
  assert.ok(result.winRatePercent > 0);
  assert.ok(result.wins < result.sampleCount);
  assert.ok(result.confidenceIntervalLowPercent < result.winRatePercent);
  assert.ok(result.confidenceIntervalHighPercent > result.winRatePercent);
  assert.equal(result.evaluationTradingDays, 5);
  const firstTrade = simulateHistoricalBuyTrades(bars)[0];
  assert.equal(firstTrade.exitDate, bars[26].date);
  assert.equal(firstTrade.exitReason, "stop_loss");
});

test("models stop gaps at the next open and conservatively counts a same-day double touch as a stop", () => {
  const bars = risingBars(45);
  const trades = simulateHistoricalBuyTrades(bars);
  assert.ok(trades.length > 0);
  assert.ok(trades.every((trade) => trade.exitDate >= trade.entryDate));

  const barsWithGap = risingBars(45);
  const firstSignalIndex = 24;
  const entryIndex = firstSignalIndex + 1;
  barsWithGap[entryIndex + 1] = {
    ...barsWithGap[entryIndex + 1],
    open: 1,
    high: 1,
    low: 0.5,
    close: 1,
  };
  const gapTrades = simulateHistoricalBuyTrades(barsWithGap);
  assert.ok(
    gapTrades.some(
      (trade) =>
        trade.exitDate === barsWithGap[entryIndex + 1].date &&
        trade.exitPrice === 1 &&
        trade.exitReason === "stop_loss",
    ),
  );
});

test("future bars cannot change already completed earlier trades", () => {
  const shorterHistory = simulateHistoricalBuyTrades(risingBars(70));
  const longerHistory = simulateHistoricalBuyTrades(risingBars(100));
  assert.deepEqual(
    longerHistory.slice(0, shorterHistory.length),
    shorterHistory,
  );
});

test("returns no calibration for insufficient or malformed history", () => {
  const result = calculateHistoricalStrategyBacktest(
    [{ date: "not-a-date", open: 10, high: 11, low: 9, close: 10 }],
    "TPEx Open Data",
  );
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.sampleCount, 0);
  assert.equal(result.dataStartDate, null);
  assert.equal(result.winRatePercent, null);
});
