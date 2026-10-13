import { createHash } from "node:crypto";
import {
  PostAccountQuantResearchInterpretResponse as QuantResearchInterpretationSchema,
  type QuantResearchInterpretation,
  type QuantResearchInput,
  type QuantStrategy,
} from "@workspace/api-zod";
import {
  withAiProviderFallback,
  type AiProviderName,
} from "./ai-provider-fallback.js";
import {
  QUANT_RESEARCH_AI_PROVIDER_ORDER,
  QUANT_RESEARCH_GEMINI_MODELS,
  QUANT_RESEARCH_GROQ_MODEL,
} from "./quant-research-ai-providers.js";
import {
  calculateQuantBacktest,
  normalizeFactorWeights,
  type QuantRebalance,
  type QuantWeekday,
} from "./quant-backtest.js";
import {
  getLastCompletedTaiwanMarketDate,
  getOfficialMarketRange,
} from "./quant-market-data.js";
import { generateQuantResearchSummary } from "./quant-research-summary.js";
import type { ParsedQuantMarketDay } from "./quant-market-parse.js";
import type { QuantResearchProgressCallback } from "./quant-research-progress.js";
import type { QuantResearchResultDraft } from "./quant-research-runs.js";
import {
  parseQuantSignalRule,
  type QuantSignalRule,
} from "./quant-signal-rules.js";
import {
  normalizeQuantTickerFilter,
  QuantTickerFilterError,
  resolveQuantTickerFilter,
} from "./quant-ticker-filter.js";
import { parseRecurringContribution } from "./quant-recurring-investment.js";

export class QuantResearchError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "QuantResearchError";
  }
}

const AI_STRATEGY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "rationale", "factorWeights", "entryRule", "exitRule", "positionSizing"],
  properties: {
    name: { type: "string", minLength: 2, maxLength: 60 },
    rationale: { type: "string", minLength: 10, maxLength: 300 },
    factorWeights: {
      type: "object",
      additionalProperties: false,
      required: [
        "momentum20",
        "momentum60",
        "liquidity20",
        "lowVolatility20",
      ],
      properties: {
        momentum20: { type: "number", minimum: 0, maximum: 1 },
        momentum60: { type: "number", minimum: 0, maximum: 1 },
        liquidity20: { type: "number", minimum: 0, maximum: 1 },
        lowVolatility20: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    entryRule: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "conditions"],
      properties: {
        mode: { type: "string", enum: ["all", "any"] },
        conditions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["factor", "operator", "threshold"],
            properties: {
              factor: {
                type: "string",
                enum: ["momentum20", "momentum60", "liquidity20", "volatility20"],
              },
              operator: { type: "string", enum: ["gte", "lte"] },
              threshold: {
                type: "number",
                minimum: -0.99,
                maximum: 1_000_000_000_000,
              },
            },
          },
        },
      },
    },
    exitRule: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "conditions"],
      properties: {
        mode: { type: "string", enum: ["all", "any"] },
        conditions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["factor", "operator", "threshold"],
            properties: {
              factor: {
                type: "string",
                enum: ["momentum20", "momentum60", "liquidity20", "volatility20"],
              },
              operator: { type: "string", enum: ["gte", "lte"] },
              threshold: {
                type: "number",
                minimum: -0.99,
                maximum: 1_000_000_000_000,
              },
            },
          },
        },
      },
    },
    positionSizing: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "sharesPerEntry", "frequency"],
      properties: {
        mode: { type: "string", enum: ["portfolio", "fixed_shares"] },
        sharesPerEntry: { type: ["integer", "null"], minimum: 1, maximum: 100000 },
        frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
      },
    },
  },
};

const AI_INTERPRETATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "mode",
    "tickerFilter",
    "weekday",
    "amountPerEntry",
    "totalContributionLimit",
    "strategy",
    "summary",
  ],
  properties: {
    mode: { type: "string", enum: ["signal", "recurring_cash"] },
    tickerFilter: { type: ["string", "null"] },
    weekday: {
      type: ["string", "null"],
      enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "first_trading_day", null],
    },
    amountPerEntry: { type: ["number", "null"], minimum: 1, maximum: 100_000_000 },
    totalContributionLimit: { type: ["number", "null"], minimum: 1, maximum: 100_000_000 },
    strategy: AI_STRATEGY_JSON_SCHEMA,
    summary: { type: "string", minLength: 8, maxLength: 400 },
  },
};

