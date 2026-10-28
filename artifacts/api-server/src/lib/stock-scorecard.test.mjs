import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStockMarkdownReport,
  buildStockScanTags,
  buildStockScorecard,
  buildStockTradeScenarios,
  qualifiesForAutomatedQuantSignal,
} from "./stock-scorecard.ts";
import { GetStockAiAssessmentResponse } from "../../../../lib/api-zod/src/generated/api.ts";

function makeBars(count = 80) {
  return Array.from({ length: count }, (_, index) => {
    const close = 50 + index * 0.6 + Math.sin(index / 3) * 2;
    return {
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      high: close + 2,
      low: close - 2,
      close,
      volume: 100_000 + index * 1_000,
    };
  });
}

test("scorecard preserves unavailable chip points instead of normalizing", () => {
  const scorecard = buildStockScorecard(makeBars(), {
    status: "available",
    foreignNetShares: 10_000,
    investmentTrustNetShares: -2_000,
  });

  assert.equal(scorecard.maximumPoints, 100);
  assert.equal(scorecard.availablePoints, 80);
  assert.equal(scorecard.complete, false);
  assert.equal(scorecard.items.find((item) => item.id === "main-force").points, null);
  assert.equal(scorecard.items.find((item) => item.id === "holders-margin").points, null);
  assert.ok(scorecard.earnedPoints <= scorecard.availablePoints);
  assert.match(scorecard.note, /不可.*換算成 100 分/);
  assert.equal(scorecard.items.length, 11);
  assert.notEqual(scorecard.technicalIndicators.ma5, null);
  assert.notEqual(scorecard.technicalIndicators.ma20DeviationPercent, null);
  assert.notEqual(scorecard.technicalIndicators.kdK, null);
  assert.notEqual(scorecard.technicalIndicators.macdHistogram, null);
  GetStockAiAssessmentResponse.shape.scorecard.parse(scorecard);
});

test("single-day institutional scores are explicit and data gaps remain unavailable", () => {
  const scorecard = buildStockScorecard(makeBars(), {
    status: "unavailable",
    foreignNetShares: null,
    investmentTrustNetShares: null,
  });

  assert.equal(scorecard.availablePoints, 60);
  assert.equal(scorecard.items.find((item) => item.id === "institution-外資").points, null);
  assert.equal(scorecard.items.find((item) => item.id === "macd").status, "available");
  assert.equal(scorecard.items.find((item) => item.id === "weekly-daily-alignment").maximumPoints, 5);
});

test("liquidity and extreme opening gaps are surfaced without inventing score data", () => {
  const bars = makeBars().map((bar) => ({ ...bar, volume: 1 }));
  bars.at(-1).open = bars.at(-2).close * 1.06;
  const scorecard = buildStockScorecard(bars, {
    status: "unavailable",
    foreignNetShares: null,
    investmentTrustNetShares: null,
  });
  const volumeNote = scorecard.items.find((item) => item.id === "volume-breakout").note;
  assert.match(volumeNote, /流動性不足/);
  assert.match(volumeNote, /開盤跳空 \+6\.0%/);
});

test("trade scenarios calculate price-based reward/risk only for valid levels", () => {
  const scenarios = buildStockTradeScenarios(makeBars(), 100);
  assert.ok(scenarios.atr14 > 0);
  assert.equal(scenarios.supportPrice, Math.min(...makeBars().slice(-20).map((bar) => bar.low)));
  assert.equal(scenarios.resistancePrice, Math.max(...makeBars().slice(-20).map((bar) => bar.high)));
  assert.ok(scenarios.directEntry.rewardToRisk > 0);
  assert.ok(scenarios.pullbackEntry.rewardToRisk > 0);
  const atr = scenarios.methodNote.match(/ATR\(14\)為 ([\d.]+) 元/);
  assert.ok(atr);
  assert.match(scenarios.methodNote, /1\.5 倍 ATR/);

  const invalid = buildStockTradeScenarios(makeBars(20), 1000);
  assert.equal(invalid.directEntry.rewardToRisk, null);
});

test("quant signal requires score above 80, R/R above 2, two trust-buy days, and volume breakout", () => {
  const signal = { score: 81, rewardToRisk: 2.01, trustBuyDays: 2, volumeBreakoutAboveMonthlyAverage: true };
  assert.equal(qualifiesForAutomatedQuantSignal(signal), true);
  assert.equal(qualifiesForAutomatedQuantSignal({ ...signal, score: 80 }), false);
  assert.equal(qualifiesForAutomatedQuantSignal({ ...signal, rewardToRisk: 2 }), false);
  assert.equal(qualifiesForAutomatedQuantSignal({ ...signal, trustBuyDays: 1 }), false);
  assert.equal(qualifiesForAutomatedQuantSignal({ ...signal, volumeBreakoutAboveMonthlyAverage: false }), false);
});

