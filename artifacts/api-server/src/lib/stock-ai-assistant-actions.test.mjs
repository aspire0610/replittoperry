import assert from "node:assert/strict";
import test from "node:test";
import {
  getStockAiAssistantAllowedPositionActions,
  getStockAiAssistantPositionActions,
  hasExplicitStockPositionContext,
  hasValidatedBuyPlan,
  isStockAiActionQuestion,
} from "./stock-ai-assistant-actions.ts";

const validBuyPlan = {
  action: "buy",
  referenceType: "verified_trade",
  pricePlanStatus: "available",
  referencePrice: 98,
  entryPrice: 100,
  stopLossPrice: 95,
  takeProfitPrice: 110,
};

test("allows adding only with a validated buy plan, including a conditional post-close plan", () => {
  assert.equal(hasValidatedBuyPlan(validBuyPlan), true);
  assert.ok(getStockAiAssistantPositionActions(validBuyPlan).includes("add"));

  const rejectedPlan = { ...validBuyPlan, pricePlanStatus: "rejected" };
  assert.equal(hasValidatedBuyPlan(rejectedPlan), false);
  assert.ok(!getStockAiAssistantPositionActions(rejectedPlan).includes("add"));

  assert.ok(
    !getStockAiAssistantPositionActions({
      ...validBuyPlan,
      referencePrice: 101,
    }).includes("add"),
  );
  assert.ok(
    !getStockAiAssistantPositionActions({
      ...validBuyPlan,
      referencePrice: 94,
    }).includes("add"),
  );

  const officialClose = {
    ...validBuyPlan,
    referenceType: "official_daily_close",
    referencePrice: 100,
  };
  assert.equal(hasValidatedBuyPlan(officialClose), true);
  assert.ok(getStockAiAssistantPositionActions(officialClose).includes("add"));

  const validConditionalClosePlan = { ...officialClose, referencePrice: 98 };
  assert.ok(
    getStockAiAssistantPositionActions(validConditionalClosePlan).includes(
      "add",
    ),
  );

  const closeWithoutPlan = {
    ...officialClose,
    pricePlanStatus: "not_applicable",
    entryPrice: null,
    stopLossPrice: null,
    takeProfitPrice: null,
  };
  assert.ok(!getStockAiAssistantPositionActions(closeWithoutPlan).includes("add"));
});

test("offers distinct position actions when the broader assessment has direction", () => {
  const actions = getStockAiAssistantPositionActions({
    ...validBuyPlan,
    action: "hold",
  });
  assert.ok(actions.includes("reduce"));
  assert.ok(actions.includes("take_profit"));
  assert.ok(actions.includes("stop_loss"));
  assert.ok(!actions.includes("add"));
});

test("still allows a position reduction when the broader assessment says to wait", () => {
  const actions = getStockAiAssistantPositionActions({
    ...validBuyPlan,
    action: "wait",
    pricePlanStatus: "not_applicable",
  });
  assert.ok(actions.includes("reduce"));
  assert.ok(actions.includes("take_profit"));
  assert.ok(actions.includes("stop_loss"));
  assert.ok(!actions.includes("add"));
});

test("keeps insufficient assessments from generating unsupported selling actions", () => {
  const actions = getStockAiAssistantPositionActions({
    ...validBuyPlan,
    action: "insufficient",
    referencePrice: 0,
    entryPrice: null,
    stopLossPrice: null,
    takeProfitPrice: null,
  });
  assert.deepEqual(actions, ["hold", "no_add", "insufficient"]);
});

test("recognizes the calculator's generated position question as an action request", () => {
  const positionQuestion =
    "我目前持有 1000 股，平均成本為每股 100 元。請依目前個股判讀評估這筆持倉。";
  assert.equal(isStockAiActionQuestion(positionQuestion), true);
  assert.equal(hasExplicitStockPositionContext(positionQuestion), true);
  assert.equal(isStockAiActionQuestion("這家公司主要產品是什麼？"), false);
});

test("requires both quantity and average cost before allowing personal position actions", () => {
  const missingCost = "我持有 1000 股，請問目前該怎麼做？";
  const missingQuantity = "平均成本為每股 100 元，現在要不要買？";
  const zeroPosition = "我持有 0 股，平均成本為每股 0 元，請評估持倉。";
  assert.equal(hasExplicitStockPositionContext(missingCost), false);
  assert.equal(hasExplicitStockPositionContext(missingQuantity), false);
  assert.equal(hasExplicitStockPositionContext(zeroPosition), false);

  assert.deepEqual(
    getStockAiAssistantAllowedPositionActions(validBuyPlan, missingCost),
    ["insufficient"],
  );
  assert.equal(
    getStockAiAssistantAllowedPositionActions(
      validBuyPlan,
      "我持股 1 張，均價 100 元，請評估持倉。",
    ).includes("add"),
    true,
  );
});

test("recognizes common buy and sell action phrasings", () => {
  assert.equal(isStockAiActionQuestion("這檔股票要不要賣？"), true);
  assert.equal(isStockAiActionQuestion("現在能不能加碼？"), true);
  assert.equal(isStockAiActionQuestion("這個價格適合買進嗎？"), true);
});