function parseQuantResearchInterpretation(
  value: unknown,
): QuantResearchInterpretation | null {
  const parsed = QuantResearchInterpretationSchema.safeParse(value);
  if (!parsed.success) return null;
  const plan = parsed.data;
  if (!parseAiStrategy(plan.strategy)) return null;
  if (plan.mode === "recurring_cash") {
    if (
      !plan.tickerFilter ||
      !plan.weekday ||
      !plan.amountPerEntry ||
      (plan.totalContributionLimit !== null &&
        plan.totalContributionLimit < plan.amountPerEntry)
    ) {
      return null;
    }
  } else if (
    plan.weekday !== null ||
    plan.amountPerEntry !== null ||
    plan.totalContributionLimit !== null
  ) {
    return null;
  }
  return plan;
}

export async function interpretQuantResearchHypothesis(
  input: QuantResearchInput,
): Promise<QuantResearchInterpretation> {
  const result = await withAiProviderFallback({
    operation: "quant_hypothesis_interpretation",
    instructions: [
      "將使用者的繁體中文研究假設轉成可供確認的量化回測條件，不要開始回測。",
      "明確指定每週投入金額時使用 recurring_cash；其餘使用 signal。",
      "辨識假設中明確指定的台股或 ETF 代碼；未指定時沿用輸入的限定股票，否則為 null。",
      "定期投入必須有單一股票或 ETF。amountPerEntry 是每次投入金額；totalContributionLimit 只在使用者明確指定累計投入上限時填數字，否則為 null。",
      "定期投入若未指定星期幾，weekday 使用 first_trading_day；有指定星期一至五時使用對應英文值。",
      "「每週投入 3000 元，累計投入到 10 萬元」代表 amountPerEntry=3000 且 totalContributionLimit=100000，最後一期只投入剩餘額度。",
      "不要把每次投入金額或累計投入上限當成起始資金。tickerFilter 請輸出四至六位數，可附 .TW 或 .TWO。",
      "strategy 必須是根據同一假設產生、可執行的完整策略規格，包含買入條件、賣出條件、因子權重與持倉方式；不可只寫摘要。此策略會在使用者確認後原樣執行。",
      "summary 用繁體中文簡要重述將執行的條件。只回傳符合 JSON Schema 的物件。",
    ],
    input: JSON.stringify({
      hypothesis: input.hypothesis,
      tickerFilter: input.tickerFilter ?? null,
      rangeMonths: input.rangeMonths,
      startingCapital: input.startingCapital,
      topN: input.topN,
      rebalance: input.rebalance,
    }),
    schema: AI_INTERPRETATION_JSON_SCHEMA,
    maxOutputTokens: 900,
    allowedProviders: QUANT_RESEARCH_AI_PROVIDER_ORDER,
    geminiModels: QUANT_RESEARCH_GEMINI_MODELS,
    groqModel: QUANT_RESEARCH_GROQ_MODEL,
    maxFallbackDurationMs: 48_000,
    geminiTimeoutMs: 24_000,
    geminiModelTimeoutMs: 12_000,
    oneMinAiTimeoutMs: 12_000,
    agnesAiTimeoutMs: 12_000,
    groqTimeoutMs: 12_000,
    ollamaTimeoutMs: 12_000,
    validateOutput: (text) =>
      parseQuantResearchInterpretation(extractJsonObject(text)) !== null,
  });
  const plan = parseQuantResearchInterpretation(extractJsonObject(result.text));
  if (!plan) {
    throw new QuantResearchError("AI 無法清楚判讀研究條件，請補充標的、投入頻率或金額。", 422);
  }
  return { ...plan, aiProvider: result.provider };
}

