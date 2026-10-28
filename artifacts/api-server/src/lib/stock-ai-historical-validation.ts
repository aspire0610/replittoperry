import { db } from "@workspace/db";
import { stockAiHistoricalValidationSamplesTable as samples } from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { evaluateStockAiPricePlan } from "./stock-ai-price-plan-validation-utils.js";
import {
  evaluateStockAiBuySignalQualification,
} from "./stock-ai-buy-signal-qualification.js";
import {
  calculateProbabilityCalibration,
  eligibleStockAiForecastIndexes,
  STOCK_AI_HISTORICAL_VALIDATION_FORECAST_LIMIT,
  predictDirectionByCloseMomentum,
} from "./stock-ai-historical-validation-utils.js";
import { withAiProviderFallback } from "./ai-provider-fallback.js";

const PROMPT_VERSION = "ohlcv-blind-probability-v2";
const QUALIFICATION_PROMPT_VERSIONS = [PROMPT_VERSION, "ohlcv-blind-v1"];
const BATCH_SIZE = 5;
const LOOKBACK_BARS = 40;
const FORECAST_HORIZON = 5;

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["direction", "directionProbabilityPercent", "action", "entryPrice", "stopLossPrice", "takeProfitPrice"],
  properties: {
    direction: { type: "string", enum: ["bullish", "bearish", "neutral", "insufficient"] },
    directionProbabilityPercent: { type: ["integer", "null"], minimum: 50, maximum: 95 },
    action: { type: "string", enum: ["buy", "hold", "sell", "wait", "insufficient"] },
    entryPrice: { type: ["number", "null"] },
    stopLossPrice: { type: ["number", "null"] },
    takeProfitPrice: { type: ["number", "null"] },
  },
} as const;

type HistoricalBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

type HistoricalForecast = {
  direction: "bullish" | "bearish" | "neutral" | "insufficient";
  directionProbabilityPercent: number | null;
  action: "buy" | "hold" | "sell" | "wait" | "insufficient";
  entryPrice: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
};

export type StockAiHistoricalValidationProgress = {
  symbol: string;
  status: "collecting" | "qualified" | "not_qualified" | "insufficient_history";
  processedForecastCount: number;
  requiredForecastCount: number;
  directionSampleCount: number;
  directionCorrectCount: number;
  programBaselineSampleCount: number;
  programBaselineCorrectCount: number;
  programBaselineHitRatePercent: number | null;
  calibrationSampleCount: number;
  meanForecastProbabilityPercent: number | null;
  calibrationGapPercent: number | null;
  directionLowerBoundPercent: number | null;
  pricePlanSampleCount: number;
  pricePlanTargetFirstCount: number;
  pricePlanLowerBoundPercent: number | null;
  qualified: boolean;
  message: string;
};

export type StockAiHistoricalValidationBatchEvent = {
  type: "progress";
  phase: "forecast_started" | "forecast_completed";
  forecastDate: string;
  forecastIndex: number;
  requiredForecastCount: number;
  provider: string | null;
  progress: StockAiHistoricalValidationProgress;
};

export async function getStockAiHistoricalValidationQualification(symbol: string) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const qualifications = await getStockAiHistoricalValidationQualifications([normalizedSymbol]);
  return qualifications.get(normalizedSymbol)!;
}

export async function getStockAiHistoricalValidationQualifications(symbols: string[]) {
  const normalizedSymbols = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  if (!normalizedSymbols.length) return new Map();
  const rows = await db
    .select()
    .from(samples)
    .where(
      and(
        inArray(samples.symbol, normalizedSymbols),
        inArray(samples.promptVersion, QUALIFICATION_PROMPT_VERSIONS),
      ),
    );
  const rowsBySymbol = new Map<string, Map<string, (typeof rows)[number]>>();
  for (const row of rows) {
    const symbolRows = rowsBySymbol.get(row.symbol) ?? new Map();
    const existing = symbolRows.get(row.forecastDate);
    if (!existing || row.promptVersion === PROMPT_VERSION) {
      symbolRows.set(row.forecastDate, row);
    }
    rowsBySymbol.set(row.symbol, symbolRows);
  }
  return new Map(normalizedSymbols.map((normalizedSymbol) => {
    const symbolRows = [...(rowsBySymbol.get(normalizedSymbol)?.values() ?? [])];
    const directionalRows = symbolRows.filter(
      (row) => row.forecastDirection === "bullish" || row.forecastDirection === "bearish",
    );
    const planRows = symbolRows.filter(
      (row) => row.pricePlanOutcome === "target_first" || row.pricePlanOutcome === "stop_first",
    );
    const directionSuccesses = directionalRows.filter((row) => row.directionCorrect).length;
    const pricePlanSuccesses = planRows.filter(
      (row) => row.pricePlanOutcome === "target_first",
    ).length;
    const qualification = evaluateStockAiBuySignalQualification({
      directionSuccesses,
      directionSampleCount: directionalRows.length,
      pricePlanSuccesses,
      pricePlanSampleCount: planRows.length,
    });
    return [normalizedSymbol, {
      ...qualification,
      directionSampleCount: directionalRows.length,
      directionSuccessCount: directionSuccesses,
      pricePlanSampleCount: planRows.length,
      pricePlanSuccessCount: pricePlanSuccesses,
    }];
  }));
}

