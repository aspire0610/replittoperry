import type { StockAiAssessment } from "@workspace/api-zod";

export type StockAiAssistantPositionAction =
  | "add"
  | "hold"
  | "no_add"
  | "reduce"
  | "take_profit"
  | "stop_loss"
  | "exit"
  | "wait"
  | "insufficient";

type PositionActionAssessment = Pick<
  StockAiAssessment,
  | "action"
  | "referenceType"
  | "pricePlanStatus"
  | "entryPrice"
  | "stopLossPrice"
  | "takeProfitPrice"
  | "referencePrice"
>;

export function hasValidatedBuyPlan(
  assessment: PositionActionAssessment,
): boolean {
  return (
    (assessment.referenceType === "verified_trade" ||
      assessment.referenceType === "official_daily_close") &&
    assessment.action === "buy" &&
    assessment.pricePlanStatus === "available" &&
    assessment.entryPrice !== null &&
    assessment.stopLossPrice !== null &&
    assessment.takeProfitPrice !== null &&
    assessment.stopLossPrice < assessment.entryPrice &&
    assessment.entryPrice < assessment.takeProfitPrice
  );
}

export function getStockAiAssistantPositionActions(
  assessment: PositionActionAssessment,
): StockAiAssistantPositionAction[] {
  if (assessment.action === "insufficient") {
    return ["hold", "no_add", "insufficient"];
  }

  if (assessment.action === "buy") {
    const canAdd =
      hasValidatedBuyPlan(assessment) &&
      assessment.referencePrice !== null &&
      assessment.stopLossPrice !== null &&
      assessment.entryPrice !== null &&
      assessment.referencePrice > assessment.stopLossPrice &&
      assessment.referencePrice <= assessment.entryPrice;
    return [
      ...(canAdd ? (["add"] as const) : []),
      "hold",
      "no_add",
      "reduce",
      "take_profit",
      "stop_loss",
      "exit",
      "insufficient",
    ];
  }

  if (assessment.action === "sell") {
    return ["reduce", "take_profit", "stop_loss", "exit", "insufficient"];
  }

  if (assessment.action === "wait") {
    return [
      "hold",
      "no_add",
      "reduce",
      "take_profit",
      "stop_loss",
      "exit",
      "wait",
      "insufficient",
    ];
  }

  return [
    "hold",
    "no_add",
    "reduce",
    "take_profit",
    "stop_loss",
    "exit",
    "insufficient",
  ];
}

export function hasExplicitStockPositionContext(question: string): boolean {
  const quantity = question.match(
    /(?:持有|持倉|持股)\s*(?:約\s*)?([\d,]+(?:\.\d+)?)\s*(?:股|張)/u,
  );
  const averageCost = question.match(
    /(?:平均成本|持倉成本|持有成本|均價)\s*(?:(?:約|為|是|[:：])\s*)?(?:每股\s*)?([\d,]+(?:\.\d+)?)\s*元?/u,
  );
  const quantityValue = Number(quantity?.[1]?.replace(/,/gu, ""));
  const costValue = Number(averageCost?.[1]?.replace(/,/gu, ""));
  return (
    Number.isFinite(quantityValue) &&
    quantityValue > 0 &&
    Number.isFinite(costValue) &&
    costValue > 0
  );
}

export function normalizeDirectionWinProbabilityPercent(
  value: unknown,
  forceNull = false,
): number | null {
  if (forceNull) return null;
  return Number.isInteger(value) &&
    (value as number) >= 5 &&
    (value as number) <= 95 &&
    (value as number) % 5 === 0
    ? value as number
    : null;
}

export function getStockAiAssistantAllowedPositionActions(
  assessment: PositionActionAssessment,
  question: string,
): StockAiAssistantPositionAction[] {
  return hasExplicitStockPositionContext(question)
    ? getStockAiAssistantPositionActions(assessment)
    : ["insufficient"];
}

export function isStockAiActionQuestion(question: string): boolean {
  return /(要不要(買|賣)|該不該(買|賣)|是否.{0,6}(買|賣)|可以.{0,3}買|能不能.{0,3}買|可不可以.{0,3}買|適合.{0,3}(買|賣)|值得.{0,3}買|買嗎|買進|買入|加碼|減碼|賣出|出場|續抱|持有|持倉|停損|停利|獲利了結|持有時|持有多久|持有幾天|持有期間|預計持有|繼續持有|應該持有|要不要持有|該不該持有|信心度|信心|操作建議|怎麼操作|如何操作|怎麼做)/u.test(
    question,
  );
}