test("markdown report follows the supplied headings and keeps partial scores explicit", () => {
  const bars = makeBars();
  const scorecard = buildStockScorecard(bars, {
    status: "unavailable",
    foreignNetShares: null,
    investmentTrustNetShares: null,
  });
  const report = buildStockMarkdownReport({
    symbol: "2330",
    ticker: "2330.TW",
    name: "台積電",
    currentPrice: 100,
    changePercent: 1.25,
    biasLevel: "bullish",
    summary: "偏多，價格站在均線上方。",
    actionText: "等待拉回後重新核對。",
    scorecard,
    scenarios: buildStockTradeScenarios(bars, 100),
  });

  for (const heading of [
    "## 1. 綜合評分與訊號 (Summary)",
    "## 2. 三大維度診斷 (Quant Breakdown)",
    "## 3. 交易策略與多情境試算 (Trading Simulation)",
    "## 4. 具體操作建議 (Actionable Insight)",
  ]) assert.ok(report.includes(heading));
  assert.match(report, /量化綜合得分.*\/ 100 分（本次可評估 60 \/ 100 分/);
  assert.match(report, /動能與趨勢評估（\/30）/);
  assert.match(report, /預估停損位 \(含 ATR 防守\)/);
  assert.match(report, /\| \*\*情境一：現價進場\*\* \|/);
  assert.match(report, /\| \*\*情境二：回測進場\*\* \|/);
  assert.doesNotMatch(report, /評分說明：|價位試算說明：/);
});

test("automated quant template presents scan tags, dimension scores, scenarios, and risk discipline", () => {
  const bars = makeBars();
  const scorecard = buildStockScorecard(bars, {
    status: "unavailable",
    foreignNetShares: null,
    investmentTrustNetShares: null,
  });
  const report = buildStockMarkdownReport({
    symbol: "2330",
    ticker: "2330.TW",
    name: "台積電",
    currentPrice: 100,
    changePercent: 1.25,
    biasLevel: "bullish",
    summary: "法人籌碼偏多，價格仍在均線上方。",
    actionText: "等待拉回支撐後再分批進場。",
    template: "automated_quant",
    action: "buy",
    riskNote: "成交量資料不足。",
    positionSizingNote: "未提供單筆風險預算，不估算資金或股數。",
    scorecard,
    scenarios: buildStockTradeScenarios(bars, 100),
  });

  for (const heading of [
    "## 0. 自動化掃描與亮點標籤 (Automated Scan Tags)",
    "## 1. 綜合評分與自動化訊號 (Summary & Signal)",
    "## 2. 三大維度量化診斷 (Quant Breakdown)",
    "## 3. 智慧交易策略與部位試算 (Automated Simulation & Sizing)",
    "## 4. 自動化執行紀律與風控 (Action Plan & Risk Control)",
  ]) assert.ok(report.includes(heading));
  assert.match(report, /量化綜合得分.*\/ 100 分/);
  assert.match(report, /籌碼面評估（\/40）/);
  assert.match(report, /量價面評估（\/30）/);
  assert.match(report, /動能與回測評估（\/30）/);
  assert.match(report, /情境一：現價自動進場/);
  assert.match(report, /情境二：回測支撐佈局/);
  assert.match(report, /首批建立 1 單位部位/);
  assert.match(report, /觸及支撐加碼 1 單位/);
   assert.match(report, /歷史回測勝率參考：目前沒有足夠且可驗證的同條件樣本/);
   assert.equal(report.split("\n").filter((line) => line.startsWith("* `")).length, 3);
  assert.ok(buildStockScanTags(scorecard).some((tag) => tag.includes("同條件歷史勝率：尚未驗證")));
  assert.match(report, /風險提示：請嚴格執行動態 ATR 停損與資金控管/);
});

test("rate-limited fallback keeps the same Markdown template without inventing an AI signal", () => {
  const bars = makeBars();
  const scorecard = buildStockScorecard(bars, {
    status: "unavailable",
    foreignNetShares: null,
    investmentTrustNetShares: null,
  });
  const report = buildStockMarkdownReport({
    symbol: "6223",
    ticker: "6223.TWO",
    name: null,
    currentPrice: bars.at(-1).close,
    changePercent: null,
    biasLevel: "insufficient",
    summary: "AI 判讀目前受限，無法提供方向訊號。",
    actionText: "暫不提供 AI 買賣建議；請稍後重新分析。",
    scorecard,
    scenarios: buildStockTradeScenarios(bars, bars.at(-1).close),
  });

  assert.match(report, /6223 \(6223\.TWO\)/);
  assert.match(report, /決策訊號.*資料不足，暫無訊號/);
  assert.match(report, /## 3\. 交易策略與多情境試算/);
  assert.match(report, /## 4\. 具體操作建議/);
});
