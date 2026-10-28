import test from "node:test";
import assert from "node:assert/strict";
import {
  isTaipeiClosingSummaryHours,
  isTaipeiPremarketSummaryHours,
} from "./market-summary-window.ts";

test("closing summary is visible from 15:00 until 17:00 Taiwan time on weekdays", () => {
  assert.equal(isTaipeiClosingSummaryHours(new Date("2026-10-14T06:59:00Z")), false);
  assert.equal(isTaipeiClosingSummaryHours(new Date("2026-10-14T07:00:00Z")), true);
  assert.equal(isTaipeiClosingSummaryHours(new Date("2026-10-14T08:59:00Z")), true);
  assert.equal(isTaipeiClosingSummaryHours(new Date("2026-10-14T09:00:00Z")), false);
});

test("daily summaries are hidden on weekends and premarket still ends at 10:00 Taiwan time", () => {
  assert.equal(isTaipeiClosingSummaryHours(new Date("2026-10-17T08:00:00Z")), false);
  assert.equal(isTaipeiPremarketSummaryHours(new Date("2026-10-14T00:59:00Z")), true);
  assert.equal(isTaipeiPremarketSummaryHours(new Date("2026-10-14T02:00:00Z")), false);
});
