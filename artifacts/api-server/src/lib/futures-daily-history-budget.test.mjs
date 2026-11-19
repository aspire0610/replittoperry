import assert from "node:assert/strict";
import test from "node:test";
import {
  withFuturesDailyHistoryBudget,
} from "./futures-daily-history-budget.ts";

const available = {
  status: "available",
  bars: [],
  atr14: 360,
  atr14By4: 90,
  asOf: "2026-11-09",
  source: "TAIFEX official daily history",
};

const pending = {
  status: "unavailable",
  bars: [],
  atr14: null,
  atr14By4: null,
  asOf: null,
  source: "History is still loading",
};

test("uses official history when it finishes within the response budget", async () => {
  const result = await withFuturesDailyHistoryBudget(
    Promise.resolve(available),
    pending,
    100,
  );

  assert.equal(result, available);
});

test("returns a clear fallback when official history exceeds the response budget", async () => {
  const result = await withFuturesDailyHistoryBudget(
    new Promise(() => {}),
    pending,
    1,
  );

  assert.equal(result, pending);
});

test("uses the fallback if official history fails", async () => {
  const result = await withFuturesDailyHistoryBudget(
    Promise.reject(new Error("source unavailable")),
    pending,
    100,
  );

  assert.equal(result, pending);
});
