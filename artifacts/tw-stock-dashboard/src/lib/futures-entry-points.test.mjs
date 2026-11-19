import assert from "node:assert/strict";
import test from "node:test";
import { calculateFuturesEntryPoints, completedFuturesEntryBars } from "./futures-entry-points.ts";

const start = Date.parse("2026-11-06T08:45:00+08:00");
const end = start + 110 * 60_000;
function fiveMinute(open, high, low, close) { return { open, high, low, close }; }
function input(lastTwo = [fiveMinute(101, 103, 100, 102), fiveMinute(102, 104, 101, 104)], price = 103) {
  const fiveBars = [...Array.from({ length: 20 }, () => fiveMinute(105, 110, 100, 105)), ...lastTwo];
  const bars = fiveBars.flatMap((b, i) => Array.from({ length: 5 }, (_, j) => ({
    time: new Date(start + (i * 5 + j) * 60_000).toISOString(), ...b,
  })));
  return {
    status: "live", symbol: "TXF1", date: "20261106",
    asOf: new Date(end).toISOString(), price,
    source: "價格：Yuanta SPARK · TXF1；分 K：Yuanta SPARK observed",
    bars,
  };
}
const scenario = (result, id) => result.scenarios.find(s => s.id === id);

test("support bounce confirms, waits for trigger, allows bounded entry and refuses chasing", () => {
  const data = input();
  const pending = calculateFuturesEntryPoints(data, end);
  assert.equal(pending.completedBars, 22);
  assert.equal(pending.support, 100);
  assert.equal(pending.resistance, 110);
  assert.equal(pending.keyPrice, 105);
  assert.equal(scenario(pending, "support_bounce").status, "armed");
  assert.equal(scenario(pending, "support_bounce").entry, 105);
  const ready = scenario(calculateFuturesEntryPoints({ ...data, price: 105 }, end), "support_bounce");
  assert.equal(ready.status, "ready");
  assert.ok(ready.stop < ready.entry && ready.entry < ready.target);
  assert.equal(ready.rewardRisk, 3);
  assert.equal(scenario(calculateFuturesEntryPoints({ ...data, price: 120 }, end), "support_bounce").status, "missed");
  assert.equal(scenario(calculateFuturesEntryPoints({ ...data, price: ready.stop }, end), "support_bounce").status, "invalidated");
  const stoppedAndBounced = {
    ...data, price: 105, asOf: new Date(end + 60_000).toISOString(),
    bars: [...data.bars, { time: new Date(end).toISOString(), open: 105, high: 105, low: ready.stop, close: 105 }],
  };
  assert.equal(scenario(calculateFuturesEntryPoints(stoppedAndBounced, end + 60_000), "support_bounce").status, "invalidated");
});
test("uses only the SPARK intraday source and does not depend on daily history", () => {
  const data = input();
  const result = calculateFuturesEntryPoints({
    ...data,
    bars: data.bars.slice(1),
  }, end);
  assert.equal(result.state, "warming_up");
  assert.equal(calculateFuturesEntryPoints({
    ...data,
    source: "價格：TAIFEX MIS；分 K：TAIFEX MIS",
  }, end).state, "unavailable");
});
test("resistance rejection is the symmetric short setup with ordered risk levels", () => {
  const data = input([fiveMinute(109, 110, 107, 108), fiveMinute(108, 109, 106, 106)], 105);
  const short = scenario(calculateFuturesEntryPoints(data, end), "resistance_reject");
  assert.equal(short.status, "ready");
  assert.ok(short.target < short.entry && short.entry < short.stop);
});
test("key price reclaim and breakdown require independent completed-bar confirmation", () => {
  const up = input([fiveMinute(104, 107, 104, 106), fiveMinute(106, 108, 105, 108)], 109);
  const long = scenario(calculateFuturesEntryPoints(up, end), "key_reclaim");
  assert.equal(long.status, "ready");
  const down = input([fiveMinute(106, 106, 103, 104), fiveMinute(104, 105, 102, 102)], 101);
  assert.equal(scenario(calculateFuturesEntryPoints(down, end), "key_breakdown").status, "ready");
  const ordinary = input([fiveMinute(120, 121, 119, 120), fiveMinute(120, 121, 119, 120)], 120);
  const waiting = calculateFuturesEntryPoints(ordinary, end);
  assert.ok(waiting.scenarios.every(s => s.status === "waiting"));
  assert.ok(waiting.scenarios.every(s => s.entry === null && s.stop === null && s.target === null));
});
test("recent one-minute touch updates the stage before the five-minute confirmation closes", () => {
  const data = input([fiveMinute(105, 107, 103, 106), fiveMinute(106, 107, 104, 105)], 100.5);
  data.bars.push({
    time: new Date(end).toISOString(), open: 102, high: 103, low: 100, close: 100.5,
  });
  const result = calculateFuturesEntryPoints(data, end);
  assert.equal(scenario(result, "support_bounce").status, "level_reached");
  assert.match(scenario(result, "support_bounce").evidence, /最近 1 分 K 已觸及/);
  assert.equal(scenario(result, "support_bounce").entry, null);
});
test("large structural stop remains visible but never becomes actionable", () => {
  const data = input([fiveMinute(100, 103, 100, 102), fiveMinute(101, 120, 101, 110)], 121);
  const result = scenario(calculateFuturesEntryPoints(data, end), "support_bounce");
  assert.equal(result.status, "risk_too_wide");
  assert.equal(result.entry, 121);
  assert.ok(result.riskPoints > calculateFuturesEntryPoints(data, end).atr14);
});
test("only complete and consecutive observed five-minute candles qualify", () => {
  const data = input();
  assert.equal(calculateFuturesEntryPoints({ ...data, bars: data.bars.slice(1) }, end).state, "warming_up");
  const gap = data.bars.filter((_, i) => i !== 72);
  assert.equal(calculateFuturesEntryPoints({ ...data, bars: gap }, end).state, "warming_up");
  // An older complete bar must not hide an internal gap in the newest 22.
  const shifted = data.bars.map(b => ({ ...b, time: new Date(Date.parse(b.time) + 5 * 60_000).toISOString() })).filter((_, i) => i !== 72);
  const gapWithHistory = calculateFuturesEntryPoints({
    ...data, asOf: new Date(end + 5 * 60_000).toISOString(),
    bars: [...data.bars.slice(0, 5), ...shifted],
  }, end + 5 * 60_000);
  assert.equal(gapWithHistory.state, "warming_up");
  assert.match(gapWithHistory.reason, /有缺漏/);
  assert.equal(completedFuturesEntryBars(data, end - 1).length, 21);
  const duplicate = [...data.bars, data.bars[72]];
  assert.equal(calculateFuturesEntryPoints({ ...data, bars: duplicate }, end).state, "warming_up");
  const corrupt = data.bars.map((b, i) => i === 72 ? { ...b, high: 1 } : b);
  assert.equal(calculateFuturesEntryPoints({ ...data, bars: corrupt }, end).state, "warming_up");
  assert.equal(completedFuturesEntryBars({ ...data, bars: [...data.bars].reverse() }, end).length, 22);
});
test("closed, stale, foreign-session and missing quotes fail closed", () => {
  const data = input();
  for (const changed of [
    { asOf: null }, { asOf: new Date(end - 181_000).toISOString() },
    { asOf: new Date(end + 61_000).toISOString() }, { price: null },
    { symbol: "TXF8" }, { date: "20261105" }, { date: "20260230" },
  ]) {
    const r = calculateFuturesEntryPoints({ ...data, ...changed }, end);
    assert.equal(r.state, "stale");
    assert.equal(r.scenarios.length, 0);
  }
  assert.equal(calculateFuturesEntryPoints({ ...data, status: "closed" }, end).state, "closed");
  assert.equal(calculateFuturesEntryPoints({ ...data, status: "unavailable" }, end).state, "unavailable");
  assert.equal(calculateFuturesEntryPoints({ ...data, asOf: new Date(end + 6 * 60_000).toISOString() }, end + 6 * 60_000).state, "stale");
  const oldQuote = scenario(calculateFuturesEntryPoints({ ...data, price: 105, asOf: new Date(end - 30_000).toISOString() }, end), "support_bounce");
  assert.notEqual(oldQuote.status, "ready");
});
test("night-session observations remain aligned across midnight", () => {
  const data = input();
  const nightStart = Date.parse("2026-11-06T23:00:00+08:00");
  const shift = nightStart - start;
  const now = end + shift;
  const night = {
    ...data, symbol: "TXF8", price: 105,
    asOf: new Date(now).toISOString(),
    bars: data.bars.map(b => ({ ...b, time: new Date(Date.parse(b.time) + shift).toISOString() })),
  };
  assert.equal(calculateFuturesEntryPoints(night, now).state, "ready");
  assert.equal(calculateFuturesEntryPoints({ ...night, date: "20261107" }, now).state, "stale");
});
test("flat candles do not fabricate volatility or executable prices", () => {
  const data = input();
  data.bars = data.bars.map(b => ({ ...b, open: 100, high: 100, low: 100, close: 100 }));
  const r = calculateFuturesEntryPoints(data, end);
  assert.equal(r.state, "warming_up");
  assert.equal(r.scenarios.length, 0);
});
