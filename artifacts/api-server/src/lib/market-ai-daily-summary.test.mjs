import assert from "node:assert/strict";
import test from "node:test";
import {
  composeDailyMarketSummary,
  isValidSummaryOutput,
} from "./market-ai-daily-summary-format.ts";

const marketData = {
  ticker: "^TWII",
  source: "TWSE MIS",
  asOf: new Date("2026-10-13T05:30:00.000Z"),
  currentPrice: 27_000,
  change: 250,
  changePercent: 0.93,
  dailyCloseDate: "2026-10-13",
  dailyCloseSource: "TWSE Open Data",
  dailyClosePrice: 27_000,
  dailyCloseChange: 250,
  dailyCloseChangePercent: 0.93,
  ma20: 26_500,
  ma60: 26_000,
  ma120: 25_500,
  score: 5,
  status: "bullish",
  factors: [],
};

const analysis = {
  marketRead: "收盤上漲，指數仍在各期平均價格之上。",
  outlook: "若能守住收盤位置，下一交易日仍有偏強機會；跌破則轉震盪。",
  watch: "留意開盤是否守住今日收盤，並確認上漲是否延續。",
  events: "今日經濟事件以搜尋來源日期核實，未核實不猜測。",
  action: "等待開盤方向確認，不追高；若跌破收盤且走弱，先控制曝險。",
};
const closingAnalysis = {
  cause: "指數收高且站上月均線，新聞未能確認單一推升原因。",
  watch: "留意成交量能否延續，並觀察是否跌回月均線下。",
  fiveDayOutlook: "偏多震盪；若量縮跌破月均線，轉為保守。",
  events: "目前沒有日期明確且可核實的重要事件。",
  action: "AI主觀偏多但不追價，跌破月均線時重新評估。",
};
const usIndices = {
  nasdaq: {
    key: "us_nasdaq_composite",
    name: "納斯達克綜合指數",
    ticker: "COMP",
    price: 27_204.38,
    change: -41.52,
    changePercent: -0.15,
    source: "Nasdaq · PHLX 指數 · 資料日期 2026-10-13",
    asOf: null,
    available: true,
    error: null,
  },
  dow: {
    key: "us_dow_jones",
    name: "道瓊工業指數",
    ticker: "^DJI",
    price: 51_670.1,
    change: -180.45,
    changePercent: -0.35,
    source: "Yahoo Finance",
    asOf: new Date("2026-10-13T20:00:00.000Z"),
    available: true,
    error: null,
  },
};

test("AI summary validator requires all five fields and rejects overconfident claims", () => {
  assert.equal(isValidSummaryOutput(JSON.stringify(analysis)), true);
  assert.equal(
    isValidSummaryOutput(JSON.stringify({ ...analysis, watch: "" })),
    false,
  );
  assert.equal(
    isValidSummaryOutput(JSON.stringify({ ...analysis, extra: "unexpected" })),
    false,
  );
  assert.equal(
    isValidSummaryOutput(JSON.stringify({ ...analysis, action: "保證一定上漲" })),
    false,
  );
  assert.equal(isValidSummaryOutput(JSON.stringify(closingAnalysis), "closing"), true);
  assert.equal(
    isValidSummaryOutput(JSON.stringify({ ...closingAnalysis, cause: undefined }), "closing"),
    false,
  );
  assert.equal(
    isValidSummaryOutput(JSON.stringify({ ...closingAnalysis, outlook: "偏多" }), "closing"),
    false,
  );
});

test("composed premarket and closing summaries include official TAIEX performance and clear sections", () => {
  const premarket = composeDailyMarketSummary(marketData, analysis, "premarket", usIndices);
  const closing = composeDailyMarketSummary(marketData, closingAnalysis, "closing", null);

  assert.match(premarket, /前一交易日判讀/u);
  assert.match(closing, /今日盤勢判讀/u);
  assert.match(premarket, /納斯達克 2026-10-13/u);
  assert.match(premarket, /納斯達克綜合指數跌0\.15%/u);
  assert.match(premarket, /道瓊工業指數跌0\.35%/u);
  assert.match(premarket, /至27,204\.38/u);
  assert.match(premarket, /至51,670\.1/u);
  assert.match(premarket, /本日重要事件：/u);
  assert.match(premarket, /AI 主觀建議：/u);
  assert.match(premarket, /技術依據（2026-10-13）：20 日均線 26,500 點，收盤高於500 點；60 日均線 26,000 點/u);
  assert.doesNotMatch(closing, /美股資料日/u);
  assert.match(closing, /可能原因｜/u);
  assert.match(closing, /觀察重點｜/u);
  assert.match(closing, /未來 5 日｜/u);
  assert.match(closing, /近期事件｜/u);
  assert.match(closing, /技術依據｜20 日均線 26,500 點，收盤高於500 點；60 日均線 26,000 點/u);
  for (const summary of [premarket, closing]) {
    assert.match(summary, /AI (?:主觀建議|方向)/u);
  }
  assert.match(
    premarket,
    /加權指數（2026-10-13 官方收盤）：27,000 點，上漲 250 點（\+0\.93%）/u,
  );
  assert.match(
    closing,
    /加權指數｜2026-10-13 收盤 27,000 點｜上漲 250 點（\+0\.93%）/u,
  );
  assert.match(premarket, /可能走勢：/u);
  assert.match(premarket, /留意：/u);
  assert.match(closing, /觀察重點｜/u);
  assert.match(closing, /未來 5 日｜/u);
  assert.ok(premarket.length <= 500);
});

test("maximum permitted AI field lengths still fit the API summary limit", () => {
  const longPremarketAnalysis = Object.fromEntries(
    ["marketRead", "outlook", "watch", "events", "action"].map((field) => [
      field,
      "市場觀察".repeat(20).slice(0, 40),
    ]),
  );
  const longClosingAnalysis = Object.fromEntries(
    ["cause", "watch", "fiveDayOutlook", "events", "action"].map((field) => [
      field,
      "市場觀察".repeat(20).slice(0, 40),
    ]),
  );
  const premarket = composeDailyMarketSummary(
    marketData,
    longPremarketAnalysis,
    "premarket",
    usIndices,
  );
  const closing = composeDailyMarketSummary(marketData, longClosingAnalysis, "closing", null);
  assert.ok(premarket.length <= 500, `premarket length was ${premarket.length}`);
  assert.ok(closing.length <= 500, `closing length was ${closing.length}`);
});
