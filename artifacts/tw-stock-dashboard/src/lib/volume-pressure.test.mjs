import assert from "node:assert/strict";
import test from "node:test";
import { calculateVolumePressure } from "./volume-pressure.ts";

const up = (volume = 10) => ({ open: 100, high: 110, low: 99, close: 108, volume });
const down = (volume = 10) => ({ open: 108, high: 110, low: 99, close: 100, volume });
const flat = (volume = 10) => ({ open: 100, high: 102, low: 98, close: 100, volume });

test("estimates bullish pressure from greater up-candle volume", () => {
  const result = calculateVolumePressure([up(30), down(10), flat(5)]);
  assert.equal(result?.direction, "bullish");
  assert.equal(result?.upVolume, 30);
  assert.equal(result?.downVolume, 10);
  assert.equal(result?.flatVolume, 5);
});

test("estimates bearish pressure from greater down-candle volume", () => {
  const result = calculateVolumePressure([up(10), down(30), flat(5)]);
  assert.equal(result?.direction, "bearish");
});

test("equal directional volume and all-flat candles are neutral", () => {
  assert.equal(calculateVolumePressure([up(10), down(10), flat(5)])?.direction, "neutral");
  const allFlat = calculateVolumePressure([flat(5), flat(8), flat(12)]);
  assert.equal(allFlat?.direction, "neutral");
  assert.equal(allFlat?.flatVolume, 25);
});

test("returns insufficient when fewer than three valid traded bars remain", () => {
  assert.equal(calculateVolumePressure([up(10), flat(10), down(0)]), null);
});

test("ignores invalid OHLCV bars and selects the latest five valid bars", () => {
  const invalid = { ...up(100), high: 90 };
  assert.equal(calculateVolumePressure([invalid, up(), down(), flat()])?.barCount, 3);

  const result = calculateVolumePressure([down(50), ...Array.from({ length: 5 }, () => up(2))]);
  assert.equal(result?.barCount, 5);
  assert.equal(result?.upVolume, 10);
  assert.equal(result?.downVolume, 0);
  assert.equal(result?.direction, "bullish");
});
