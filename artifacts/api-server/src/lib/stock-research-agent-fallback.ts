import type { StockAiAssessment } from "@workspace/api-zod";

type AgentFallbackAssessment = Pick<
  StockAiAssessment,
  "aiProvider" | "summary" | "actionText" | "signals" | "risks"
>;

export function buildStockResearchAgentFallbackAnswer(
  assessment: AgentFallbackAssessment,
): string {
  const heading =
    assessment.aiProvider === "rule_based"
      ? "【規則備援；AI 分析未完成】"
      : "【保留既有判讀；AI 問答未完成】";
  return [
    heading,
    assessment.summary,
    `操作參考：${assessment.actionText}`,
    ...assessment.signals.slice(0, 2).map((signal) => `依據：${signal}`),
    ...assessment.risks.slice(0, 1).map((risk) => `風險：${risk}`),
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildStockResearchAgentPartialAnswer(
  assessment: AgentFallbackAssessment | null,
  assistantProvider: string,
  assistantAnswer: string,
): string {
  const fallback = assessment
    ? buildStockResearchAgentFallbackAnswer(assessment)
    : "【規則備援；AI 個股判讀未完成】判讀內容無法取得。";
  return [
    fallback,
    `【${assistantProvider} 對備援資料的補充說明；不代表完整 AI 個股判讀】`,
    assistantAnswer,
  ]
    .filter(Boolean)
    .join("\n\n");
}