function extractJsonObject(text: string | null): unknown {
  if (!text?.trim()) return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AiQuantStrategy = Omit<QuantStrategy, "entryRule" | "exitRule" | "positionSizing"> & {
  entryRule: QuantSignalRule;
  exitRule: QuantSignalRule;
  positionSizing: {
    mode: "portfolio" | "fixed_shares" | "fixed_cash";
    sharesPerEntry: number | null;
    frequency: QuantRebalance;
    amountPerEntry?: number | null;
    weekday?: QuantWeekday | null;
  };
};

function parseAiStrategy(value: unknown): AiQuantStrategy | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    !isRecord(value.factorWeights) ||
    !isRecord(value.positionSizing)
  ) {
    return null;
  }
  const { name, rationale, factorWeights } = value;
  const entryRule = parseQuantSignalRule(value.entryRule, "entry");
  const exitRule = parseQuantSignalRule(value.exitRule, "exit");
  const sizing = value.positionSizing;
  const keys = [
    "momentum20",
    "momentum60",
    "liquidity20",
    "lowVolatility20",
  ] as const;
  if (
    typeof name !== "string" ||
    name.trim().length < 2 ||
    name.trim().length > 60 ||
    typeof rationale !== "string" ||
    rationale.trim().length < 10 ||
    rationale.trim().length > 300 ||
    !entryRule ||
    !exitRule ||
    !["portfolio", "fixed_shares"].includes(String(sizing.mode)) ||
    !["daily", "weekly", "monthly"].includes(String(sizing.frequency)) ||
    (sizing.mode === "fixed_shares" &&
      (!Number.isInteger(sizing.sharesPerEntry) ||
        Number(sizing.sharesPerEntry) < 1 ||
        Number(sizing.sharesPerEntry) > 100000)) ||
    (sizing.mode === "portfolio" && sizing.sharesPerEntry !== null) ||
    Object.keys(factorWeights).length !== keys.length ||
    !keys.every((key) => {
      const weight = factorWeights[key];
      return (
        typeof weight === "number" &&
        Number.isFinite(weight) &&
        weight >= 0 &&
        weight <= 1
      );
    })
  ) {
    return null;
  }

  const weights = {
    momentum20: factorWeights.momentum20 as number,
    momentum60: factorWeights.momentum60 as number,
    liquidity20: factorWeights.liquidity20 as number,
    lowVolatility20: factorWeights.lowVolatility20 as number,
  };
  const total = Object.values(weights).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (total < 0.85 || total > 1.15) return null;
  return {
    name: name.trim(),
    rationale: rationale.trim(),
    factorWeights: weights,
    entryRule,
    exitRule,
    positionSizing: {
      mode: sizing.mode as "portfolio" | "fixed_shares",
      sharesPerEntry: sizing.sharesPerEntry as number | null,
      frequency: sizing.frequency as QuantRebalance,
      amountPerEntry: null,
      weekday: null,
    },
  };
}

function formatSignalRuleForPreview(rule: QuantSignalRule): string {
  const labels: Record<QuantSignalRule["conditions"][number]["factor"], string> = {
    momentum20: "近20日報酬",
    momentum60: "近60日報酬",
    liquidity20: "近20日平均成交金額",
    volatility20: "近20日波動",
  };
  const conditions = rule.conditions.map((condition) => {
    const value = condition.factor === "liquidity20"
      ? `NT$ ${Math.round(condition.threshold).toLocaleString("zh-TW")}`
      : `${(condition.threshold * 100).toFixed(2)}%`;
    return `${labels[condition.factor]} ${condition.operator === "gte" ? "≥" : "≤"} ${value}`;
  });
  return conditions.join(rule.mode === "all" ? " 且 " : " 或 ");
}

function isUsableAiOutput(text: string | null): boolean {
  return parseAiStrategy(extractJsonObject(text)) !== null;
}

