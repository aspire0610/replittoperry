import assert from "node:assert/strict";
import test from "node:test";
import { calculateFuturesLiveSignal } from "./futures-live-signal.ts";
import { completedFuturesEntryBars } from "./futures-entry-points.ts";

const now = Date.parse("2026-11-11T10:00:00+08:00");
const oneMinute = 60_000;
const fiveMinutes = 5 * oneMinute;

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  let average = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) average = value * multiplier + average * (1 - multiplier);
  return average;
}

function makeData(direction = "long", marketNow = now, symbol = "TXF1", step = 12) {
  const localNow = new Date(marketNow + 8 * 60 * 60_000);
  let sessionDate = localNow.toISOString().slice(0, 10);
  if (symbol === "TXF8" && localNow.getUTCHours() < 5) {
    sessionDate = new Date(Date.parse(`${sessionDate}T00:00:00Z`) - 24 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);
  }
  const sessionStart = Date.parse(
    `${sessionDate}T${symbol === "TXF1" ? "08:45" : "15:00"}:00+08:00`,
  );
  const completedBuckets = Math.floor((marketNow - sessionStart) / fiveMinutes);
  const lastBucketStart = sessionStart + (completedBuckets - 1) * fiveMinutes;
  const firstBucketStart = lastBucketStart - 12 * fiveMinutes;
  const sign = direction === "long" ? 1 : -1;
  const wick = Math.max(0.1, step * 0.3);
  const body = Math.max(0.2, step * 0.25);
  const fiveMinuteBars = Array.from({ length: 13 }, (_, index) => {
    const close = 40000 + sign * index * step;
    const open = close - sign * body;
    return {
      time: new Date(firstBucketStart + index * fiveMinutes).toISOString(),
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
    };
  });
  const bars = fiveMinuteBars.flatMap(bar => Array.from({ length: 5 }, (_, minute) => {
    const open = bar.open;
    const close = minute === 4 ? bar.close : bar.open;
    return {
      time: new Date(Date.parse(bar.time) + minute * oneMinute).toISOString(),
      open,
      high: bar.high,
      low: bar.low,
      close,
    };
  }));
  const closes = fiveMinuteBars.map(bar => bar.close);
  const entryLevel = Math.round(ema(closes, 5));
  return {
    status: "live",
    symbol,
    date: sessionDate.replaceAll("-", ""),
    bars,
    k: 70,
    d: 65,
    signal: "no_cross",
    price: direction === "long" ? entryLevel + 1 : entryLevel - 1,
    change: direction === "long" ? 100 : -100,
    changePercent: direction === "long" ? 0.4 : -0.4,
    asOf: new Date(marketNow).toISOString(),
    source: `價格：Yuanta SPARK · ${symbol}；分 K：Yuanta SPARK · ${symbol}`,
    dailyHistory: {
      status: "available",
      bars: [],
      atr14: 300,
      atr14By4: null,
      asOf: null,
      source: "暫無日線歷史",
    },
  };
}

function entryLineFor(data, at = now) {
  const bars = completedFuturesEntryBars(data, at);
  return Math.round(ema(bars.map(bar => bar.close), 5));
}

function makeTaiex(change = 80) {
  return {
    key: "taiex",
    name: "加權指數",
    ticker: "TWII",
    price: 28000,
    change,
    changePercent: 0.3,
    source: "TWSE MIS",
    asOf: new Date(now).toISOString(),
    available: true,
    error: null,
  };
}

test("5-minute EMA uptrend produces a long entry with valid risk levels", () => {
  const result = calculateFuturesLiveSignal(makeData("long"), makeTaiex(80), now);
  assert.equal(result.action, "long");
  assert.equal(result.confirmationMode, "five_min_trend");
  assert.ok(result.stopPrice < result.entryPrice);
  assert.ok(result.targetPrice - result.entryPrice >= 150);
  assert.ok(result.rewardRisk >= 2);
  assert.match(result.reason, /EMA5 .*EMA13/u);
});