function parseForecast(text: string): HistoricalForecast {
  const value = JSON.parse(text) as Record<string, unknown>;
  const directions = ["bullish", "bearish", "neutral", "insufficient"];
  const actions = ["buy", "hold", "sell", "wait", "insufficient"];
  const numberOrNull = (candidate: unknown) =>
    candidate === null
      ? null
      : typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
        ? candidate
        : null;
  if (
    !directions.includes(String(value.direction)) ||
    !actions.includes(String(value.action))
  ) {
    throw new Error("歷史 AI 判讀缺少有效方向或動作。");
  }
  const forecast: HistoricalForecast = {
    direction: value.direction as HistoricalForecast["direction"],
    directionProbabilityPercent:
      typeof value.directionProbabilityPercent === "number" &&
      Number.isInteger(value.directionProbabilityPercent) &&
      value.directionProbabilityPercent >= 50 &&
      value.directionProbabilityPercent <= 95
        ? value.directionProbabilityPercent
        : null,
    action: value.action as HistoricalForecast["action"],
    entryPrice: numberOrNull(value.entryPrice),
    stopLossPrice: numberOrNull(value.stopLossPrice),
    takeProfitPrice: numberOrNull(value.takeProfitPrice),
  };
  if (
    ((forecast.direction === "bullish" || forecast.direction === "bearish") &&
      forecast.directionProbabilityPercent === null) ||
    ((forecast.direction === "neutral" || forecast.direction === "insufficient") &&
      forecast.directionProbabilityPercent !== null)
  ) {
    throw new Error("歷史 AI 方向與機率估計不一致。");
  }
  if (
    forecast.action === "buy" &&
    (forecast.direction !== "bullish" ||
      forecast.entryPrice === null ||
      forecast.stopLossPrice === null ||
      forecast.takeProfitPrice === null ||
      !(forecast.stopLossPrice < forecast.entryPrice &&
        forecast.entryPrice < forecast.takeProfitPrice))
  ) {
    forecast.action = "wait";
    forecast.entryPrice = null;
    forecast.stopLossPrice = null;
    forecast.takeProfitPrice = null;
  }
  return forecast;
}

async function askAiForHistoricalForecast(
  forecastDate: string,
  bars: HistoricalBar[],
  signal?: AbortSignal,
): Promise<{ forecast: HistoricalForecast; aiProvider: string | null }> {
  const reference = bars.at(-1);
  if (!reference) throw new Error("缺少歷史參考日線。");
  const input = {
    asOfDate: forecastDate,
    referenceClose: reference.close,
    dailyBars: bars.map((bar) => ({
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    })),
  };
  const result = await withAiProviderFallback({
    operation: "stock_assessment",
    allowedProviders: ["groq", "gemini", "openrouter"],
    instructions: [
      "你是台灣股票歷史盲測分析員。只可根據輸入的截至 asOfDate 的官方日線資料，判斷接下來 5 個交易日的方向與操作。",
      "這是逐日隔離的歷史回測；輸入已排除預測日之後的資料。不得使用外部搜尋、公司名稱知識、現況或你記得的歷史結果，不得推測新聞或基本面。",
      "只回傳符合 JSON Schema 的 JSON。direction 必須是 bullish、bearish、neutral、insufficient 之一；directionProbabilityPercent 是你對「所選方向在未來 5 個交易日判對」的機率估計，取整數 50–95；方向為 insufficient 時回傳 null。這是盲測預測值，不能迎合校準門檻。",
      "action 必須是 buy、hold、sell、wait、insufficient 之一。",
      "只有 direction 為 bullish 且有明確技術依據時才可 action=buy，並提供 stopLossPrice < entryPrice < takeProfitPrice；其他動作的價位都回傳 null。不要為了提高命中率迎合門檻。",
    ].join(" "),
    input: JSON.stringify(input),
    schema: responseSchema,
    maxOutputTokens: 350,
    timeoutMs: 5_000,
    groqTimeoutMs: 4_000,
    geminiTimeoutMs: 6_000,
    maxFallbackDurationMs: 8_000,
    openRouterTimeoutMs: 5_000,
    signal,
    validateOutput: (text) => {
      if (!text) return false;
      try {
        parseForecast(text);
        return true;
      } catch {
        return false;
      }
    },
  });
  if (!result.text) throw new Error("AI 沒有回傳歷史判讀。");
  return { forecast: parseForecast(result.text), aiProvider: result.provider };
}

