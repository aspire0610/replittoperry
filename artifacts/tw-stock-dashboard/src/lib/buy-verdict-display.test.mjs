import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesBuyVerdictInputs,
  usesDifferentAnalysisVersion,
} from "./buy-verdict-display.ts";

const verdict = {
  symbol: "2330.TW",
  plannedBuyPrice: 1_000,
  analysisAsOf: "2026-10-08T01:00:00.000Z",
};

test("shows a verdict for the same stock and price despite a different analysis timestamp", () => {
  assert.equal(matchesBuyVerdictInputs(verdict, "2330", 1_000), true);
  assert.equal(
    usesDifferentAnalysisVersion(
      verdict.analysisAsOf,
      "2026-10-08T01:01:00.000Z",
    ),
    true,
  );
});

test("does not show a verdict when the selected stock or entered price changed", () => {
  assert.equal(matchesBuyVerdictInputs(verdict, "2317", 1_000), false);
  assert.equal(matchesBuyVerdictInputs(verdict, "2330.TW", 999), false);
});

test("does not report a different analysis when timestamps match or are unavailable", () => {
  assert.equal(
    usesDifferentAnalysisVersion(
      verdict.analysisAsOf,
      new Date(verdict.analysisAsOf),
    ),
    false,
  );
  assert.equal(usesDifferentAnalysisVersion(null, verdict.analysisAsOf), false);
});
