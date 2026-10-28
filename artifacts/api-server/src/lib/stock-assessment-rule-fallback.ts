export function buildRuleBasedAssessmentOutput(input: {
  closeDate: string;
  return5dPercent: number | null;
  return20dPercent: number | null;
  return60dPercent: number | null;
  referenceType: "verified_trade" | "official_daily_close";
  marketData?: {
    quotePrice: number | null;
    quoteChangePercent: number | null;
    quoteAsOf: string | null;
    latestDailyCloseDate: string | null;
    return5dPercent: number | null;
    return20dPercent: number | null;
  };
}) {
  const formatReturn = (value: number | null) =>
    value === null ? "未取得" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  const marketFacts = input.marketData
    ? [
        input.marketData.quotePrice !== null
          ? `加權 ${input.marketData.quotePrice.toFixed(2)} 點${input.marketData.quoteChangePercent === null ? "" : `（${formatReturn(input.marketData.quoteChangePercent)}）`}${input.marketData.quoteAsOf ? `，報價 ${input.marketData.quoteAsOf.slice(0, 16).replace("T", " ")}Z` : ""}`
          : null,
        input.marketData.latestDailyCloseDate
          ? `日線至 ${input.marketData.latestDailyCloseDate}，近5/20日 ${formatReturn(input.marketData.return5dPercent)}/${formatReturn(input.marketData.return20dPercent)}`
          : null,
      ].filter((fact): fact is string => fact !== null)
    : [];
  const marketSummary = marketFacts.length
    ? `已取得大盤資料：${marketFacts.join("；")}。備援不判讀個股影響。`
    : "大盤資料不足：即時報價與可用官方指數日線都未取得；備援不推測大盤影響。";

  return {
    direction: "neutral" as const,
    biasLevel: "neutral" as const,
    confidence: "not_applicable" as const,
    summary:
      "方向不明（規則備援）：AI 判讀服務未能完成；固定規則不猜漲跌，等 AI 恢復後再重新判讀。",
    actionProposal:
      "現在先不新增持倉；已持有不因 AI 逾時而賣出或加碼，AI 恢復後再用最新行情重新判讀。",
    marketInfluence: "unavailable" as const,
    marketSummary,
    signals: [
      `官方日線 ${input.closeDate}；個股近 5／20／60 日報酬：${formatReturn(input.return5dPercent)}／${formatReturn(input.return20dPercent)}／${formatReturn(input.return60dPercent)}。`,
      input.referenceType === "official_daily_close"
        ? "報價基準為官方最近收盤價，並非即時成交。"
        : "報價基準為已驗證成交資料。",
      "下方量化評分與歷史回測維持原本固定算法；不以它們替代 AI 綜合判讀。",
    ],
    risks: [
      "AI 服務未能完成，本次不提供方向預測、勝率或個股買賣價位。",
      "備援只呈現已取得的行情與既有量化結果；資料缺漏不補猜。",
    ],
    action: "wait" as const,
    actionReferencePrice: null,
    actionReferenceLabel: null,
    actionReferenceReason: null,
    pricePlanStatus: "not_applicable" as const,
    entryPrice: null,
    entryReason: null,
    stopLossPrice: null,
    stopLossReason: null,
    takeProfitPrice: null,
    takeProfitReason: null,
    forecastLowPrice: null,
    forecastPrice: null,
    forecastHighPrice: null,
    forecastReason: "規則備援不產生未來價格預測。",
    forecastPath: [],
    pricePlanMessage: "AI 判讀未完成；備援不產生買進、停損或目標價。",
  };
}