async function designQuantStrategy(
  hypothesis: string,
  tickerFilter: string | null,
  rebalance: QuantRebalance,
  onProgress?: QuantResearchProgressCallback,
): Promise<{ strategy: AiQuantStrategy; provider: AiProviderName }> {
  const result = await withAiProviderFallback({
    operation: "quant_strategy_design",
    instructions: [
      "你是台股量化研究助理。根據使用者假說，為核准的價量因子配置排名權重，並設計可直接執行的買入與賣出條件。",
      "entryRule 在訊號成立時允許新買進；exitRule 在訊號成立時賣出已持有標的。條件依 mode 用 all（全部成立）或 any（任一成立）判斷。",
      "positionSizing 必須依使用者假說解析買入數量：若明確指定每次固定買 N 股，mode=fixed_shares，sharesPerEntry=N；若明確指定每日／每週／每月買入，frequency 使用該頻率。若未明確指定固定股數，mode=portfolio 且 sharesPerEntry=null，frequency 使用訊號檢查頻率。fixed_shares 會在每次符合進場訊號的排程檢查時再買固定股數，持倉累積；出場訊號成立時賣出全部累積持倉。不得將持股檔數誤作股數。",
      "排名權重只使用 momentum20、momentum60、liquidity20、lowVolatility20。訊號條件只使用 momentum20、momentum60、liquidity20、volatility20。momentum20/60 是近 20/60 日報酬小數（0.05 代表 5%）；liquidity20 是近 20 日平均每日成交金額新台幣；volatility20 是 20 日日報酬標準差小數（0.02 代表 2%）。",
      "entryRule 中 momentum20、momentum60、liquidity20 只能用 gte，volatility20 只能用 lte；exitRule 中 momentum20、momentum60、liquidity20 只能用 lte，volatility20 只能用 gte。",
      "每條規則必須包含 1 至 3 個不重複條件。動能門檻須介於 -0.99 至 3；成交金額須介於 0 至 1,000,000,000,000；波動須介於 0 至 0.3。買入條件與賣出條件應互補且合理，避免兩者在相同數值下同時成立。",
      "所有因子權重介於 0 與 1，總和約等於 1。name 與 rationale 使用簡潔繁體中文。",
      "訊號只會在所選每週／每月檢查日使用前一個交易日收盤資料；不可依賴未來資料。",
      "不可產生或執行程式碼、編造回測績效或加入財報、新聞、籌碼及外部因子；不可使用外部行情、搜尋結果或模型記憶。",
      "請只回傳符合提供 JSON Schema 的物件。",
    ],
    input: JSON.stringify({
      hypothesis: hypothesis.slice(0, 600),
      tickerScope: tickerFilter ?? "全市場",
      signalCheckFrequency: rebalance,
      requestedSizing: "請從 hypothesis 擷取明確股數及頻率；沒有明確固定股數時維持 portfolio。",
      rankingFactors: [
        "momentum20",
        "momentum60",
        "liquidity20",
        "lowVolatility20",
      ],
      signalFactors: [
        "momentum20",
        "momentum60",
        "liquidity20",
        "volatility20",
      ],
    }),
    schema: AI_STRATEGY_JSON_SCHEMA,
    maxOutputTokens: 750,
    allowedProviders: QUANT_RESEARCH_AI_PROVIDER_ORDER,
    geminiModels: QUANT_RESEARCH_GEMINI_MODELS,
    groqModel: QUANT_RESEARCH_GROQ_MODEL,
    maxFallbackDurationMs: 48_000,
    geminiTimeoutMs: 24_000,
    geminiModelTimeoutMs: 12_000,
    oneMinAiTimeoutMs: 12_000,
    agnesAiTimeoutMs: 12_000,
    groqTimeoutMs: 12_000,
    ollamaTimeoutMs: 12_000,
    validateOutput: isUsableAiOutput,
    onProviderProgress: ({ message }) => {
      onProgress?.({ type: "progress", stage: "strategy", message });
    },
  });

  const parsed = parseAiStrategy(extractJsonObject(result.text));
  if (!parsed || !isUsableAiOutput(result.text)) {
    throw new QuantResearchError("AI 服務未回傳可用的策略規格。", 502);
  }

  return {
    provider: result.provider,
    strategy: {
      name: parsed.name,
      rationale: parsed.rationale,
      factorWeights: normalizeFactorWeights(parsed.factorWeights),
      entryRule: parsed.entryRule,
      exitRule: parsed.exitRule,
      positionSizing: parsed.positionSizing,
    },
  };
}

