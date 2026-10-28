import assert from "node:assert/strict";
import test from "node:test";
import {
  getMarketWideScanHistoryWindow,
  hasAlignedRecentHistoryBars,
} from "./market-wide-scan-history-window.ts";

test("scan history includes the 24-month evaluation window plus indicator warmup", () => {
  const window = getMarketWideScanHistoryWindow("2026-10-16");
  assert.equal(window.startDate, "2024-08-17");
  assert.equal(window.endDate, "2026-10-16");
  assert.equal(window.monthCount, 27);
  assert.equal(window.minimumBars, 506);
});

test("rejects malformed market dates rather than deriving a permissive window", () => {
  assert.throws(() => getMarketWideScanHistoryWindow("2026-02-30"));
});

test("per-stock fallback requires 21 ordered bars ending on the official scan date", () => {
  const bars = Array.from({ length: 21 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
  }));
  assert.equal(hasAlignedRecentHistoryBars(bars, "2026-09-21"), true);
  assert.equal(hasAlignedRecentHistoryBars(bars.slice(1), "2026-09-21"), false);
  assert.equal(hasAlignedRecentHistoryBars(bars, "2026-09-22"), false);
  assert.equal(hasAlignedRecentHistoryBars([bars[1], bars[0], ...bars.slice(2)], "2026-09-21"), false);
});
