import assert from "node:assert/strict";
import test from "node:test";
import { parseQuantResearchSummaryOutput } from "./quant-research-summary-output.ts";

test("accepts a short Traditional Chinese summary grounded in historical results", () => {
  assert.equal(
    parseQuantResearchSummaryOutput(
      '{"summary":"策略表現落後大盤，整體回撤明顯，績效穩定度偏弱。"}',
    ),
    "這個做法的結果落後大盤，整體跌幅明顯，結果不太穩。",
  );
});

test("rewrites common quant jargon into plain Traditional Chinese", () => {
  assert.equal(
    parseQuantResearchSummaryOutput(
      '{"summary":"策略年化報酬較高，但最大回撤明顯，夏普比率偏低。"}',
    ),
    "策略按一年換算的報酬較高，但過程中最大的跌幅明顯，報酬和價格起伏的整體表現偏低。",
  );
});

test("rejects numeric output so the summary does not duplicate displayed metrics", () => {
  assert.equal(
    parseQuantResearchSummaryOutput(
      '{"summary":"策略報酬為 12.3%，結果落後大盤。"}',
    ),
    null,
  );
});

test("rejects direct trading instructions and malformed summary output", () => {
  assert.equal(
    parseQuantResearchSummaryOutput(
      '{"summary":"策略表現偏弱，建議加碼並設定停損。"}',
    ),
    null,
  );
  assert.equal(parseQuantResearchSummaryOutput("not JSON"), null);
});