test("5-minute EMA downtrend produces a short entry with valid risk levels", () => {
  const result = calculateFuturesLiveSignal(makeData("short"), makeTaiex(-80), now);
  assert.equal(result.action, "short");
  assert.equal(result.confirmationMode, "five_min_trend");
  assert.ok(result.targetPrice < result.entryPrice);
  assert.ok(result.stopPrice > result.entryPrice);
  assert.ok(result.rewardRisk >= 2);
});

test("5-minute EMA trend ignores daily change and index direction", () => {
  const mismatched = makeData("long");
  mismatched.change = -100;
  assert.equal(calculateFuturesLiveSignal(mismatched, makeTaiex(-80), now).action, "long");
  assert.equal(calculateFuturesLiveSignal(makeData("long"), undefined, now).action, "long");

  const stale = makeTaiex(80);
  stale.asOf = new Date(now - 91_000).toISOString();
  assert.equal(calculateFuturesLiveSignal(makeData("long"), stale, now).action, "long");
  const unsynchronized = makeTaiex(80);
  unsynchronized.asOf = new Date(now - 61_000).toISOString();
  assert.equal(calculateFuturesLiveSignal(makeData("long"), unsynchronized, now).action, "long");

  const staleFutures = makeData("long");
  staleFutures.asOf = new Date(now - 91_000).toISOString();
  assert.equal(calculateFuturesLiveSignal(staleFutures, makeTaiex(80), now).action, "wait");
});

test("waits on missing SPARK bars, insufficient 5-minute history, and stale quotes", () => {
  const data = makeData("long");
  assert.equal(calculateFuturesLiveSignal({ ...data, bars: data.bars.slice(-8) }, makeTaiex(), now).action, "wait");
  const onlyTwelveFiveMinuteBars = {
    ...data,
    bars: data.bars.slice(-12 * 5),
  };
  assert.match(
    calculateFuturesLiveSignal(onlyTwelveFiveMinuteBars, undefined, now).reason,
    /12\/13 根/u,
  );
  assert.equal(calculateFuturesLiveSignal({ ...data, symbol: "TXF8" }, undefined, now).action, "wait");
  assert.equal(calculateFuturesLiveSignal({
    ...data,
    source: "價格：Yuanta SPARK · TXF1；分 K：TAIFEX MIS",
  }, makeTaiex(), now).action, "wait");
  assert.equal(calculateFuturesLiveSignal({
    ...data,
    bars: data.bars.map(bar => ({
      ...bar,
      time: new Date(Date.parse(bar.time) - 2 * oneMinute).toISOString(),
    })),
  }, makeTaiex(), now).action, "wait");
  assert.equal(calculateFuturesLiveSignal({
    ...data,
    asOf: new Date(now - 91_000).toISOString(),
  }, makeTaiex(), now).action, "wait");
});

test("produces a night-session 5-minute trend signal without TAIEX data", () => {
  const nightNow = Date.parse("2026-11-11T16:10:00+08:00");
  const result = calculateFuturesLiveSignal(
    makeData("long", nightNow, "TXF8"),
    undefined,
    nightNow,
  );

  assert.equal(result.action, "long");
  assert.equal(result.confirmationMode, "five_min_trend");
  assert.equal(result.taiexAsOf, null);
  assert.equal(result.taiexSource, null);
  assert.ok(result.stopPrice < result.entryPrice);
  assert.ok(result.targetPrice - result.entryPrice >= 150);
  assert.ok(result.rewardRisk >= 2);
});

