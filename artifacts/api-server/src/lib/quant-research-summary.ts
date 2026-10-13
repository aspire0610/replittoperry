import { logger } from "./logger.js";
import { withAiProviderFallback } from "./ai-provider-fallback.js";
import {
  QUANT_RESEARCH_AI_PROVIDER_ORDER,
  QUANT_RESEARCH_GEMINI_MODELS,
  QUANT_RESEARCH_GROQ_MODEL,
} from "./quant-research-ai-providers.js";
import type { QuantResearchProgressCallback } from "./quant-research-progress.js";
import type { QuantResearchResultJson } from "./quant-research-runs.js";
import { parseQuantResearchSummaryOutput } from "./quant-research-summary-output.js";

type QuantResearchSummaryContext = Pick<
  QuantResearchResultJson,
  "hypothesis" | "rangeMonths" | "strategy" | "metrics" | "tickerFilter"
>;

const AI_SUMMARY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", minLength: 15, maxLength: 240 },
  },
};

function isUsableAiSummary(text: string | null): boolean {
  return parseQuantResearchSummaryOutput(text) !== null;
}

export async function generateQuantResearchSummary(
  context: QuantResearchSummaryContext,
  onProgress?: QuantResearchProgressCallback,
): Promise<string | null> {
  const metrics = context.metrics;
  try {
    const result = await withAiProviderFallback({
      operation: "quant_research_summary",
      allowedProviders: QUANT_RESEARCH_AI_PROVIDER_ORDER,
      geminiModels: QUANT_RESEARCH_GEMINI_MODELS,
      groqModel: QUANT_RESEARCH_GROQ_MODEL,
      groqMaxOutputTokens: 512,
      instructions: [
        "你是台股量化研究助理，請用繁體中文白話，像向第一次看回測的人解釋一樣，整理成一段簡短說明。",
        "只能根據輸入的假說、策略名稱及回測數字描述已發生的結果；不可推測原因、預測未來或提供買賣建議。",
        "不要使用外部行情、搜尋結果或模型記憶；摘要只能根據輸入的回測結果。",
        "若 tickerFilter 有值，這筆回測只包含該股票；不可把歷史訊號解讀成現在或未來的買賣建議。",
        "若結果是單一股票分段驗證，績效只代表未參與策略挑選的後 40% 驗證期間，不可把它描述成完整回測期間的績效。",
        "若 positionSizing.mode 是 fixed_cash，報酬是期末資產相對累計投入的損益；不要用年化、波動或回撤解讀，且不可把定期投入說成 AI 訊號交易。",
        "用一至三句短句說明這段期間整體是賺是賠、和大盤相比是好是差、過程中是否曾明顯下跌；若資料不足以判斷，請保守說明。",
        "避免年化、夏普、波動度、回撤、因子、再平衡、超額報酬等術語；改用日常說法，例如「按一年換算的報酬」、「價格起伏」和「過程中最大的跌幅」。",
        "不要重複任何數字、百分比、日期、代碼或金額，這些數據已在畫面上方列出。不要使用買進、賣出、進場、停損或目標價等操作指示。",
        "請只回傳符合 JSON Schema 的物件。",
      ],
      input: JSON.stringify({
        hypothesis: context.hypothesis.slice(0, 600),
        tickerFilter: context.tickerFilter ?? null,
        strategyName: context.strategy.name,
        rangeMonths: context.rangeMonths,
        metrics: {
          totalReturnPercent: metrics.totalReturnPercent,
          annualizedReturnPercent: metrics.annualizedReturnPercent,
          maxDrawdownPercent: metrics.maxDrawdownPercent,
          annualizedVolatilityPercent: metrics.annualizedVolatilityPercent,
          sharpeRatio: metrics.sharpeRatio,
          tradeCount: metrics.tradeCount,
          finalEquity: metrics.finalEquity,
          contributedCapital: metrics.contributedCapital ?? null,
          taiexReturnPercent: metrics.taiexReturnPercent,
          relativeToTaiexPercent:
            metrics.totalReturnPercent - metrics.taiexReturnPercent,
        },
      }),
      schema: AI_SUMMARY_JSON_SCHEMA,
      maxOutputTokens: 180,
      timeoutMs: 12_000,
      maxFallbackDurationMs: 48_000,
      geminiTimeoutMs: 24_000,
      geminiModelTimeoutMs: 12_000,
      oneMinAiTimeoutMs: 12_000,
      agnesAiTimeoutMs: 12_000,
      groqTimeoutMs: 12_000,
      ollamaTimeoutMs: 12_000,
      validateOutput: isUsableAiSummary,
      onProviderProgress: ({ message }) => {
        onProgress?.({ type: "progress", stage: "summary", message });
      },
    });
    const summary = parseQuantResearchSummaryOutput(result.text);
    if (summary) return summary;
  } catch (error) {
    logger.warn(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "AI quantitative research summary was unavailable",
    );
  }

  onProgress?.({
    type: "progress",
    stage: "summary",
    message: "AI 摘要暫時無法生成，回測結果仍會保存。",
  });
  return null;
}
