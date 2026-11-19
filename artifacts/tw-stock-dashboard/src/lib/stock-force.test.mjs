import assert from "node:assert/strict";
import test from "node:test";
import { calculateStockForce } from "./stock-force.ts";

const flatBar = (volume = 1) => ({
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume,
});

test("counts valid flat-price candles as neutral volume, not missing data", () => {
  assert.equal(calculateStockForce([flatBar(), flatBar(2), flatBar(3)]), 0);
});

test("uses the latest five valid traded candles and includes flat candles", () => {
  const bars = [
    { open: 100, high: 110, low: 100, close: 110, volume: 10 },
    { open: 100, high: 110, low: 100, close: 110, volume: 10 },
    { open: 100, high: 110, low: 100, close: 110, volume: 10 },
    flatBar(100),
    flatBar(100),
    flatBar(100),
    flatBar(100),
  ];
  assert.equal(calculateStockForce(bars), 2);
});

test("still requires three valid candles with positive volume", () => {
  assert.equal(calculateStockForce([flatBar(), flatBar(0), { ...flatBar(), volume: null }]), null);
});