function eligibleForecastIndexes(bars: HistoricalBar[]): number[] {
  return eligibleStockAiForecastIndexes(bars.length, {
    lookbackBars: LOOKBACK_BARS,
    forecastHorizon: FORECAST_HORIZON,
    step: FORECAST_HORIZON,
    limit: STOCK_AI_HISTORICAL_VALIDATION_FORECAST_LIMIT,
  });
}

function directionOfReturn(reference: number, actual: number) {
  return actual > reference ? "bullish" : actual < reference ? "bearish" : "neutral";
}

export async function getStockAiHistoricalValidationProgress(
  symbol: string,
  bars: HistoricalBar[],
): Promise<StockAiHistoricalValidationProgress> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const indexes = eligibleForecastIndexes(bars);
  const availableDates = indexes.map((index) => bars[index]!.date);
  const rows = availableDates.length
    ? await db
        .select()
        .from(samples)
        .where(
          and(
            eq(samples.symbol, normalizedSymbol),
            eq(samples.promptVersion, PROMPT_VERSION),
            inArray(samples.forecastDate, availableDates),
          ),
        )
    : [];
  const directionalRows = rows.filter(
    (row) => row.forecastDirection === "bullish" || row.forecastDirection === "bearish",
  );
  const closes = bars.map((bar) => bar.close);
  const forecastIndexByDate = new Map(indexes.map((index) => [bars[index]!.date, index]));
  const programBaselineResults = directionalRows.flatMap((row) => {
    const index = forecastIndexByDate.get(row.forecastDate);
    const forecastDirection = index === undefined
      ? null
      : predictDirectionByCloseMomentum(closes, index);
    return forecastDirection === null
      ? []
      : [{ forecastDirection, actualDirection: row.actualDirection }];
  });
  const programBaselineCorrectCount = programBaselineResults.filter(
    (row) => row.forecastDirection === row.actualDirection,
  ).length;
  const planRows = rows.filter(
    (row) => row.pricePlanOutcome === "target_first" || row.pricePlanOutcome === "stop_first",
  );
  const correctCount = directionalRows.filter((row) => row.directionCorrect).length;
  const probabilityRows = directionalRows.filter((row) => row.forecastProbabilityPercent !== null);
  const calibration = calculateProbabilityCalibration(probabilityRows.map((row) => ({
    forecastProbabilityPercent: Number(row.forecastProbabilityPercent),
    directionCorrect: row.directionCorrect,
  })));
  const targetFirstCount = planRows.filter((row) => row.pricePlanOutcome === "target_first").length;
  const qualification = evaluateStockAiBuySignalQualification({
    directionSuccesses: correctCount,
    directionSampleCount: directionalRows.length,
    pricePlanSuccesses: targetFirstCount,
    pricePlanSampleCount: planRows.length,
  });
  const complete = rows.length >= indexes.length;
  return {
    symbol: normalizedSymbol,
    status: indexes.length === 0
        ? "insufficient_history"
        : !complete
          ? "collecting"
          : qualification.qualified
            ? "qualified"
            : "not_qualified",
    processedForecastCount: rows.length,
    requiredForecastCount: indexes.length,
    directionSampleCount: directionalRows.length,
    directionCorrectCount: correctCount,
    programBaselineSampleCount: programBaselineResults.length,
    programBaselineCorrectCount,
    programBaselineHitRatePercent: programBaselineResults.length
      ? (programBaselineCorrectCount / programBaselineResults.length) * 100
      : null,
    calibrationSampleCount: calibration.sampleCount,
    meanForecastProbabilityPercent: calibration.meanForecastProbabilityPercent,
    calibrationGapPercent: calibration.gapPercent,
    directionLowerBoundPercent: qualification.directionLowerBoundPercent,
    pricePlanSampleCount: planRows.length,
    pricePlanTargetFirstCount: targetFirstCount,
    pricePlanLowerBoundPercent: qualification.pricePlanLowerBoundPercent,
    qualified: qualification.qualified,
    message: complete && qualification.qualified
      ? "歷史 AI 盲測已通過 80% 門檻；這不保證未來結果。"
      : indexes.length === 0
        ? "官方歷史資料不足，無法建立不重疊的 5 日樣本。"
        : complete
          ? "近期歷史回測已完成；歷史表現不保證未來結果。"
          : "近期歷史回測進行中。",
  };
}

