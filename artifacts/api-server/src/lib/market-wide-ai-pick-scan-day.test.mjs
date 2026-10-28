import assert from "node:assert/strict";
import test from "node:test";
import { getTaiwanCalendarDayWindow } from "./market-wide-ai-pick-scan-day.ts";

test("uses one Taiwan-local calendar window for a daily scan key", () => {
  const window = getTaiwanCalendarDayWindow(new Date("2026-10-18T02:00:00.000Z"));
  assert.equal(window.date, "2026-10-18");
  assert.equal(window.start.toISOString(), "2026-10-17T16:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-10-18T16:00:00.000Z");
});

test("starts a new daily scan key at Taiwan midnight", () => {
  const window = getTaiwanCalendarDayWindow(new Date("2026-10-18T16:00:00.000Z"));
  assert.equal(window.date, "2026-10-19");
  assert.equal(window.start.toISOString(), "2026-10-18T16:00:00.000Z");
});
