const MAX_BUY_PRICE_REASON_LENGTH = 180;

type StockAiBuyPriceReasonInput = {
  verdict: "buy" | "do_not_buy";
  plannedBuyPrice: number;
  currentPrice: number;
  usesOfficialClose: boolean;
  hasValidBuyPlan: boolean;
  action: "buy" | "hold" | "sell" | "wait" | "insufficient";
  actionLabel: string;
  pricePlanStatus: "available" | "rejected" | "not_applicable";
  pricePlanMessage: string;
  missingBuyPlanItems: string[];
  entryPrice: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  risks: string[];
};

function truncateText(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  let end = Math.max(0, maxLength - 1);
  const lastIncluded = text.charCodeAt(end - 1);
  const firstExcluded = text.charCodeAt(end);
  if (
    lastIncluded >= 0xd800 &&
    lastIncluded <= 0xdbff &&
    firstExcluded >= 0xdc00 &&
    firstExcluded <= 0xdfff
  ) {
    end -= 1;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}

function formatPrice(value: number): string {
  return value.toFixed(2);
}

export function isUsableStockAiBuyPriceReason(value: string): boolean {
  const reason = value.trim();
  return (
    reason.length > 0 &&
    reason.length <= MAX_BUY_PRICE_REASON_LENGTH &&
    /(買進|不買|不加碼|分批|停損|等待|等到|重新評估|不要追)/u.test(reason)
  );
}

export function buildStockAiBuyPriceReason(
  input: StockAiBuyPriceReasonInput,
): string {
  const {
    verdict,
    plannedBuyPrice,
    currentPrice,
    usesOfficialClose,
    hasValidBuyPlan,
    action,
    actionLabel,
    pricePlanStatus,
    pricePlanMessage,
    missingBuyPlanItems,
    entryPrice,
    stopLossPrice,
    takeProfitPrice,
    risks,
  } = input;
  const difference = plannedBuyPrice - currentPrice;
  const referenceLabel = usesOfficialClose ? "官方收盤參考" : "最新成交報價";
  const priceComparison =
    Math.abs(difference) < 0.005
      ? `輸入價 ${formatPrice(plannedBuyPrice)} 元與${referenceLabel} ${formatPrice(currentPrice)} 元相同。`
      : `輸入價 ${formatPrice(plannedBuyPrice)} 元比${referenceLabel} ${formatPrice(currentPrice)} 元${difference < 0 ? "低" : "高"} ${formatPrice(Math.abs(difference))} 元。`;

  let reason: string;
  if (
    verdict === "buy" &&
    hasValidBuyPlan &&
    entryPrice !== null &&
    stopLossPrice !== null &&
    takeProfitPrice !== null
  ) {
    reason = usesOfficialClose
      ? `依官方收盤價估算，${formatPrice(plannedBuyPrice)} 元可作下一交易日條件參考；開盤後先核對最新成交價。停損 ${formatPrice(stopLossPrice)} 元、目標 ${formatPrice(takeProfitPrice)} 元，皆非保證成交。`
      : `${formatPrice(plannedBuyPrice)} 元可作條件式參考；若考慮買進，分批評估並留意停損 ${formatPrice(stopLossPrice)} 元、目標 ${formatPrice(takeProfitPrice)} 元，不保證成交。`;
  } else if (
    hasValidBuyPlan &&
    entryPrice !== null &&
    stopLossPrice !== null &&
    takeProfitPrice !== null
  ) {
    const planRelation =
      plannedBuyPrice <= stopLossPrice
        ? `輸入價不高於停損參考 ${formatPrice(stopLossPrice)} 元。`
        : plannedBuyPrice >= takeProfitPrice
          ? `輸入價已達或高於目標參考 ${formatPrice(takeProfitPrice)} 元。`
          : plannedBuyPrice < entryPrice
            ? `輸入價低於進場參考 ${formatPrice(entryPrice)} 元。`
            : plannedBuyPrice > entryPrice
              ? `輸入價高於進場參考 ${formatPrice(entryPrice)} 元。`
              : `輸入價等於進場參考 ${formatPrice(entryPrice)} 元。`;
    const timingGuidance =
      currentPrice > entryPrice && plannedBuyPrice <= entryPrice
        ? `現價高於進場參考 ${formatPrice(entryPrice)} 元，先不要追價；等回到參考附近再檢查。`
        : `目前不適合使用此價。主要風險：${truncateText(risks[0] ?? "目前未列出其他風險。", 45)}`;
    reason = `${priceComparison}${planRelation}${timingGuidance}`;
  } else {
    const planBlocker =
      pricePlanStatus === "rejected"
        ? `買進方案未通過檢核：${truncateText(pricePlanMessage || "價位資料不完整。", 55)}`
        : action !== "buy"
          ? `AI 方向為「${actionLabel}」，並非買進方案。`
          : missingBuyPlanItems.length
            ? `AI 方向雖為買進，但缺少${truncateText(missingBuyPlanItems.join("、"), 45)}。`
            : "AI 方向雖為買進，但缺少完整有效的方案依據。";
    reason = `${priceComparison}${truncateText(planBlocker, 65)} 目前不建議買進${usesOfficialClose ? "；開盤後以最新成交價重新評估。" : "。"}`;
  }

  return truncateText(reason, MAX_BUY_PRICE_REASON_LENGTH);
}
