import assert from "node:assert/strict";
import test from "node:test";
import { resolveFuturesSession, isFuturesSessionTimestamp, isFuturesSessionQuoteTimestamp } from "./futures-session.ts";

const time = (value) => Date.parse(`${value}+08:00`);
test("switches at 13:45 and waits until 15:00 without accepting day bars", () => {
  assert.equal(resolveFuturesSession(time("2026-11-05T13:44:59")).symbol, "TXF1");
  const session = resolveFuturesSession(time("2026-11-05T13:45:00"));
  assert.equal(session.symbol, "TXF8");
  assert.equal(session.active, false);
  assert.equal(isFuturesSessionTimestamp(time("2026-11-05T13:44:00"), session), false);
  assert.equal(resolveFuturesSession(time("2026-11-05T15:00:00")).active, true);
});
test("keeps both sides of midnight in one night session and excludes old sessions", () => {
  const now = time("2026-11-06T02:00:00");
  const session = resolveFuturesSession(now);
  assert.equal(session.symbol, "TXF8");
  assert.equal(session.date, "2026-11-05");
  assert.equal(session.active, true);
  assert.equal(isFuturesSessionTimestamp(time("2026-11-05T15:00:00"), session, now), true);
  assert.equal(isFuturesSessionTimestamp(time("2026-11-06T01:59:00"), session, now), true);
  assert.equal(isFuturesSessionTimestamp(time("2026-11-04T23:00:00"), session, now), false);
  assert.equal(isFuturesSessionTimestamp(time("2026-11-06T02:02:00"), session, now), false);
});
test("night closes at 05:00; switches to day at 08:45", () => {
  for (const value of ["2026-11-06T05:00:00", "2026-11-06T08:44:59"]) {
    const session = resolveFuturesSession(time(value));
    assert.equal(session.symbol, "TXF8");
    assert.equal(session.active, false);
  }
  const session = resolveFuturesSession(time("2026-11-06T08:45:00"));
  assert.equal(session.symbol, "TXF1");
  assert.equal(session.active, true);
});
test("Friday night extends into Saturday but weekend and Monday premarket are closed", () => {
  assert.equal(resolveFuturesSession(time("2026-11-07T02:00:00")).active, true);
  for (const value of ["2026-11-07T16:00:00", "2026-11-08T16:00:00", "2026-11-09T07:50:00"]) {
    const session = resolveFuturesSession(time(value));
    assert.equal(session.symbol, "TXF8");
    assert.equal(session.date, "2026-11-06");
    assert.equal(session.active, false);
  }
});

test("midnight night-session quotes remain date-only while midnight bars are valid", () => {
  const now = time("2026-11-06T07:50:00");
  const session = resolveFuturesSession(now);
  const midnight = time("2026-11-06T00:00:00");
  assert.equal(isFuturesSessionTimestamp(midnight, session, now), true);
  assert.equal(isFuturesSessionQuoteTimestamp(midnight, session, now), false);
  assert.equal(isFuturesSessionQuoteTimestamp(time("2026-11-06T04:59:58"), session, now), true);
  const activeNow = time("2026-11-06T00:00:30");
  assert.equal(isFuturesSessionQuoteTimestamp(midnight, resolveFuturesSession(activeNow), activeNow), false);
  assert.equal(isFuturesSessionQuoteTimestamp(time("2026-11-05T04:59:58"), session, now), false);
});
