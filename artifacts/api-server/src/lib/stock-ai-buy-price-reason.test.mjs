import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStockAiBuyPriceReason,
  isUsableStockAiBuyPriceReason,
} from "./stock-ai-buy-price-reason.ts";

const baseInput = {
  verdict: "do_not_buy",
  plannedBuyPrice: 50,
  currentPrice: 48,
  usesOfficialClose: false,
  hasValidBuyPlan: false,
  action: "buy",
  actionLabel: "買進",
  pricePlanStatus: "available",
  pricePlanMessage: "",
  missingBuyPlanItems: ["停損價與依據"],
  entryPrice: null,
  stopLossPrice: null,
  takeProfitPrice: null,
  risks: [],
};

test("explains the entered-price comparison and missing buy-plan fields", () => {
  const reason = buildStockAiBuyPriceReason(baseInput);

  assert.ok(reason.length <= 180);
  assert.match(reason, /輸入價 50\.00 元比最新成交報價 48\.00 元高 2\.00 元/u);
  assert.match(reason, /缺少停損價與依據/u);
  assert.match(reason, /目前不建議買進/u);
});

test("keeps a rejected plan explanation within the API reason limit", () => {
  const reason = buildStockAiBuyPriceReason({
    ...baseInput,
    pricePlanStatus: "rejected",
    pricePlanMessage: "資料不足".repeat(100),
  });

  assert.ok(reason.length <= 180);
  assert.match(reason, /買進方案未通過檢核/u);
  assert.ok(reason.endsWith("目前不建議買進。"));
});

test("keeps a valid-plan rejection concise while including a risk", () => {
  const reason = buildStockAiBuyPriceReason({
    ...baseInput,
    hasValidBuyPlan: true,
    plannedBuyPrice: 205,
    currentPrice: 198,
    entryPrice: 190,
    stopLossPrice: 180,
    takeProfitPrice: 205,
    risks: ["價格已接近短期區間上緣，成交量變化也可能提高短線波動。".repeat(8)],
  });

  assert.ok(reason.length <= 180);
  assert.match(reason, /已達或高於目標參考 205\.00 元/u);
  assert.match(reason, /主要風險/u);
});

test("explains that an entry-level limit price is not a buy-now signal when market is above it", () => {
  const reason = buildStockAiBuyPriceReason({
    ...baseInput,
    hasValidBuyPlan: true,
    plannedBuyPrice: 5_500,
    currentPrice: 5_595,
    entryPrice: 5_500,
    stopLossPrice: 5_300,
    takeProfitPrice: 5_700,
  });

  assert.match(reason, /輸入價等於進場參考 5500\.00 元/u);
  assert.match(reason, /現價高於進場參考 5500\.00 元，先不要追價/u);
});

test("states conditional execution levels for an accepted valid plan", () => {
  const reason = buildStockAiBuyPriceReason({
    ...baseInput,
    verdict: "buy",
    hasValidBuyPlan: true,
    entryPrice: 49,
    stopLossPrice: 46,
    takeProfitPrice: 55,
  });

  assert.ok(reason.length <= 180);
  assert.match(reason, /可作條件式參考/u);
  assert.match(reason, /停損 46\.00 元、目標 55\.00 元/u);
});

test("labels a post-close verdict as a conditional next-session reference", () => {
  const reason = buildStockAiBuyPriceReason({
    ...baseInput,
    verdict: "buy",
    usesOfficialClose: true,
    hasValidBuyPlan: true,
    entryPrice: 49,
    stopLossPrice: 46,
    takeProfitPrice: 55,
  });

  assert.ok(reason.length <= 180);
  assert.match(reason, /官方收盤價估算/u);
  assert.match(reason, /下一交易日條件參考/u);
  assert.match(reason, /開盤後先核對最新成交價/u);
});

test("accepts concise natural-language verdicts without a fixed heading", () => {
  assert.equal(
    isUsableStockAiBuyPriceReason(
      "這個價位可作條件式參考，建議分批評估並先設好停損。",
    ),
    true,
  );
});

test("rejects a verdict explanation without a usable action or condition", () => {
  assert.equal(isUsableStockAiBuyPriceReason("目前市場波動較大。"), false);
});