function addDays(date: string, dayCount: number): string {
  const cursor = new Date(`${date}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() + dayCount);
  return cursor.toISOString().slice(0, 10);
}

function subtractMonths(date: string, months: number): string {
  const cursor = new Date(`${date}T00:00:00.000Z`);
  const day = cursor.getUTCDate();
  cursor.setUTCDate(1);
  cursor.setUTCMonth(cursor.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cursor.setUTCDate(Math.min(day, lastDay));
  return cursor.toISOString().slice(0, 10);
}

function fingerprintSnapshots(snapshots: ParsedQuantMarketDay[]): string {
  const hash = createHash("sha256");
  const sorted = [...snapshots].sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.exchange.localeCompare(right.exchange),
  );
  for (const snapshot of sorted) {
    hash.update(`${snapshot.date}|${snapshot.exchange}|${snapshot.benchmarkClose ?? ""}\n`);
    for (const quote of [...snapshot.quotes].sort((left, right) =>
      left.ticker.localeCompare(right.ticker),
    )) {
      hash.update(
        `${quote.ticker}|${quote.open}|${quote.high}|${quote.low}|${quote.close}|${quote.volume}|${quote.turnover}\n`,
      );
    }
  }
  return hash.digest("hex");
}

function countRows(
  snapshots: ParsedQuantMarketDay[],
  startDate: string,
  exchange: "twse" | "tpex",
  tickerFilter: string | null,
): number {
  return snapshots
    .filter(
      (snapshot) =>
        snapshot.exchange === exchange && snapshot.date >= startDate,
    )
    .reduce(
      (total, snapshot) =>
        total +
        snapshot.quotes.filter(
          (quote) => !tickerFilter || quote.ticker === tickerFilter,
        ).length,
      0,
    );
}

export async function runQuantResearch(
  input: QuantResearchInput,
  onProgress?: QuantResearchProgressCallback,
  interpretation?: QuantResearchInterpretation,
): Promise<QuantResearchResultDraft> {
  let requestedTickerFilter: string | null;
  try {
    requestedTickerFilter = normalizeQuantTickerFilter(input.tickerFilter);
  } catch (error) {
    if (error instanceof QuantTickerFilterError) {
      throw new QuantResearchError(error.message, error.status, { cause: error });
    }
    throw error;
  }

  let ai: { strategy: AiQuantStrategy; provider: AiProviderName };
  const legacyRecurringPlan = interpretation
    ? null
    : parseRecurringContribution(input.hypothesis);
  const recurringPlan = interpretation?.mode === "recurring_cash"
    ? {
        amount: interpretation.amountPerEntry!,
        weekday: interpretation.weekday === "first_trading_day"
          ? "monday" as const
          : interpretation.weekday as QuantWeekday,
        totalContributionLimit: interpretation.totalContributionLimit,
      }
    : legacyRecurringPlan
      ? { ...legacyRecurringPlan, totalContributionLimit: null }
      : null;
  const legacyTickerMatch = legacyRecurringPlan
    ? input.hypothesis.match(/(?:買(?:入)?|購入|投資)[^\d]{0,5}(\d{4,6})(\.(?:TW|TWO))?/i)
    : null;
  const interpretedTicker = interpretation?.tickerFilter ??
    (legacyTickerMatch
      ? `${legacyTickerMatch[1]}${legacyTickerMatch[2] ?? ""}`
      : null);
  if (interpretedTicker) {
    try {
      requestedTickerFilter = normalizeQuantTickerFilter(interpretedTicker);
    } catch (error) {
      if (error instanceof QuantTickerFilterError) {
        throw new QuantResearchError(error.message, error.status, { cause: error });
      }
      throw error;
    }
  }
  if (recurringPlan && !requestedTickerFilter) {
    throw new QuantResearchError(
      "定期投入回測請先在「限定股票」欄位選擇單一股票或 ETF，例如 0050.TW。",
      400,
    );
  }
  try {
    onProgress?.({
      type: "progress",
      stage: "strategy",
      message: recurringPlan
        ? "正在解析定期投入金額、交易日與單一股票範圍。"
        : "正在請 AI 設計明確的買入／賣出條件與因子權重。",
    });
    const confirmedStrategy = interpretation
      ? parseAiStrategy(interpretation.strategy)
      : null;
    const confirmedProvider = interpretation?.aiProvider;
    if (
      interpretation &&
      (!confirmedStrategy ||
        !confirmedProvider ||
        !QUANT_RESEARCH_AI_PROVIDER_ORDER.some(
          (provider) => provider === confirmedProvider,
        ))
    ) {
        throw new QuantResearchError("已確認的 AI 策略條件格式無效，請重新判讀。", 400);
    }
    ai = confirmedStrategy && confirmedProvider
      ? {
          strategy: confirmedStrategy,
          provider: confirmedProvider as AiProviderName,
        }
      : await designQuantStrategy(
          input.hypothesis,
          requestedTickerFilter,
          requestedTickerFilter ? "daily" : input.rebalance,
          onProgress,
        );
  } catch (error) {
    if (error instanceof QuantResearchError) throw error;
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 502;
    throw new QuantResearchError(
      error instanceof Error
        ? error.message
        : "目前無法連線至 AI 服務。",
      status,
      { cause: error },
    );
  }

  const endDate = getLastCompletedTaiwanMarketDate();
  const requestedStartDate = subtractMonths(endDate, input.rangeMonths);
  const historyStartDate = addDays(requestedStartDate, -120);
  const sizing = ai.strategy.positionSizing;
  if (recurringPlan) {
    sizing.mode = "fixed_cash";
    sizing.sharesPerEntry = null;
    sizing.amountPerEntry = recurringPlan.amount;
    sizing.weekday = recurringPlan.weekday;
    sizing.frequency = "weekly";
    ai.strategy.name = "每週定期投入";
    ai.strategy.rationale = `每週投入 NT$${recurringPlan.amount.toLocaleString("en-US")}${recurringPlan.totalContributionLimit ? `，累計投入上限 NT$${recurringPlan.totalContributionLimit.toLocaleString("en-US")}` : ""}，按可買整股數下單並持有至回測結束，不依 AI 進出場訊號交易。`;
  }
  const plannedFrequency: QuantRebalance = sizing.mode === "fixed_shares" || sizing.mode === "fixed_cash"
    ? sizing.frequency
    : requestedTickerFilter
      ? "daily"
      : input.rebalance;
  sizing.frequency = plannedFrequency;
  onProgress?.({
    type: "progress",
    stage: "strategy",
    message: recurringPlan
      ? `定期投入規則：每週投入 NT$${recurringPlan.amount.toLocaleString("en-US")}${recurringPlan.totalContributionLimit ? `，累計投入上限 NT$${recurringPlan.totalContributionLimit.toLocaleString("en-US")}` : ""}；持有至回測結束，非交易日順延。`
      : `規則預覽：進場—${formatSignalRuleForPreview(ai.strategy.entryRule)}；出場—${formatSignalRuleForPreview(ai.strategy.exitRule)}；${sizing.mode === "fixed_shares" ? `每${sizing.frequency === "daily" ? "個交易日" : sizing.frequency === "weekly" ? "週" : "月"}檢查，進場條件成立時買進 ${sizing.sharesPerEntry} 股並累積；出場條件成立時賣出全部持股` : `訊號檢查頻率 ${sizing.frequency}，未指定固定股數，依可用資金配置持倉`}。`,
  });
  onProgress?.({
    type: "progress",
    stage: "market-data",
    message: "策略已就緒，開始檢查快取並取得 TWSE／TPEx 官方日行情。",
  });
  const marketRange = await getOfficialMarketRange(
    historyStartDate,
    endDate,
    onProgress,
  );
  let tickerFilter: string | null;
  try {
    tickerFilter = resolveQuantTickerFilter(
      requestedTickerFilter,
      marketRange.snapshots,
      requestedStartDate,
    );
  } catch (error) {
    if (error instanceof QuantTickerFilterError) {
      throw new QuantResearchError(error.message, error.status, { cause: error });
    }
    throw error;
  }
  let backtest: ReturnType<typeof calculateQuantBacktest>;
  let timingComparison: NonNullable<
    QuantResearchResultDraft["timingComparison"]
  > | undefined;
  let costStressBacktest: ReturnType<typeof calculateQuantBacktest>;
  let selectedStrategy = ai.strategy;
  const executionRebalance = plannedFrequency;
  const sharesPerEntry = sizing.mode === "fixed_shares"
    ? sizing.sharesPerEntry
    : null;
  const recurringContribution = recurringPlan
    ? {
        amount: recurringPlan.amount,
        weekday: recurringPlan.weekday,
        totalContributionLimit: recurringPlan.totalContributionLimit,
      }
    : undefined;
  try {
    onProgress?.({
      type: "progress",
      stage: "backtest",
      message: `官方日行情已完整取得 ${marketRange.cachedDays} 個快取日及 ${marketRange.fetchedDays} 個新日期，正在計算回測。`,
    });
    if (tickerFilter && !recurringContribution) {
      const stockDates = [...new Set(
        marketRange.snapshots
          .filter((snapshot) =>
            snapshot.date >= requestedStartDate &&
            snapshot.quotes.some((quote) => quote.ticker === tickerFilter),
          )
          .map((snapshot) => snapshot.date),
      )].sort();
      if (stockDates.length < 40) {
        throw new Error("單一股票至少需要 40 個交易日才能進行分段驗證；請延長回測期間。");
      }
      const splitIndex = Math.floor(stockDates.length * 0.6);
      const calibrationEndDate = stockDates[splitIndex - 1]!;
      const validationStartDate = stockDates[splitIndex]!;
      const originalThreshold =
        ai.strategy.entryRule.conditions.find(
          (condition) => condition.factor === "momentum20",
        )?.threshold ?? 0;
      const thresholds = [
        Math.max(-0.99, originalThreshold - 0.05),
        originalThreshold,
        Math.min(3, originalThreshold + 0.05),
      ];
      const candidates = thresholds.map((threshold, index) => {
        const preserved = ai.strategy.entryRule.conditions.filter(
          (condition) => condition.factor !== "momentum20",
        );
        return {
          name: ["較早進場", "AI 基準", "較嚴格進場"][index]!,
          entryRule: index === 1 ? ai.strategy.entryRule : {
            mode: ai.strategy.entryRule.mode,
            conditions: [
              { factor: "momentum20" as const, operator: "gte" as const, threshold },
              ...preserved.slice(0, 2),
            ].slice(0, 3),
          } satisfies QuantSignalRule,
        };
      });
      const calibration = candidates.map((candidate) => ({
        candidate,
        backtest: calculateQuantBacktest({
          snapshots: marketRange.snapshots,
          requestedStartDate,
          requestedEndDate: calibrationEndDate,
          startingCapital: input.startingCapital,
        topN: 1,
        rebalance: executionRebalance,
          factorWeights: ai.strategy.factorWeights,
          entryRule: candidate.entryRule,
          exitRule: ai.strategy.exitRule,
          tickerFilter,
          sharesPerEntry,
          recurringContribution,
        }),
      }));
      const ranked = calibration
        .filter(({ backtest: train }) =>
          train.metrics.closedTradeCount >= 3 &&
          train.metrics.winRatePercent !== null,
        )
        .sort((left, right) =>
          (right.backtest.metrics.winRatePercent ?? -1) -
            (left.backtest.metrics.winRatePercent ?? -1) ||
          right.backtest.metrics.closedTradeCount -
            left.backtest.metrics.closedTradeCount ||
          right.backtest.metrics.totalReturnPercent -
            left.backtest.metrics.totalReturnPercent,
        );
      const selected = ranked[0] ?? calibration[1]!;
      selectedStrategy = {
        ...ai.strategy,
        name: `${ai.strategy.name}｜${selected.candidate.name}`,
        entryRule: selected.candidate.entryRule,
      };
      backtest = calculateQuantBacktest({
        snapshots: marketRange.snapshots,
        requestedStartDate: validationStartDate,
        requestedEndDate: endDate,
        startingCapital: input.startingCapital,
        topN: 1,
         rebalance: executionRebalance,
        factorWeights: ai.strategy.factorWeights,
        entryRule: selected.candidate.entryRule,
        exitRule: ai.strategy.exitRule,
        tickerFilter,
        sharesPerEntry,
          recurringContribution,
      });
      costStressBacktest = calculateQuantBacktest({
        snapshots: marketRange.snapshots,
        requestedStartDate: validationStartDate,
        requestedEndDate: endDate,
        startingCapital: input.startingCapital,
        topN: 1,
        rebalance: executionRebalance,
        factorWeights: ai.strategy.factorWeights,
        entryRule: selected.candidate.entryRule,
        exitRule: ai.strategy.exitRule,
        tickerFilter,
        sharesPerEntry,
        costMultiplier: 2,
        recurringContribution,
      });
      timingComparison = {
        calibrationStartDate: stockDates[0]!,
        calibrationEndDate,
        validationStartDate,
        validationEndDate: stockDates.at(-1)!,
        selectedCandidate: selected.candidate.name,
        calibrationCandidates: calibration.map(({ candidate, backtest: train }) => ({
          name: candidate.name,
          closedTradeCount: train.metrics.closedTradeCount,
          winRatePercent: train.metrics.winRatePercent,
          totalReturnPercent: train.metrics.totalReturnPercent,
          selected: candidate.name === selected.candidate.name,
        })),
        validation: {
          closedTradeCount: backtest.metrics.closedTradeCount,
          winRatePercent: backtest.metrics.winRatePercent,
          totalReturnPercent: backtest.metrics.totalReturnPercent,
          maxDrawdownPercent: backtest.metrics.maxDrawdownPercent,
        },
      };
    } else {
      backtest = calculateQuantBacktest({
        snapshots: marketRange.snapshots,
        requestedStartDate,
        startingCapital: input.startingCapital,
        topN: tickerFilter ? 1 : input.topN,
        rebalance: executionRebalance,
        factorWeights: ai.strategy.factorWeights,
        entryRule: ai.strategy.entryRule,
        exitRule: ai.strategy.exitRule,
        tickerFilter,
        sharesPerEntry,
        recurringContribution,
      });
      costStressBacktest = calculateQuantBacktest({
        snapshots: marketRange.snapshots,
        requestedStartDate,
        startingCapital: input.startingCapital,
        topN: tickerFilter ? 1 : input.topN,
        rebalance: executionRebalance,
        factorWeights: ai.strategy.factorWeights,
        entryRule: ai.strategy.entryRule,
        exitRule: ai.strategy.exitRule,
        tickerFilter,
        sharesPerEntry,
        recurringContribution,
        costMultiplier: 2,
      });
    }
  } catch (error) {
    throw new QuantResearchError(
      error instanceof Error ? error.message : "回測計算失敗。",
      422,
      { cause: error },
    );
  }

  const result: QuantResearchResultDraft = {
    hypothesis: input.hypothesis,
    tickerFilter,
    rangeMonths: input.rangeMonths,
    startingCapital: input.startingCapital,
    topN: tickerFilter ? 1 : input.topN,
    rebalance: executionRebalance,
    strategy: selectedStrategy,
    ...(timingComparison ? { timingComparison } : {}),
    costStress: {
      slippagePercentPerSide: 0.1,
      costMultiplier: 2,
      totalReturnPercent: costStressBacktest.metrics.totalReturnPercent,
      maxDrawdownPercent: costStressBacktest.metrics.maxDrawdownPercent,
      closedTradeCount: costStressBacktest.metrics.closedTradeCount,
      winRatePercent: costStressBacktest.metrics.winRatePercent,
      averageWinPercent: costStressBacktest.metrics.averageWinPercent,
      averageLossPercent: costStressBacktest.metrics.averageLossPercent,
      payoffRatio: costStressBacktest.metrics.payoffRatio,
    },
    metrics: backtest.metrics,
    equityCurve: backtest.equityCurve,
    trades: backtest.trades,
    tradeLogTruncated: backtest.tradeLogTruncated,
    aiSummary: null,
    coverage: {
      requestedStartDate,
      dataStartDate: backtest.dataStartDate,
      dataEndDate: backtest.dataEndDate,
      tradingDays: backtest.tradingDays,
      eligibleSecurities: backtest.eligibleSecurities,
      twseRows: countRows(
        marketRange.snapshots,
        requestedStartDate,
        "twse",
        tickerFilter,
      ),
      tpexRows: countRows(
        marketRange.snapshots,
        requestedStartDate,
        "tpex",
        tickerFilter,
      ),
      fetchedDays: marketRange.fetchedDays,
      cachedDays: marketRange.cachedDays,
      dataFingerprint: fingerprintSnapshots(marketRange.snapshots),
      source: tickerFilter
        ? `TWSE MI_INDEX 與 TPEx dailyQuotes 官方日行情；本次回測只使用 ${tickerFilter}`
        : "TWSE MI_INDEX 與 TPEx dailyQuotes 官方日行情；價量資料，包含當日有交易的上市櫃股票與 ETF",
    },
    aiProvider: ai.provider as QuantResearchResultDraft["aiProvider"],
    createdAt: new Date().toISOString(),
    disclaimer: recurringPlan
      ? `僅供研究，不代表未來績效。每週${recurringPlan.weekday === "wednesday" ? "三" : recurringPlan.weekday}投入 NT$${recurringPlan.amount.toLocaleString("en-US")}；若指定日休市，順延至本週下一個交易日。按指定交易日開盤價模擬整股買進，計入估計滑價與手續費，持有至期末；不套用 AI 進出場訊號，不會送出真實委託。`
      : tickerFilter
      ? `僅供研究，不代表未來績效。回測只交易 ${tickerFilter}；系統以 AI 基準規則產生 20 日動能門檻相差 5 個百分點的兩個候選，前 60% 交易日依已完成交易勝率挑選，後 40% 僅供驗證。逐日以前一交易日收盤判斷，次一交易日開盤模擬成交；基準成交價每邊加 0.1% 滑價，含估計手續費與證交稅，並另測成本加倍情境；不會送出真實委託。`
      : "僅供研究，不代表未來績效。AI 依假說提出固定進出場門檻，未依本次歷史績效最佳化；每週／每月用前一交易日收盤資料判斷，並以次一交易日開盤模擬成交。基準成交價每邊加 0.1% 滑價，含估計手續費與證交稅，並另測成本加倍情境；不會送出真實委託。",
  };

  onProgress?.({
    type: "progress",
    stage: "summary",
    message: "回測已完成，正在整理容易閱讀的 AI 摘要。",
  });
  result.aiSummary = await generateQuantResearchSummary(result, onProgress);
  return result;
}
