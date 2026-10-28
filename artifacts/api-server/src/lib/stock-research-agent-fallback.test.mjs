import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStockResearchAgentFallbackAnswer,
  buildStockResearchAgentPartialAnswer,
} from "./stock-research-agent-fallback.ts";

test("labels rule-based research fallback and preserves only supplied evidence", () => {
  const answer = buildStockResearchAgentFallbackAnswer({
    aiProvider: "rule_based",
    summary: "方向不明，近期資料不足以提供方向預測。",
    actionText: "等待官方日線資料更新。",
    signals: ["近 5 日報酬率為 +1.2%。", "大盤資料不足。", "不應顯示這項多餘線索。"],
    risks: ["法人資料未提供。", "不應顯示第二項風險。"],
  });

  assert.match(answer, /規則備援；AI 分析未完成/u);
  assert.match(answer, /方向不明/u);
  assert.match(answer, /操作參考：等待官方日線資料更新/u);
  assert.match(answer, /近 5 日報酬率/u);
  assert.match(answer, /法人資料未提供/u);
  assert.doesNotMatch(answer, /多餘線索|第二項風險/u);
});

test("does not label a retained AI assessment as a rule-based result", () => {
  const answer = buildStockResearchAgentFallbackAnswer({
    aiProvider: "gemini",
    summary: "資料一致程度偏低。",
    actionText: "暫不新增持倉。",
    signals: [],
    risks: [],
  });

  assert.match(answer, /保留既有判讀；AI 問答未完成/u);
  assert.doesNotMatch(answer, /規則備援/u);
});

test("keeps a successful assistant explanation visibly partial when assessment used rules", () => {
  const answer = buildStockResearchAgentPartialAnswer(
    {
      aiProvider: "rule_based",
      summary: "方向不明，暫不買進。",
      actionText: "等待下一交易日確認。",
      signals: ["官方收盤資料可用。"],
      risks: ["個股判讀 AI 未完成。"],
    },
    "gemini",
    "依目前資料先等待。",
  );

  assert.match(answer, /規則備援；AI 分析未完成/u);
  assert.match(answer, /gemini 對備援資料的補充說明/u);
  assert.match(answer, /不代表完整 AI 個股判讀/u);
  assert.match(answer, /依目前資料先等待/u);
});