test("shows a trend-aligned entry, stop, and target while waiting for EMA5", () => {
  const activeLong = makeData("long");
  const longLine = calculateFuturesLiveSignal(activeLong, undefined, now).entryPrice - 1;
  activeLong.price = longLine - 10;
  const longData = activeLong;
  const long = calculateFuturesLiveSignal(longData, makeTaiex(80), now);
  assert.equal(long.action, "wait");
  assert.equal(long.candidate?.direction, "long");
  assert.equal(long.candidate?.triggerPrice, longLine);
  assert.ok(long.candidate.invalidationPrice < long.candidate.triggerPrice);
  assert.equal(long.entryPrice, null);
  assert.ok(long.candidate.targetPrice - long.candidate.triggerPrice >= 150);
  assert.ok(long.candidate.rewardRisk >= 2);
  assert.match(long.candidate.triggerCondition, /EMA5 高於 EMA13/u);

  const activeShort = makeData("short");
  const shortLine = calculateFuturesLiveSignal(activeShort, undefined, now).entryPrice + 1;
  activeShort.price = shortLine + 10;
  const shortData = activeShort;
  const short = calculateFuturesLiveSignal(shortData, undefined, now);
  assert.equal(short.action, "wait");
  assert.equal(short.candidate?.direction, "short");
  assert.equal(short.candidate?.triggerPrice, shortLine);
  assert.ok(short.candidate.invalidationPrice > short.candidate.triggerPrice);
  assert.ok(short.candidate.targetPrice < short.candidate.triggerPrice);
  assert.ok(short.candidate.rewardRisk >= 2);
  assert.match(short.candidate.triggerCondition, /EMA5 低於 EMA13/u);
});

test("a falling quote does not reverse a bullish 5-minute EMA trend into a short", () => {
  const data = makeData("long");
  data.change = -100;
  const entryLine = calculateFuturesLiveSignal(data, undefined, now).entryPrice - 1;
  data.price = entryLine - 10;

  const result = calculateFuturesLiveSignal(data, makeTaiex(80), now);
  assert.equal(result.action, "wait");
  assert.equal(result.candidate?.direction, "long");
  assert.match(result.reason, /趨勢偏多/u);
});

test("a rising daily quote does not reverse a bearish 5-minute EMA trend into a long", () => {
  const data = makeData("short");
  data.change = 100;
  data.changePercent = 0.4;

  const result = calculateFuturesLiveSignal(data, makeTaiex(80), now);
  assert.equal(result.action, "short");
  assert.match(result.reason, /趨勢偏空/u);
});

test("does not chase a 5-minute trend entry after price moves too far from EMA5", () => {
  const data = makeData("long");
  const entryLine = calculateFuturesLiveSignal(data, undefined, now).entryPrice - 1;
  data.price = entryLine + 100;
  const result = calculateFuturesLiveSignal(data, makeTaiex(80), now);
  assert.equal(result.action, "wait");
  assert.equal(result.candidate?.direction, "long");
  assert.match(result.reason, /不追價/u);
});

test("a neutral 5-minute EMA relationship does not force either direction", () => {
  const data = makeData("long");
  data.bars = data.bars.map(bar => ({
    ...bar,
    open: 40000,
    high: 40005,
    low: 39995,
    close: 40000,
  }));
  const result = calculateFuturesLiveSignal(data, makeTaiex(80), now);
  assert.equal(result.action, "wait");
  assert.equal(result.candidate, null);
  assert.match(result.reason, /尚未明確分開/u);
});

test("does not output an entry when current-price stop risk exceeds one-minute ATR14", () => {
  const data = makeData("long", now, "TXF1", 1);
  const entryLine = entryLineFor(data);
  data.price = entryLine + 1;
  const result = calculateFuturesLiveSignal(data, undefined, now);
  assert.equal(result.action, "wait");
  assert.equal(result.candidate, null);
  assert.match(result.reason, /ATR14 上限/u);
});

test("keeps TXF8 session bars valid across midnight", () => {
  const nightNow = Date.parse("2026-11-12T00:00:00+08:00");
  const result = calculateFuturesLiveSignal(
    makeData("short", nightNow, "TXF8"),
    undefined,
    nightNow,
  );

  assert.equal(result.action, "short");
  assert.equal(result.confirmationMode, "five_min_trend");
  assert.ok(result.stopPrice > result.entryPrice);
  assert.ok(result.targetPrice < result.entryPrice);
  assert.ok(result.rewardRisk >= 2);
});

test("a stale daily-close index quote does not affect the 5-minute trend", () => {
  const taiex = { ...makeTaiex(), source: "TWSE official close · 最近收盤價" };
  assert.equal(calculateFuturesLiveSignal(makeData("long"), taiex, now).action, "long");
});
