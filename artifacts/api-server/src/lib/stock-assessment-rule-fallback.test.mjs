import assert from "node:assert/strict";
import test from "node:test";
import { buildRuleBasedAssessmentOutput } from "./stock-assessment-rule-fallback.ts";

test("timeout fallback reports verified returns without inventing a forecast or trade plan", () => {
  const result = buildRuleBasedAssessmentOutput({
    closeDate: "2026-10-16",
    return5dPercent: 1.25,
    return20dPercent: -2.5,
    return60dPercent: null,
    referenceType: "official_daily_close",
  });

  assert.equal(result.action, "wait");
  assert.equal(result.biasLevel, "neutral");
  assert.equal(result.confidence, "not_applicable");
  assert.equal(result.forecastPrice, null);
  assert.equal(result.entryPrice, null);
  assert.deepEqual(result.forecastPath, []);
  assert.match(result.signals[0], /2026-10-16/);
  assert.match(result.signals[0], /未取得/);
  assert.match(result.signals[1], /並非即時成交/);
  assert.match(result.summary, /規則備援/);
});

test("fallback reports available index quote and daily returns without guessing its stock impact", () => {
  const result = buildRuleBasedAssessmentOutput({
    closeDate: "2026-10-16",
    return5dPercent: 1.25,
    return20dPercent: -2.5,
    return60dPercent: null,
    referenceType: "official_daily_close",
    marketData: {
      quotePrice: 27123.45,
      quoteChangePercent: 0.8,
      quoteAsOf: "2026-10-16T05:30:00.000Z",
      latestDailyCloseDate: "2026-10-15",
      return5dPercent: 1.2,
      return20dPercent: -0.6,
    },
  });

  assert.match(result.marketSummary, /已取得大盤資料/);
  assert.match(result.marketSummary, /27123\.45/);
  assert.match(result.marketSummary, /2026-10-15/);
  assert.match(result.marketSummary, /不判讀個股影響/);
  assert.ok(result.marketSummary.length <= 140);
  assert.equal(result.marketInfluence, "unavailable");
});

test("fallback says index data is insufficient only when no quote or daily history is available", () => {
  const result = buildRuleBasedAssessmentOutput({
    closeDate: "2026-10-16",
    return5dPercent: null,
    return20dPercent: null,
    return60dPercent: null,
    referenceType: "verified_trade",
    marketData: {
      quotePrice: null,
      quoteChangePercent: null,
      quoteAsOf: null,
      latestDailyCloseDate: null,
      return5dPercent: null,
      return20dPercent: null,
    },
  });

  assert.match(result.marketSummary, /大盤資料不足/);
});

test("fallback identifies verified trade reference and consistently avoids buy/sell advice", () => {
  const result = buildRuleBasedAssessmentOutput({
    closeDate: "2026-10-16",
    return5dPercent: null,
    return20dPercent: null,
    return60dPercent: null,
    referenceType: "verified_trade",
  });

  assert.equal(result.action, "wait");
  assert.equal(result.actionReferencePrice, null);
  assert.equal(result.pricePlanStatus, "not_applicable");
  assert.match(result.signals[1], /已驗證成交資料/);
  assert.match(result.risks[0], /不提供方向預測/);
});