export async function runStockAiHistoricalValidationBatch(
  symbol: string,
  bars: HistoricalBar[],
  options: {
    signal?: AbortSignal;
    onProgress?: (event: StockAiHistoricalValidationBatchEvent) => void;
  } = {},
): Promise<StockAiHistoricalValidationProgress> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const indexes = eligibleForecastIndexes(bars);
  if (indexes.length === 0) {
    return getStockAiHistoricalValidationProgress(normalizedSymbol, bars);
  }
  const dates = indexes.map((index) => bars[index]!.date);
  const existing = await db
    .select({ forecastDate: samples.forecastDate })
    .from(samples)
    .where(
      and(
        eq(samples.symbol, normalizedSymbol),
        eq(samples.promptVersion, PROMPT_VERSION),
        inArray(samples.forecastDate, dates),
      ),
    );
  const existingDates = new Set(existing.map((row) => row.forecastDate));
  const missingIndexes = indexes
    .filter((index) => !existingDates.has(bars[index]!.date))
    .slice(0, BATCH_SIZE);
  const dailyBars = bars.map(({ date, high, low }) => ({ date, high, low }));

  for (const index of missingIndexes) {
    if (options.signal?.aborted) break;
    const forecastDate = bars[index]!.date;
    const window = bars.slice(index - LOOKBACK_BARS + 1, index + 1);
    const forecastIndex = indexes.indexOf(index) + 1;
    options.onProgress?.({
      type: "progress",
      phase: "forecast_started",
      forecastDate,
      forecastIndex,
      requiredForecastCount: indexes.length,
      provider: null,
      progress: await getStockAiHistoricalValidationProgress(normalizedSymbol, bars),
    });
    const { forecast, aiProvider } = await askAiForHistoricalForecast(
      forecastDate,
      window,
      options.signal,
    );
    const actualBar = bars[index + FORECAST_HORIZON]!;
    const actualDirection = directionOfReturn(bars[index]!.close, actualBar.close);
    const planOutcome =
      forecast.action === "buy" &&
      forecast.entryPrice !== null &&
      forecast.stopLossPrice !== null &&
      forecast.takeProfitPrice !== null
        ? evaluateStockAiPricePlan(
            {
              forecastDate,
              horizonDays: FORECAST_HORIZON,
              entryPrice: forecast.entryPrice,
              stopLossPrice: forecast.stopLossPrice,
              takeProfitPrice: forecast.takeProfitPrice,
            },
            dailyBars,
          )?.status ?? null
        : null;
    await db
      .insert(samples)
      .values({
        symbol: normalizedSymbol,
        promptVersion: PROMPT_VERSION,
        forecastDate,
        referencePrice: bars[index]!.close.toFixed(6),
        forecastDirection: forecast.direction,
        forecastProbabilityPercent: forecast.directionProbabilityPercent?.toFixed(2) ?? null,
        action: forecast.action,
        aiProvider,
        entryPrice: forecast.entryPrice?.toFixed(6) ?? null,
        stopLossPrice: forecast.stopLossPrice?.toFixed(6) ?? null,
        takeProfitPrice: forecast.takeProfitPrice?.toFixed(6) ?? null,
        actualClose: actualBar.close.toFixed(6),
        actualDirection,
        directionCorrect:
          (forecast.direction === "bullish" || forecast.direction === "bearish") &&
          forecast.direction === actualDirection,
        pricePlanOutcome: planOutcome,
      })
      .onConflictDoNothing({
        target: [samples.symbol, samples.promptVersion, samples.forecastDate],
      });
    const progress = await getStockAiHistoricalValidationProgress(normalizedSymbol, bars);
    options.onProgress?.({
      type: "progress",
      phase: "forecast_completed",
      forecastDate,
      forecastIndex,
      requiredForecastCount: indexes.length,
      provider: aiProvider,
      progress,
    });
  }

  return getStockAiHistoricalValidationProgress(normalizedSymbol, bars);
}
