import assert from "node:assert/strict";
import test from "node:test";
import {
  isTaipeiWeekend,
  parseTwseHolidayDates,
} from "./twse-holiday-calendar.ts";

const calendar2026 = {
  stat: "ok",
  data: [
    ["2026-02-11", "農曆春節前最後交易日", "農曆春節前最後交易。"],
    ["2026-02-12", "市場無交易，僅辦理結算交割作業", ""],
    ["2026-02-20", "農曆春節及補假", "依規定放假及補假。"],
    ["2026-02-23", "農曆春節後開始交易日", "開始交易。"],
  ],
};

test("Taipei weekend dates are non-trading days across UTC date boundaries", () => {
  assert.equal(isTaipeiWeekend(new Date("2026-10-16T16:30:00.000Z")), true);
  assert.equal(isTaipeiWeekend(new Date("2026-10-18T16:30:00.000Z")), false);
});

test("holiday parser includes closures and excludes last/first trading-day notices", () => {
  const dates = parseTwseHolidayDates(calendar2026, 2026);
  assert.deepEqual([...dates ?? []].sort(), ["2026-02-12", "2026-02-20"]);
});

test("holiday parser rejects malformed or wrong-year calendars", () => {
  assert.equal(parseTwseHolidayDates({ stat: "error", data: [] }, 2026), null);
  const dates = parseTwseHolidayDates(
    { stat: "ok", data: [["2027-01-01", "放假", "依規定放假1日。"]] },
    2026,
  );
  assert.deepEqual([...dates ?? []], []);
});
