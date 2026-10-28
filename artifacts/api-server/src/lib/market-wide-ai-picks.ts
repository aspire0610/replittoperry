import type { StockAiPicks } from "@workspace/api-zod";
import { logger } from "./logger.js";
import {
  getStockHistory,
  getMarketWideRecentStockHistory,
  getMarketWideStockQuotes,
  getOfficialMarketScanSnapshot,
  getTaiexQuote,
  getTaiexSummary,
  type OfficialDailyClose,
  type StockQuoteData,
  isTaiwanStockSessionOpen,
} from "./market-data.js";
import { isTaiwanMarketClosed } from "./twse-holiday-calendar.js";
import {
  withAiProviderFallback,
  type AiProviderName,
} from "./ai-provider-fallback.js";
import {
  calculateLocalPricePlanBacktest,
  calculateWilsonInterval,
  calculateBullishMomentumWinRate,
  filterPicksWithProbabilityEstimate,
  validateMarketPickSelection,
  chunkArray,
  dedupeMarketDailyQuotes,
  isSystemicRiskDay,
  isDayTradeLiquidityEligible,
  DAY_TRADE_EXCLUDED_SYMBOLS,
  getTaiwanDayTradeScanMode,
  calculateCdpLevels,
  classifyMarketPickWatchlistFailure,
} from "./market-wide-ai-picks-utils.js";
import { MARKET_WIDE_AI_PICK_MINIMUM_SAMPLE_COUNT } from "./market-wide-ai-pick-validation-utils.js";
import {
  resolveStockAiQuote,
} from "./stock-ai-quote-policy.js";
import { toTaiwanTradingDate } from "./stock-ai-direction-validation-utils.js";
import { getLineWebSearchProvider, searchLineWeb } from "./line-web-search.js";
import { getStockInstitutionalData } from "./stock-research-data.js";
import {
  getMarketWideAiPickScanJob,
  getLatestCompletedMarketWideAiPickScanJobBefore,
  startMarketWideAiPickScanJob,
} from "./market-wide-ai-pick-scan-jobs.js";
import {
  buildStockMarkdownReport,
  buildStockScorecard,
  buildStockScanTags,
  buildStockTradeScenarios,
} from "./stock-scorecard.js";
import { recordAndEvaluateMarketWideAiPickForecasts } from "./market-wide-ai-pick-validation.js";
import {
  calculateDailyPendingBacktest,
  countDailyPendingHistoryBars,
  buildSmcPendingPlan,
  passesSmcPendingSignal,
  getSmcPendingSignalFailureReasons,
  qualifiesDailyPendingBacktest,
  type SmcPendingPlan,
  type PendingBar,
} from "./daily-pending-strategy.js";

type AiPick = StockAiPicks["picks"][number];
type ScanResult = Omit<StockAiPicks, "aiProvider"> & { aiProvider: AiProviderName };
type CandidateQuote = OfficialDailyClose & {
  referencePrice: number;
  referenceChange: number | null;
  referenceChangePercent: number | null;
  referenceType: "verified_trade" | "official_daily_close";
  referenceAsOf: Date | null;
  referenceSource: string;
  scanDate: string;
  scanBars: PendingBar[];
  liveBar: PendingBar | null;
  historySource: string;
};

const MAX_FINAL_SELECTION_CANDIDATES = 25;
const MIN_STRATEGY_SAMPLES = 5;
// A cold one-year TWSE index history fetch takes over 13 seconds in this runtime.
const MARKET_SUMMARY_TIMEOUT_MS = 18_000;
const inFlightScans = new Map<string, Promise<ScanResult>>();
const marketWideBacktestHistoryCache = new Map<string, {
  asOf: string;
  source: string;
  bars: PendingBar[];
}>();
export type MarketWideAiPicksProgress = {
  stage: "idle" | "market_data" | "preliminary" | "final_selection" | "candidate_analysis" | "complete" | "error";
  percent: number;
  completedBatches: number;
  failedBatches: number;
  totalBatches: number;
  scannedCount: number;
  candidateCount: number;
  completedCandidates: number;
};
let scanProgress: MarketWideAiPicksProgress = {
  stage: "idle",
  percent: 0,
  completedBatches: 0,
  failedBatches: 0,
  totalBatches: 0,
  scannedCount: 0,
  candidateCount: 0,
  completedCandidates: 0,
};

export function getMarketWideAiPicksProgress(): MarketWideAiPicksProgress {
  return { ...scanProgress };
}

async function searchMarketPickNews(
  candidates: Array<Pick<OfficialDailyClose, "symbol" | "name">>,
): Promise<{
  provider: string;
  status: "searched" | "empty" | "unavailable";
  candidateResearch: Array<{
    symbol: string;
    name: string;
    status: "searched" | "empty" | "unavailable";
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
}> {
  const candidateResearch = await mapWithConcurrency(candidates, 5, async (candidate) => {
    try {
      const results = await withTimeout(
        searchLineWeb(`${candidate.symbol} ${candidate.name} 台股 最新新聞 財報 法說會 訴訟`),
        2_500,
      );
      return {
        symbol: candidate.symbol,
        name: candidate.name,
        status: results.length ? "searched" as const : "empty" as const,
        results: results.slice(0, 3).map(({ title, url, snippet }) => ({
          title: title.slice(0, 180),
          url: url.slice(0, 1_000),
          snippet: snippet.slice(0, 400),
        })),
      };
    } catch {
      return { symbol: candidate.symbol, name: candidate.name, status: "unavailable" as const, results: [] };
    }
  });
  const providers = new Set(candidateResearch
    .filter((candidate) => candidate.status !== "unavailable")
    .map(() => getLineWebSearchProvider()));
  return {
    provider: providers.size ? [...providers].join(" / ") : "unavailable",
    status: candidateResearch.some((candidate) => candidate.status === "searched")
      ? "searched"
      : candidateResearch.some((candidate) => candidate.status === "unavailable")
        ? "unavailable"
        : "empty",
    candidateResearch,
  };
}

const SCAN_INSTRUCTIONS = [
  "你是台灣股票短線當沖觀察助手。候選已依短線參考原則預篩：低於 100 元至少 1 萬張日成交量、100 元以上至少 5 千張；排除 ETF 與文章舉例的大型權值股；盤中只使用 10:00–12:30 的新鮮即時行情，盤後結果只供下一交易日重新確認。Tier1 另有最近 5 個交易日內看多 BOS/CHoCH 或 sell-side sweep，或看多 OB/未回補 bullish FVG 支撐區訊號，以及 24 個月日線策略回測；該回測不是當沖績效。候選另附前一交易日計算的 CDP、AH、NH、NL、AL 與開盤／現價所在區間。參考原理為順勢突破 AH/NH 偏多、跌破 NL/AL 偏空；逆勢向上穿越 AL 偏多、向下穿越 AH 偏空。但本系統只有區間位置，沒有完整盤中穿越順序，且僅回傳看多候選；不可宣稱突破／反轉已發生，不可由價位區間單獨生成進場訊號。不可重算或補造數字。Fallback 仍須有 R/R 至少 2 的條件計畫，且不得描述成通過 Tier1。",
  "大盤風險開關若為啟動，必須回傳空陣列。否則先選 Tier1，再按輸入的量化分數選 fallback 補足；有安全且可核實的候選時，盡量輸出 3 至 5 檔，最多 5 檔。",
  "理由需用中文摘要可核實的最新個股消息並交代風險審查；若發現重大營運利空、法說會風險、財報衰退或訴訟風險，必須排除該股。消息不足或來源無法支持時，不得假稱沒有風險或有利多。",
  "保留程式提供的實際歷史勝率與進出價，不可把 AI 方向估計說成歷史勝率或保證。",
  "只回傳 0 至 5 個不同代號、方向、五日方向估計、entryScenario（固定為 direct）與簡短理由；五日方向估計只供一般方向驗證，不可稱為當沖勝率或當沖保證。若全部候選均有重大風險，回傳空陣列。",
].join(" ");

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    picks: {
      type: "array",
      minItems: 0,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          symbol: { type: "string", minLength: 4, maxLength: 6 },
          direction: { type: "string", enum: ["bullish"] },
          directionProbabilityPercent: { type: "integer", minimum: 0, maximum: 95 },
          entryScenario: { type: "string", enum: ["direct"] },
          reason: { type: "string", minLength: 1, maxLength: 240 },
        },
        required: ["symbol", "direction", "directionProbabilityPercent", "entryScenario", "reason"],
      },
    },
  },
  required: ["picks"],
};

function isEligibleStockAsset(quote: OfficialDailyClose): boolean {
  const excludedAssetName = /(權證|認購|認售|牛證|熊證|ETN|債券|債|反向|槓桿|期貨|原油|黃金|白銀|貨幣|外匯)/iu;
  return (
    !excludedAssetName.test(quote.name) &&
    quote.volume !== null &&
    quote.tradedValue !== null &&
    quote.volume > 0 &&
    quote.tradedValue > 0
  );
}

function passesFastStaticFilters(quote: OfficialDailyClose): boolean {
  const previousClose = quote.change === null ? null : quote.close - quote.change;
  if (
    quote.volume === null ||
    quote.tradedValue === null ||
    !isDayTradeLiquidityEligible(quote.close, quote.volume) ||
    quote.tradedValue < 30_000_000 ||
    quote.close < 15 ||
    previousClose === null ||
    previousClose <= 0
  ) return false;
  const changePercent = (quote.change! / previousClose) * 100;
  return changePercent >= 1.5 && changePercent <= 9;
}

function passesInSessionFastFilters(live: StockQuoteData): boolean {
  const price = live.price;
  const volume = live.volume;
  const previousClose = live.previousClose;
  if (
    price === null || volume == null || previousClose === null ||
    price < 15 || volume < 1_000_000 || price * volume < 30_000_000 ||
    previousClose <= 0
  ) return false;
  const changePercent = ((price - previousClose) / previousClose) * 100;
  return changePercent >= 1.5 && changePercent <= 9;
}

function pendingOperationPlan(
  plan: SmcPendingPlan,
  referencePrice: number,
) {
  return {
    action: referencePrice > plan.entryPrice
      ? "wait_for_pullback" as const
      : "conditional_entry" as const,
    entryPrice: plan.entryPrice,
    targetPrice: plan.targetPrice,
    stopPrice: plan.stopPrice,
    rewardToRisk: Number.isFinite(plan.rewardToRisk) ? plan.rewardToRisk : null,
  };
}

function screeningReport(
  quote: CandidateQuote,
  probability: number,
  reason: string,
  scorecard: ReturnType<typeof buildStockScorecard>,
  scenarios: ReturnType<typeof buildStockTradeScenarios>,
  tags: string[],
  ruleResult: ReturnType<typeof calculateBullishMomentumWinRate>,
  pricePlanBacktest: ReturnType<typeof calculateLocalPricePlanBacktest>,
): string {
  const report = buildStockMarkdownReport({
    symbol: quote.symbol,
    ticker: `${quote.symbol}.${quote.exchange === "twse" ? "TW" : "TWO"}`,
    name: quote.name,
    currentPrice: quote.referencePrice,
    changePercent: quote.referenceChangePercent,
    biasLevel: probability >= 65 ? "bullish" : "neutral",
    summary: reason,
    actionText: "研究候選，請先核對條件與個人風險；非下單指令。",
    template: "automated_quant",
    decisionSignal: `🟡 AI 最終選擇；歷史勝率由程式依指定規則回測`,
    scanTags: tags,
    riskNote: "歷史勝率是過去樣本統計，不代表未來獲利或保證；操作價位僅供參考，不會自動下單。",
    positionSizingNote: "未提供單筆風險預算，不估算資金或股數。",
    scorecard,
    scenarios,
  });
  const pricePlanInterval = calculateWilsonInterval(
    pricePlanBacktest.targetFirstCount,
    pricePlanBacktest.resolvedCount,
  );
  const pricePlanResult = pricePlanBacktest.resolvedCount < 10
    ? `樣本不足，不宣稱可靠勝率（目標先觸及 ${pricePlanBacktest.targetFirstCount}/${pricePlanBacktest.resolvedCount} 個已進場區間；有效情境 ${pricePlanBacktest.windowCount} 個；未進場 ${pricePlanBacktest.noEntryCount}、到期及模糊結果均按未命中計）`
    : `${pricePlanBacktest.winRatePercent?.toFixed(1)}% 目標先觸及率（${pricePlanBacktest.targetFirstCount}/${pricePlanBacktest.resolvedCount} 個已進場區間；95% 區間 ${pricePlanInterval.lowerBoundPercent?.toFixed(1)}%–${pricePlanInterval.upperBoundPercent?.toFixed(1)}%）`;
  const ruleInterval = calculateWilsonInterval(ruleResult.correctCount, ruleResult.sampleCount);
  const reliableRuleRate = ruleResult.sampleCount >= MIN_STRATEGY_SAMPLES &&
    (ruleResult.hitRatePercent ?? 0) >= 50;
  const ruleResultText = reliableRuleRate
    ? `SMC 策略回測 ${ruleResult.correctCount}/${ruleResult.sampleCount}（${ruleResult.hitRatePercent?.toFixed(1)}%；觸發型態與 R/R 已通過程式檢查）`
    : `未達回測門檻：${ruleResult.correctCount}/${ruleResult.sampleCount} 筆；需至少 ${MIN_STRATEGY_SAMPLES} 筆、勝率 50%。`;
  return `${report}\n\n## 歷史回測\n* **結果**：${ruleResultText}。\n* **策略情境**：${pricePlanResult}。\n* **說明**：由程式按歷史訊號重播；同日同時觸及目標與停損算失敗，未觸及任一價位不計入樣本。歷史結果不保證未來。`;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]!);
      }
    }),
  );
  return results;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = "optional candidate research timed out",
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getBacktestHistory(
  ticker: string,
  symbol: string,
  asOf: string,
  expectedClose: number,
  marketHistory: Awaited<ReturnType<typeof getMarketWideRecentStockHistory>>,
  signal: AbortSignal,
): Promise<{ source: string; bars: PendingBar[] }> {
  const cached = marketWideBacktestHistoryCache.get(ticker);
  const recentBars = marketHistory.barsBySymbol.get(symbol) ?? [];
  const recentAsOfBar = recentBars.find((bar) => bar.date === asOf);
  if (cached && cached.asOf < asOf && recentBars.some((bar) => bar.date === asOf)) {
    if (!recentAsOfBar || Math.abs(recentAsOfBar.close - expectedClose) > 0.01) {
      throw new Error("批次日線與官方收盤價不一致，拒絕沿用回測快取");
    }
    const merged = new Map(cached.bars.map((bar) => [bar.date, bar]));
    for (const bar of recentBars) {
      if (bar.date <= asOf) merged.set(bar.date, {
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
    }
    const bars = [...merged.values()].sort((left, right) => left.date.localeCompare(right.date));
    marketWideBacktestHistoryCache.set(ticker, { asOf, source: cached.source, bars });
    return { source: cached.source, bars };
  }
  if (
    cached?.asOf === asOf &&
    cached.bars.at(-1)?.date === asOf &&
    Math.abs(cached.bars.at(-1)!.close - expectedClose) <= 0.01
  ) return { source: cached.source, bars: cached.bars };
  const history = await getStockHistory(ticker, "3y", {
    expectedAsOf: asOf,
    marketWideScan: true,
    signal,
  });
  const bars = history.bars
    .filter((bar) => bar.date <= asOf)
    .map(({ date, open, high, low, close, volume }) => ({ date, open, high, low, close, volume }));
  marketWideBacktestHistoryCache.set(ticker, { asOf, source: history.source, bars });
  return { source: history.source, bars };
}

async function resolveCandidateQuote(
  dailyQuote: OfficialDailyClose,
  sessionOpen: boolean,
  now: Date,
  officialAsOf: string,
  marketHistory: Awaited<ReturnType<typeof getMarketWideRecentStockHistory>>,
  providerQuote: StockQuoteData | null,
): Promise<CandidateQuote | null> {
  const ticker = `${dailyQuote.symbol}.${dailyQuote.exchange === "twse" ? "TW" : "TWO"}`;
  const batchBars = marketHistory.barsBySymbol.get(dailyQuote.symbol) ?? [];
  const history = batchBars.length >= 21
    ? { bars: batchBars, source: marketHistory.source }
    : null;
  if (!history?.bars.length) return null;
  const historyBars: PendingBar[] = history.bars.map((bar) => ({
    date: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
  const scanHistoryBars = historyBars.map((bar) =>
    bar.date === officialAsOf && dailyQuote.volume !== null
      ? { ...bar, volume: dailyQuote.volume }
      : bar,
  );
  if (sessionOpen) {
    const quoteTradeDate = providerQuote?.asOf == null
      ? null
      : toTaiwanTradingDate(providerQuote.asOf);
    const referencePrice = providerQuote?.price;
    const liveVolume = providerQuote?.volume;
    if (
      !providerQuote ||
      referencePrice === null ||
      referencePrice === undefined ||
      liveVolume === null ||
      liveVolume === undefined ||
      liveVolume <= 0
    ) return null;
    const resolution = resolveStockAiQuote({
      providerQuote,
      closeQuote: providerQuote,
      sessionOpen: true,
      providerQuoteIsInSession: quoteTradeDate === toTaiwanTradingDate(now),
      now,
    });
    if (!resolution.usable || resolution.quote.price === null) return null;
    const scanDate = quoteTradeDate!;
    const completedBars = historyBars.filter((bar) => bar.date < scanDate);
    const latestCompleted = completedBars.at(-1);
    if (
      !latestCompleted ||
      latestCompleted.date !== officialAsOf ||
      Math.abs(latestCompleted.close - dailyQuote.close) > 0.01
    ) return null;
    const liveBar: PendingBar = {
      date: scanDate,
      open: providerQuote.openPrice ?? referencePrice,
      high: providerQuote.highPrice ?? referencePrice,
      low: providerQuote.lowPrice ?? referencePrice,
      close: referencePrice,
      volume: liveVolume,
    };
    const change = providerQuote.change;
    return {
      ...dailyQuote,
      referencePrice,
      referenceChange: change,
      referenceChangePercent: providerQuote.changePercent,
      referenceType: "verified_trade",
      referenceAsOf: providerQuote.asOf,
      referenceSource: providerQuote.source,
      scanDate,
      scanBars: [...completedBars, liveBar],
      liveBar,
      historySource: history.source,
    };
  }
  const latest = historyBars.at(-1);
  if (!latest) return null;
  const prior = historyBars.at(-2);
  const change = prior ? latest.close - prior.close : null;
  const referenceAsOf = new Date(`${latest.date}T13:30:00+08:00`);
  return {
    ...dailyQuote,
    referencePrice: latest.close,
    referenceChange: change,
    referenceChangePercent: prior && prior.close > 0 && change !== null
      ? (change / prior.close) * 100
      : null,
    referenceType: "official_daily_close",
    referenceAsOf,
    referenceSource: `${history.source} · 最近已成交日線 ${latest.date}`,
    scanDate: latest.date,
    scanBars: scanHistoryBars,
    liveBar: null,
    historySource: history.source,
  };
}

function validateModelOutput(
  text: string | null,
  candidates: OfficialDailyClose[],
): { picks: Array<{
  symbol: string;
  directionProbabilityPercent: number | null;
  entryScenario: "direct" | "pullback";
  reason: string;
}> } | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as {
      picks?: unknown;
    };
    const picks = validateMarketPickSelection(
      parsed.picks,
      candidates.map((candidate) => candidate.symbol),
    );
    if (!picks) return null;
    if (!Array.isArray(parsed.picks)) return null;
    const reasons = new Map<string, string>();
    for (const value of parsed.picks) {
      if (!value || typeof value !== "object") return null;
      const item = value as Record<string, unknown>;
      if (
        typeof item.symbol !== "string" ||
        typeof item.reason !== "string" ||
        item.reason.trim().length === 0 ||
        item.reason.length > 240
      ) return null;
      reasons.set(item.symbol, item.reason.trim());
    }
    return {
      picks: picks.map((pick) => {
        const reason = reasons.get(pick.symbol);
        if (!reason) throw new Error("Missing AI selection reason");
        return { ...pick, reason };
      }),
    };
  } catch {
    return null;
  }
}

async function runAiSelection(
  instructions: string,
  input: string,
  candidates: OfficialDailyClose[],
): Promise<{
  output: NonNullable<ReturnType<typeof validateModelOutput>>;
  provider: AiProviderName;
}> {
  const result = await withAiProviderFallback({
    operation: "market_wide_ai_stock_picks",
    allowedProviders: ["groq", "gemini", "openrouter"],
    instructions,
    input,
    schema: RESPONSE_SCHEMA,
    maxOutputTokens: 2_600,
    timeoutMs: 6_000,
    groqTimeoutMs: 4_000,
    geminiTimeoutMs: 6_000,
    openRouterTimeoutMs: 4_000,
    maxFallbackDurationMs: 6_000,
    validateOutput: (text) => validateModelOutput(text, candidates) !== null,
  });
  const output = validateModelOutput(result.text, candidates);
  if (!output) throw new Error("AI 選股結果未通過資料與格式檢查。");
  return { output, provider: result.provider };
}

async function buildScan(): Promise<ScanResult> {
  scanProgress = {
    stage: "market_data",
    percent: 3,
    completedBatches: 0,
    failedBatches: 0,
    totalBatches: 0,
    scannedCount: 0,
    candidateCount: 0,
    completedCandidates: 0,
  };
  const [dailyResult, summaryResult, quoteResult] = await Promise.allSettled([
    withTimeout(getOfficialMarketScanSnapshot(), 25_000, "官方上市櫃日報與批次備援查詢超過 25 秒"),
    withTimeout(getTaiexSummary(), MARKET_SUMMARY_TIMEOUT_MS, "大盤摘要查詢逾時"),
    withTimeout(getTaiexQuote(), 4_000, "大盤即時行情查詢逾時"),
  ]);
  if (dailyResult.status === "rejected") throw dailyResult.reason;
  const daily = dailyResult.value;
  const market = summaryResult.status === "fulfilled" ? summaryResult.value : null;
  const marketIndexQuote =
    quoteResult.status === "fulfilled"
      ? quoteResult.value
      : {
          key: "taiex" as const,
          name: "台灣加權指數",
          ticker: "^TWII",
          price: null,
          change: null,
          changePercent: null,
          source: null,
          asOf: null,
          available: false,
          error: "目前無法取得加權指數行情",
        };
  if (!market) {
    logger.warn(
      { err: summaryResult.status === "rejected" ? summaryResult.reason : undefined },
      "Market summary unavailable during AI picks scan",
    );
  }
  const ordinaryStocks = dedupeMarketDailyQuotes(daily.quotes.filter(isEligibleStockAsset));
  const advances = ordinaryStocks.filter((quote) => (quote.change ?? 0) > 0).length;
  const declines = ordinaryStocks.filter((quote) => (quote.change ?? 0) < 0).length;
  const unchanged = ordinaryStocks.length - advances - declines;
  const dayTradeUniverse = ordinaryStocks.filter((quote) =>
    !DAY_TRADE_EXCLUDED_SYMBOLS.has(quote.symbol) &&
    isDayTradeLiquidityEligible(quote.close, quote.volume),
  );
  const rankedDailyCandidates = [...dayTradeUniverse].filter(passesFastStaticFilters).sort((left, right) =>
    (right.tradedValue ?? 0) - (left.tradedValue ?? 0) ||
    left.symbol.localeCompare(right.symbol),
  );
  const systemicRiskDay = isSystemicRiskDay(advances, declines);
  const sessionCheckAt = new Date();
  const dayTradeMode = getTaiwanDayTradeScanMode(sessionCheckAt);
  const withinSessionHours = isTaiwanStockSessionOpen(sessionCheckAt);
  const marketClosed = withinSessionHours
    ? await isTaiwanMarketClosed(sessionCheckAt)
    : true;
  const sessionOpen = withinSessionHours && marketClosed !== true;
  const noEntryWindow = sessionOpen && dayTradeMode === "no_entry_window";
  const intradayScan = sessionOpen && dayTradeMode === "intraday";
  // During the valid intraday window, quote the prior-session liquid stock
  // universe, then request deeper history only for fresh live movers.
  // After hours, build a next-session watchlist from the latest completed close.
  const quoteUniverse = systemicRiskDay
    ? []
    : noEntryWindow
      ? []
      : intradayScan
        ? dayTradeUniverse
      : rankedDailyCandidates;
  const liveQuotes = intradayScan && quoteUniverse.length
    ? await getMarketWideStockQuotes(quoteUniverse, sessionCheckAt, (completed, total) => {
        scanProgress = {
          ...scanProgress,
          percent: total > 0 ? Math.min(8, 3 + Math.round((5 * completed) / total)) : 3,
          candidateCount: total,
          completedCandidates: completed,
        };
      })
    : new Map<string, StockQuoteData>();
  const firstStageCandidates = systemicRiskDay
    ? []
    : noEntryWindow
      ? []
      : intradayScan
      ? quoteUniverse
        .filter((quote) => {
          const live = liveQuotes.get(quote.symbol);
          return live !== undefined && passesInSessionFastFilters(live);
        })
        .sort((left, right) => {
          const leftQuote = liveQuotes.get(left.symbol);
          const rightQuote = liveQuotes.get(right.symbol);
          const leftTurnover = (leftQuote?.price ?? 0) * (leftQuote?.volume ?? 0);
          const rightTurnover = (rightQuote?.price ?? 0) * (rightQuote?.volume ?? 0);
          return rightTurnover - leftTurnover || left.symbol.localeCompare(right.symbol);
        })
      : rankedDailyCandidates;
  const marketHistory: Awaited<ReturnType<typeof getMarketWideRecentStockHistory>> = firstStageCandidates.length
    ? await getMarketWideRecentStockHistory(
        daily.asOf,
        firstStageCandidates.map(({ symbol, exchange }) => ({ symbol, exchange })),
        (completed, total) => {
          scanProgress = {
            ...scanProgress,
            percent: total > 0 ? Math.min(9, 3 + Math.round((6 * completed) / total)) : 3,
            candidateCount: total,
            completedCandidates: completed,
          };
        },
      )
    : {
        source: systemicRiskDay
          ? "大盤偏空防守日，已跳過個股日線查詢"
          : "沒有股票通過初階行情快篩",
        barsBySymbol: new Map(),
      };
  const quoteNow = new Date();
  const scanDate = intradayScan
    ? toTaiwanTradingDate(quoteNow) ?? daily.asOf
    : daily.asOf;
  const dailyCandidates = firstStageCandidates.filter((quote) => {
    const bars = (marketHistory.barsBySymbol.get(quote.symbol) ?? [])
      .filter((bar) => bar.date <= daily.asOf);
    const latestIndex = bars.findIndex((bar) => bar.date === daily.asOf);
    if (latestIndex < 5 || Math.abs(bars[latestIndex]!.close - quote.close) > 0.01) return false;
    const latest = bars[latestIndex]!;
    const prior = bars[latestIndex - 1]!;
    const fiveSessionsAgo = bars[latestIndex - 5]!;
    if (
      latest.volume === null ||
      prior.volume === null ||
      fiveSessionsAgo.close <= 0 ||
      ((latest.close / fiveSessionsAgo.close) - 1) * 100 >= 15
    ) return false;
    if (intradayScan) {
      return liveQuotes.has(quote.symbol);
    }
    return latest.volume > prior.volume;
  });
  const previousJob = await getLatestCompletedMarketWideAiPickScanJobBefore(scanDate);
  const previousPicks = Array.isArray(previousJob?.result?.picks)
    ? previousJob.result.picks as Array<{ symbol?: unknown; name?: unknown }>
    : [];
  const previousSymbols = previousPicks
    .flatMap((pick) => typeof pick.symbol === "string" ? [pick.symbol] : []);
  scanProgress = {
    ...scanProgress,
    stage: "candidate_analysis",
    percent: 10,
    totalBatches: Math.ceil(dailyCandidates.length / MAX_FINAL_SELECTION_CANDIDATES),
    scannedCount: ordinaryStocks.length,
    candidateCount: dailyCandidates.length,
    completedCandidates: 0,
  };
  let resolvedQuotes = 0;
  const candidateQuotes = (
    await mapWithConcurrency(dailyCandidates, 10, async (dailyQuote) =>
      {
        let quote: CandidateQuote | null = null;
        try {
          quote = await resolveCandidateQuote(
            dailyQuote,
            sessionOpen,
            quoteNow,
            daily.asOf,
            marketHistory,
            liveQuotes.get(dailyQuote.symbol) ?? null,
          );
        } catch (error) {
          logger.warn({ err: error, symbol: dailyQuote.symbol }, "Unable to resolve candidate quote; continuing market scan");
        }
        resolvedQuotes += 1;
        scanProgress = {
          ...scanProgress,
          completedCandidates: resolvedQuotes,
          percent: Math.min(35, Math.round(10 + (25 * resolvedQuotes) / dailyCandidates.length)),
        };
        return quote;
      })
  ).filter((quote): quote is CandidateQuote => quote !== null);
  let completedCandidates = 0;
  let recentSignalCandidateCount = 0;
  let backtestHistoryFailureCount = 0;
  const stockScanBatchCount = Math.ceil(candidateQuotes.length / MAX_FINAL_SELECTION_CANDIDATES);
  scanProgress = {
    ...scanProgress,
    totalBatches: stockScanBatchCount,
    percent: 35,
    candidateCount: candidateQuotes.length,
    completedCandidates: 0,
  };
  const candidateAnalysisResults = await mapWithConcurrency(candidateQuotes, 10, async (quote) => {
    try {
    const ticker = `${quote.symbol}.${quote.exchange === "twse" ? "TW" : "TWO"}`;
    let bars = quote.scanBars;
    let historySource: string | null = quote.historySource;
    const recentLatest = bars.at(-1);
    const recentPlan = buildSmcPendingPlan(bars);
    const recentDataAligned = recentLatest?.date === quote.scanDate &&
      quote.scanDate === scanDate &&
      Math.abs(recentLatest.close - quote.referencePrice) <= 0.01;
    const currentSignal = recentDataAligned &&
      recentPlan !== null &&
      passesSmcPendingSignal(recentPlan);
    let historyAligned = false;
    let pendingPlan = recentPlan;
    let pendingBacktest = {
      wins: 0,
      losses: 0,
      noTouchCount: 0,
      sampleCount: 0,
      winRatePercent: null as number | null,
      payoffRatio: null as number | null,
    };
    if (currentSignal) {
      recentSignalCandidateCount += 1;
      try {
        const historyController = new AbortController();
        const extendedHistory = await withTimeout(
          getBacktestHistory(ticker, quote.symbol, daily.asOf, quote.close, marketHistory, historyController.signal),
          24_000,
          "backtest history request timed out",
          () => historyController.abort(),
        );
        const historicalBars = extendedHistory.bars;
        historySource = extendedHistory.source;
        const latestBar = historicalBars.at(-1);
        historyAligned = latestBar?.date === daily.asOf &&
          Math.abs(latestBar.close - quote.close) <= 0.01;
        bars = quote.liveBar ? [...historicalBars, quote.liveBar] : historicalBars;
        pendingPlan = buildSmcPendingPlan(bars);
        if (
          historyAligned &&
          countDailyPendingHistoryBars(historicalBars, daily.asOf) === 486 &&
          pendingPlan &&
          passesSmcPendingSignal(pendingPlan)
        ) {
          pendingBacktest = calculateDailyPendingBacktest(historicalBars, daily.asOf);
        }
      } catch (error) {
        backtestHistoryFailureCount += 1;
        logger.warn({ err: error, symbol: quote.symbol }, "Unable to retrieve the complete history needed for backtesting");
      }
    }
    const scorecard = buildStockScorecard(bars, {
      status: "unavailable",
      foreignNetShares: null,
      investmentTrustNetShares: null,
      observedAt: null,
    });
    const scenarios = buildStockTradeScenarios(bars, quote.referencePrice);
    const ruleResult = {
      sampleCount: pendingBacktest.sampleCount,
      correctCount: pendingBacktest.wins,
      hitRatePercent: pendingBacktest.winRatePercent,
    };
    completedCandidates += 1;
    scanProgress = {
      ...scanProgress,
      completedCandidates,
      completedBatches: Math.floor(completedCandidates / MAX_FINAL_SELECTION_CANDIDATES),
      percent: Math.min(68, Math.round(35 + (33 * completedCandidates) / Math.max(candidateQuotes.length, 1))),
    };
    return {
      quote,
      historySource,
      scorecard,
      scenarios,
      bars,
      pendingPlan,
      pendingBacktest,
      cdpLevels: calculateCdpLevels(
        quote.liveBar ? bars.at(-2)! : bars.at(-1)!,
        quote.referencePrice,
        quote.liveBar?.open ?? null,
      ),
      ruleResult,
      tags: buildStockScanTags(scorecard),
      historyAvailable: currentSignal
        ? historyAligned && countDailyPendingHistoryBars(bars, daily.asOf) === 486
        : recentDataAligned,
    };
    } catch (error) {
      logger.warn({ err: error, symbol: quote.symbol }, "Local analysis failed for candidate; continuing market scan");
      return null;
    }
  });
  const analyzedCandidates = candidateAnalysisResults.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== null,
  );
  const analyzedBySymbol = new Map(analyzedCandidates.map((candidate) => [candidate.quote.symbol, candidate]));
  const localCandidates = analyzedCandidates.filter((candidate) => candidate.historyAvailable);
  const completeBacktestSignalCount = analyzedCandidates.filter((candidate) =>
    candidate.pendingPlan !== null &&
    passesSmcPendingSignal(candidate.pendingPlan) &&
    candidate.historyAvailable &&
    countDailyPendingHistoryBars(candidate.bars, daily.asOf) === 486,
  ).length;
  const qualifiedCandidates = localCandidates
    .filter((candidate) =>
      candidate.pendingPlan !== null &&
      passesSmcPendingSignal(candidate.pendingPlan) &&
      candidate.pendingPlan.rewardToRisk >= 2 &&
      qualifiesDailyPendingBacktest(candidate.pendingBacktest),
    )
    .sort((left, right) =>
      right.pendingPlan!.rewardToRisk - left.pendingPlan!.rewardToRisk ||
      right.pendingPlan!.volumeRatio - left.pendingPlan!.volumeRatio ||
      (right.quote.tradedValue ?? 0) - (left.quote.tradedValue ?? 0) ||
      left.quote.symbol.localeCompare(right.quote.symbol),
    );
  const eligibleCandidateCount = qualifiedCandidates.length;
  const tierOneCandidates = qualifiedCandidates.slice(0, MAX_FINAL_SELECTION_CANDIDATES);
  const tierOneSymbols = new Set(qualifiedCandidates.map((candidate) => candidate.quote.symbol));
  const fallbackSlots = qualifiedCandidates.length >= 5
    ? 0
    : Math.max(0, 5 - qualifiedCandidates.length);
  const fallbackCandidates = systemicRiskDay || fallbackSlots === 0
    ? []
    : localCandidates
      .filter((candidate) =>
        !tierOneSymbols.has(candidate.quote.symbol) &&
        candidate.pendingPlan !== null &&
        candidate.pendingPlan.rewardToRisk >= 2,
      )
      .sort((left, right) =>
        right.scorecard.earnedPoints - left.scorecard.earnedPoints ||
        Number(Boolean(right.pendingPlan)) - Number(Boolean(left.pendingPlan)) ||
        (right.pendingPlan?.rewardToRisk ?? 0) - (left.pendingPlan?.rewardToRisk ?? 0) ||
        (right.pendingPlan?.volumeRatio ?? 0) - (left.pendingPlan?.volumeRatio ?? 0) ||
        (right.quote.tradedValue ?? 0) - (left.quote.tradedValue ?? 0) ||
        left.quote.symbol.localeCompare(right.quote.symbol),
      )
      .slice(0, Math.max(0, MAX_FINAL_SELECTION_CANDIDATES - tierOneCandidates.length));
  const selectionCandidates = [
    ...tierOneCandidates.map((candidate) => ({ ...candidate, selectionTier: "tier1" as const })),
    ...fallbackCandidates.map((candidate) => ({ ...candidate, selectionTier: "fallback" as const })),
  ];
  const selectionSymbols = new Set(selectionCandidates.map((candidate) => candidate.quote.symbol));
  const watchlist = (systemicRiskDay || noEntryWindow ? [] : analyzedCandidates)
    .filter((candidate) => !selectionSymbols.has(candidate.quote.symbol))
    .flatMap((candidate) => {
      const failure = classifyMarketPickWatchlistFailure({
        historyAvailable: candidate.historyAvailable,
        signalPassed: candidate.pendingPlan !== null && passesSmcPendingSignal(candidate.pendingPlan),
        rewardToRisk: candidate.pendingPlan?.rewardToRisk ?? null,
        backtestQualified: qualifiesDailyPendingBacktest(candidate.pendingBacktest),
      });
      if (!failure) return [];
      let failureReason = failure.failureReason;
      let observation = "";
      if (failure.failedStage === "smc_signal") {
        if (candidate.pendingPlan) {
          const failedRules = getSmcPendingSignalFailureReasons(candidate.pendingPlan);
          failureReason = failedRules.length
            ? `未通過：${failedRules.join("；")}。`
            : "未形成符合現行規則的 SMC 訊號。";
          observation = "觀察後續已完成的日線是否讓上述條件達標；訊號成立後，仍須通過風險報酬至少 1:2，以及至少 5 筆、勝率至少 50% 的策略回測。";
        } else {
          const recentBars = candidate.bars.slice(-120);
          const hasEnoughBars = recentBars.length >= 21;
          const priorVolumes = recentBars.slice(-21, -1).map((bar) => bar.volume);
          const hasUsableVolumes = priorVolumes.length === 20 &&
            priorVolumes.every((volume) => volume !== null && volume > 0);
          failureReason = !hasEnoughBars
            ? `有效日線 ${recentBars.length}/21 根，尚不足以建立 SMC 訊號。`
            : !hasUsableVolumes
              ? "近 20 個交易日的成交量資料不完整，無法計算量比。"
              : "目前未形成可計算的完整看多 SMC 計畫（觸發、停損與上方目標）。";
          observation = "觀察後續日線是否出現近 5 個交易日內的看多 BOS／CHoCH、賣方流動性掃蕩，或價格進入看多 OB／FVG 區；同時須符合單日漲幅 1.5%–9%、五日漲幅低於 15%、量增且量比高於 1.2。";
        }
      } else if (failure.failedStage === "historical_data") {
        const historyBars = countDailyPendingHistoryBars(candidate.bars, daily.asOf);
        failureReason = `回測需要與掃描日對齊的 486 根日線，目前取得 ${historyBars}/486 根。`;
        observation = "觀察官方歷史資料是否補齊並與掃描日收盤價對齊；資料完整後才會執行原有回測門檻。";
      } else if (failure.failedStage === "reward_to_risk") {
        const ratio = candidate.pendingPlan?.rewardToRisk;
        failureReason = ratio === null || ratio === undefined
          ? "目前無法計算符合條件的風險報酬。"
          : `目前風險報酬 ${ratio.toFixed(2)}:1，低於合格候選所需的 2:1。`;
        observation = "觀察後續價格結構是否能形成至少 2:1 的風險報酬；未達標前仍不列入合格候選。";
      } else if (failure.failedStage === "backtest") {
        const { sampleCount, winRatePercent } = candidate.pendingBacktest;
        failureReason = `歷史回測 ${sampleCount}/5 筆；勝率 ${winRatePercent === null ? "資料不足" : `${winRatePercent.toFixed(1)}%`}，門檻為至少 5 筆且勝率至少 50%。`;
        observation = "觀察同一規則的非重疊回測樣本是否累積至至少 5 筆，且勝率達 50%；在達標前不列入合格候選。";
      }
      return failure ? [{
        symbol: candidate.quote.symbol,
        name: candidate.quote.name,
        referencePrice: candidate.quote.referencePrice,
        ...failure,
        failureReason,
        observation,
        tradedValue: candidate.quote.tradedValue,
      }] : [];
    })
    .sort((left, right) =>
      (right.tradedValue ?? 0) - (left.tradedValue ?? 0) || left.symbol.localeCompare(right.symbol),
    )
    .slice(0, 5)
    .map(({ tradedValue: _tradedValue, ...candidate }) => candidate);
  const selectionTierBySymbol = new Map(selectionCandidates.map((candidate) => [
    candidate.quote.symbol,
    candidate.selectionTier,
  ]));
  scanProgress = {
    ...scanProgress,
    percent: 68,
    candidateCount: selectionCandidates.length,
    completedCandidates: 0,
  };
  scanProgress = { ...scanProgress, percent: 72, completedCandidates: 0 };
  const allSelectionPicks: NonNullable<ReturnType<typeof validateModelOutput>>["picks"] = [];
  const allNewsCandidates: Array<{ symbol: string; status: string; results: Array<{ url: string; title: string; snippet: string }> }> = [];
  let provider: AiProviderName = "groq";
  const fullMarketCoverage =
    daily.availableExchanges.length === 2 &&
    daily.unavailableExchanges.length === 0 &&
    (!sessionOpen || liveQuotes.size === quoteUniverse.length) &&
    candidateQuotes.length === dailyCandidates.length &&
    analyzedCandidates.length === candidateQuotes.length &&
    localCandidates.length === analyzedCandidates.length;
  const hasQualifiedCandidates = tierOneCandidates.length > 0;
  const candidateBatches = selectionCandidates.length ? [selectionCandidates] : [];
  const selectionBatchCount = candidateBatches.length;
  scanProgress = {
    ...scanProgress,
    stage: "final_selection",
    totalBatches: selectionBatchCount,
    completedBatches: 0,
    percent: 72,
  };
  for (const [batchIndex, aiCandidates] of candidateBatches.entries()) {
  let newsResearch: Awaited<ReturnType<typeof searchMarketPickNews>>;
  try {
      newsResearch = await searchMarketPickNews(
        aiCandidates.map(({ quote }) => ({ symbol: quote.symbol, name: quote.name })),
      );
  } catch (error) {
    logger.warn({ err: error, batch: batchIndex + 1 }, "News research failed for candidate batch; continuing with the next batch");
    scanProgress = {
      ...scanProgress,
      failedBatches: scanProgress.failedBatches + 1,
      completedBatches: batchIndex + 1,
      percent: Math.min(90, 72 + Math.round((18 * (batchIndex + 1)) / Math.max(selectionBatchCount, 1))),
    };
    continue;
  }
  const newsCandidates = "candidateResearch" in newsResearch
    ? newsResearch.candidateResearch
    : [];
  allNewsCandidates.push(...newsCandidates);
  const candidatesWithResearch = new Set(newsCandidates
    .filter((candidate) => candidate.status !== "unavailable")
    .map((candidate) => candidate.symbol));
  const newsQualifiedCandidates = aiCandidates.filter(({ quote }) =>
    candidatesWithResearch.has(quote.symbol),
  );
  if (!newsQualifiedCandidates.length) {
    scanProgress = { ...scanProgress, failedBatches: scanProgress.failedBatches + 1 };
    continue;
  }
  const finalInput = JSON.stringify({
    officialMarketDate: daily.asOf,
    smcRules: "接受最近 5 個交易日內看多 BOS/CHoCH 或 sell-side liquidity sweep，或到達看多 OB/未回補 bullish FVG 支撐區其中之一；量比嚴格大於 1.2，SMC 風報比至少 1.5。",
    officialReportCoverage: {
      availableExchanges: daily.availableExchanges,
      unavailableExchanges: daily.unavailableExchanges,
    },
    taiwanIndexQuote: marketIndexQuote,
    taiwanMarketSummary: market,
    marketBreadth: { ordinaryStocksScanned: ordinaryStocks.length, advances, declines, unchanged },
    newsResearch: {
      provider: newsResearch.provider,
      status: newsResearch.status,
      candidateResearch: newsCandidates.map((research) => ({
        symbol: research.symbol,
        status: research.status,
        results: research.results.slice(0, 1).map((result) => ({
          source: (() => {
            try { return new URL(result.url).hostname; } catch { return "來源未提供"; }
          })(),
          title: result.title.slice(0, 90),
          snippet: result.snippet.slice(0, 100),
        })),
      })),
    },
    locallyComputedCandidates: newsQualifiedCandidates.map(({ quote, scorecard, scenarios, ruleResult, selectionTier }) => ({
      symbol: quote.symbol,
      name: quote.name,
      exchange: quote.exchange,
      selectionTier,
      multiDimensionalQuantScore: scorecard.earnedPoints,
      smcSetup: analyzedBySymbol.get(quote.symbol)?.pendingPlan ?? null,
      referencePrice: quote.referencePrice,
      quoteType: quote.referenceType,
      quoteSource: quote.referenceSource,
      quoteAsOf: quote.referenceAsOf,
      dailyChangePercent: quote.referenceChangePercent,
      tradedValueTwd: quote.tradedValue,
      technicalIndicators: scorecard.technicalIndicators,
      scorecard: {
        earnedPoints: scorecard.earnedPoints,
        availablePoints: scorecard.availablePoints,
        institutionalSignals: scorecard.items
          .filter(({ id }) => id === "institution-外資" || id === "institution-投信")
          .map(({ label, points, maximumPoints }) => ({ label, points, maximumPoints })),
      },
      ruleBacktest: {
        sampleCount: ruleResult.sampleCount,
        wins: analyzedBySymbol.get(quote.symbol)?.pendingBacktest.wins ?? ruleResult.correctCount,
        losses: analyzedBySymbol.get(quote.symbol)?.pendingBacktest.losses ?? 0,
        noTouchCount: analyzedBySymbol.get(quote.symbol)?.pendingBacktest.noTouchCount ?? 0,
        hitRatePercent: ruleResult.hitRatePercent,
        payoffRatio: analyzedBySymbol.get(quote.symbol)?.pendingBacktest.payoffRatio ?? null,
      },
      dailySignal: {
        smc: analyzedBySymbol.get(quote.symbol)?.pendingPlan ?? null,
      },
      cdpLevels: analyzedBySymbol.get(quote.symbol)?.cdpLevels ?? null,
    })),
    previouslyPendingSymbols: previousSymbols,
    newsSearchStatus: newsResearch.status,
  });
  scanProgress = {
    ...scanProgress,
    stage: "final_selection",
    completedBatches: batchIndex,
    percent: Math.min(88, 72 + Math.round((16 * batchIndex) / Math.max(selectionBatchCount, 1))),
  };
  let finalSelection: Awaited<ReturnType<typeof runAiSelection>> | null = null;
  try {
    finalSelection = newsQualifiedCandidates.length
      ? await runAiSelection(
        SCAN_INSTRUCTIONS,
        finalInput,
        newsQualifiedCandidates.map((candidate) => candidate.quote),
      )
      : {
        output: { picks: [] },
        provider: "groq" as AiProviderName,
      };
  } catch (error) {
    logger.warn({ err: error, batch: batchIndex + 1 }, "AI selection failed for candidate batch; continuing with the next batch");
    scanProgress = {
      ...scanProgress,
      failedBatches: scanProgress.failedBatches + 1,
      completedBatches: batchIndex + 1,
      percent: Math.min(90, 72 + Math.round((18 * (batchIndex + 1)) / Math.max(selectionBatchCount, 1))),
    };
    continue;
  }
  if (!finalSelection) continue;
  allSelectionPicks.push(...finalSelection.output.picks);
  provider = finalSelection.provider;
  scanProgress = {
    ...scanProgress,
    completedBatches: batchIndex + 1,
    percent: Math.min(90, 72 + Math.round((18 * (batchIndex + 1)) / Math.max(selectionBatchCount, 1))),
  };
  }
  const output = { picks: allSelectionPicks };
  const newsCandidates = allNewsCandidates;
  const qualifiedPicks = filterPicksWithProbabilityEstimate(output.picks);
  const selectedQuotes = qualifiedPicks.flatMap((pick) => {
    const analyzed = analyzedBySymbol.get(pick.symbol);
    return analyzed ? [{ pick, quote: analyzed.quote }] : [];
  });
  scanProgress = {
    ...scanProgress,
    stage: "final_selection",
    percent: 90,
    candidateCount: qualifiedPicks.length,
  };
  const analyzedPicks = selectedQuotes.flatMap(({ pick, quote }) => {
    const analyzed = analyzedBySymbol.get(quote.symbol);
    if (!analyzed) return [];
    return [{ pick, quote, analyzed }];
  });
  const reportPicks = analyzedPicks.map(({ pick, quote, analyzed }) => ({
    pick,
    quote,
    analyzed,
    selectionTier: selectionTierBySymbol.get(quote.symbol) ?? "fallback",
  })).sort((left, right) =>
    (left.selectionTier === "tier1" ? 0 : 1) - (right.selectionTier === "tier1" ? 0 : 1) ||
    right.analyzed.scorecard.earnedPoints - left.analyzed.scorecard.earnedPoints ||
    (right.analyzed.pendingBacktest.winRatePercent ?? 0) - (left.analyzed.pendingBacktest.winRatePercent ?? 0) ||
    right.analyzed.pendingBacktest.sampleCount - left.analyzed.pendingBacktest.sampleCount ||
    (right.quote.tradedValue ?? 0) - (left.quote.tradedValue ?? 0),
  );
  const ruleResults = new Map(reportPicks.map((candidate) => {
    const backtest = candidate.analyzed.pendingBacktest;
    const plan = candidate.analyzed.pendingPlan;
    return [candidate.quote.symbol, {
      ruleResult: candidate.analyzed.ruleResult,
      pricePlanBacktest: {
        windowCount: backtest.sampleCount,
        noEntryCount: 0,
        resolvedCount: backtest.sampleCount,
        targetFirstCount: backtest.wins,
        stopFirstCount: backtest.losses,
        ambiguousCount: 0,
        unresolvedCount: 0,
        expiredCount: 0,
        winRatePercent: backtest.winRatePercent,
      },
      extendedHistoryAvailable: candidate.analyzed.historyAvailable,
      directionHistorySource: candidate.analyzed.historySource ?? "來源未辨識",
      pricePlanHistorySource: candidate.analyzed.historySource ?? "來源未辨識",
      plan,
    }] as const;
  }));
  const forwardValidation = {
    status: "collecting" as const,
    horizonDays: 5 as const,
    sampleCount: 0,
    correctCount: 0,
    hitRatePercent: null,
    lowerBoundPercent: null,
    upperBoundPercent: null,
    brierScore: null,
    minimumSampleCount: MARKET_WIDE_AI_PICK_MINIMUM_SAMPLE_COUNT,
    updatedAt: null,
    methodNote: "本頁資格依指定量價策略的歷史回測判定；AI 前瞻勝率不作為門檻。",
  };
  const signalQualifiedReportPicks = reportPicks.flatMap((candidate) => {
    const stats = ruleResults.get(candidate.quote.symbol)?.pricePlanBacktest;
    const plan = candidate.analyzed.pendingPlan;
    if (
      candidate.selectionTier !== "tier1" ||
      !stats ||
      !qualifiesDailyPendingBacktest(candidate.analyzed.pendingBacktest) ||
      !plan ||
      plan.rewardToRisk < 2 ||
      !(plan.stopPrice < plan.entryPrice && plan.entryPrice < plan.targetPrice)
    ) return [];
    return [{
      ...candidate,
      operationPlan: pendingOperationPlan(plan, candidate.quote.referencePrice),
    }];
  });
  const fallbackReportPicks = reportPicks
    .filter((candidate) => candidate.selectionTier === "fallback")
    .map((candidate) => ({
      ...candidate,
      operationPlan: {
        action: "no_trade" as const,
        entryPrice: null,
        targetPrice: null,
        stopPrice: null,
        rewardToRisk: null,
      },
    }));
  const recommendedReportPicks = [
    ...signalQualifiedReportPicks.slice(0, 5),
    ...fallbackReportPicks.slice(0, Math.max(0, 5 - signalQualifiedReportPicks.length)),
  ];
  const previousBySymbol = new Map(previousPicks
    .filter((pick): pick is { symbol: string; name: string } =>
      typeof pick.symbol === "string" && typeof pick.name === "string",
    )
    .map((pick) => [pick.symbol, pick]));
  const currentBySymbol = new Map(recommendedReportPicks.map(({ quote }) => [
    quote.symbol,
    quote.name,
  ]));
  const dailyPendingChanges: NonNullable<StockAiPicks["dailyPendingChanges"]> = [
    ...[...previousBySymbol.entries()].map(([symbol, pick]) => ({
      symbol,
      name: pick.name,
      action: currentBySymbol.has(symbol) ? "continued" as const : "removed" as const,
      detail: currentBySymbol.has(symbol)
        ? "續留名單並更新當日數據與價位。"
        : "未通過當日訊號或 AI 最終判斷，移出 pending 名單。",
    })),
    ...[...currentBySymbol.entries()]
      .filter(([symbol]) => !previousBySymbol.has(symbol))
      .map(([symbol, name]) => ({
        symbol,
        name,
        action: "added" as const,
        detail: "符合當日訊號並通過 AI 最終判斷，新增為 pending。",
      })),
  ];
  const marketFactors = market?.factors ?? [];
  const passedMarketFactors = marketFactors.filter((factor) => factor.passed).length;
  const closeVsMa20 = market?.ma20 == null || market.dailyCloseDate !== daily.asOf
    ? "官方收盤與 20 日均線日期無法核實"
    : market.dailyClosePrice > market.ma20
      ? "官方收盤高於 20 日均線"
      : "官方收盤低於 20 日均線";
  const verifiedMarketView = market && market.dailyCloseDate === daily.asOf
    ? `加權指數官方收盤 ${market.dailyClosePrice.toLocaleString("zh-TW")} 點（當日 ${market.dailyCloseChangePercent.toFixed(2)}%）；${closeVsMa20}；本地市場條件 ${passedMarketFactors}/${marketFactors.length} 項成立。`
    : "加權指數官方行情或技術摘要不完整，暫不提供市場方向判讀。";
  const fallbackPickCount = recommendedReportPicks.filter((candidate) => candidate.selectionTier === "fallback").length;
  const tierOnePickCount = recommendedReportPicks.length - fallbackPickCount;
  const coverageNote = fullMarketCoverage
    ? ""
    : "官方市場覆蓋不完整，結果不代表全市場完整排序。";
  const strictMarketView = systemicRiskDay
    ? `大盤偏空防守日：下跌 ${declines} 檔、上漲 ${advances} 檔${advances > 0 ? `（跌漲比 ${(declines / advances).toFixed(2)}）` : ""}，已停止選股並建議持現金／防守；不執行補位。`
    : noEntryWindow
      ? "目前位於開盤初段或尾盤時段，依短線交易風險原則不列當日新進場候選。"
      : recommendedReportPicks.length
      ? `${coverageNote} Tier-1 ${tierOnePickCount} 檔；綜合高分補位 ${fallbackPickCount} 檔。${verifiedMarketView}`
      : selectionCandidates.length === 0
        ? `初步行情快篩 ${rankedDailyCandidates.length} 檔；近期資料條件通過 ${dailyCandidates.length} 檔；符合後續技術與風險報酬條件的候選為 0 檔，因此未執行 AI 最終挑選。`
      : !hasQualifiedCandidates
        ? "沒有通過 Tier-1 回測門檻的股票，且 AI 風險審查未保留可列出的補位候選。"
        : "有符合 Tier-1 條件的候選，但 AI 消息風險審查未保留可列出的股票。";
  const result: ScanResult = {
    marketDate: new Date(`${scanDate}T00:00:00+08:00`),
    analyzedAt: new Date(),
    source: `${daily.source ?? `${daily.availableExchanges.join("、")} 官方全市場清單`}；${intradayScan ? "盤中當沖條件觀察（即時成交與累積量）" : noEntryWindow ? "交易時段暫停新進場掃描" : "盤後／休市：下一交易日觀察清單（最近已成交日線）"}；${marketHistory.source}`,
    marketIndexQuote,
    marketSummary: market
      ? {
          ...market,
          dailyCloseDate: new Date(`${market.dailyCloseDate}T00:00:00+08:00`),
        }
      : null,
    scannedCount: ordinaryStocks.length,
    candidateCount: recommendedReportPicks.length,
    marketContextStatus:
      fullMarketCoverage &&
      market !== null &&
      marketIndexQuote.available &&
      candidateQuotes.length === dailyCandidates.length
        ? "complete" as const
        : "partial" as const,
    marketContextNote: [
      daily.unavailableExchanges.length
        ? `以下官方日報本次不可用：${daily.unavailableExchanges.join("、")}。`
        : "",
      intradayScan
        ? `盤中即時成交覆蓋 ${liveQuotes.size}/${quoteUniverse.length} 檔全市場普通股；只採用有成交時間且未超過 3 分鐘的行情。`
        : "",
      noEntryWindow
        ? "目前為開盤後 60 分鐘或收盤前 60 分鐘，依短線交易參考原則不列當日新進場候選。"
        : "",
      marketIndexQuote.available
        ? "加權指數即時參考價與市場分析頁共用同一來源。"
        : "加權指數目前行情暫不可用。",
      market ? "" : "加權指數歷史摘要暫不可用。",
      systemicRiskDay
        ? `大盤防守開關啟動（下跌 ${declines}、上漲 ${advances}）；已跳過個股日線分析與補位。`
        : "",
       `${intradayScan
        ? `盤中即時快篩 ${firstStageCandidates.length}/${quoteUniverse.length} 檔`
        : noEntryWindow
          ? "目前不在建議進場時段"
         : `下一交易日觀察清單初篩 ${rankedDailyCandidates.length} 檔`}；第二階段取得有效近期日線 ${candidateQuotes.length}/${dailyCandidates.length} 檔；近期日線來源：${marketHistory.source}。依短線參考條件先看成交量與流動性（股價低於 100 元至少 1 萬張、100 元以上至少 5 千張），排除 ETF 與文章舉例的大型權值股；盤中僅在 10:00–12:30 使用新鮮即時成交，避免開盤追價與尾盤新進場。CDP 五價用前一交易日高低收計算，只作支撐壓力區參考；目前不具完整盤中逐筆路徑，不宣稱已發生突破或反轉。SMC 訊號與日線回測仍是額外風險參考，非當沖績效；進出情境要求 R/R 至少 1:2。AI 審查重大營運利空、法說會風險、財報衰退及訴訟風險。`,
      `當日第一階段候選 ${dailyCandidates.length} 檔；SMC 訊號 ${recentSignalCandidateCount} 檔；取得完整 486 根回測日線 ${completeBacktestSignalCount} 檔；長歷史查詢逾時或失敗 ${backtestHistoryFailureCount} 檔；Tier-1 資格 ${eligibleCandidateCount} 檔；最終 Tier-1 ${tierOnePickCount} 檔、補位 ${fallbackPickCount} 檔。`,
      candidateQuotes.length < dailyCandidates.length
         ? `全市場普通股中有 ${dailyCandidates.length - candidateQuotes.length} 檔未取得可用參考行情，已排除。`
        : "",
      analyzedCandidates.length < candidateQuotes.length
         ? `全市場普通股中有 ${candidateQuotes.length - analyzedCandidates.length} 檔未完成本地指標計算，已排除。`
        : "",
      localCandidates.length < analyzedCandidates.length
        ? `有 ${analyzedCandidates.length - localCandidates.length} 檔未能取得最近 24 個月完整的 486 根日線，未交由 AI 選擇。`
        : "",
    ].filter(Boolean).join(" "),
    advances,
    declines,
    unchanged,
    marketView: strictMarketView,
    probabilityDefinition: "短線流動性篩選：股價低於 100 元至少 1 萬張、100 元以上至少 5 千張；排除 ETF 與文章舉例權值股。盤中只在 10:00–12:30 使用新鮮即時行情，開盤後 60 分鐘與收盤前 60 分鐘不列新進場候選。CDP＝(H+L+2C)/4；AH＝CDP+(H-L)、NH＝2CDP-L、NL＝2CDP-H、AL＝CDP-(H-L)，僅作價格區間參考，不單獨構成訊號。畫面中的歷史策略回測使用日線、次日開盤起 10 個交易日，不是當沖勝率；同日同觸目標與停損按失敗。",
    riskNote: `每日最多五檔，均為條件參考而非下單建議。${noEntryWindow ? "目前不在建議的新進場時段，未列當日候選。" : !intradayScan ? "本結果是下一交易日觀察清單；開盤後須重新核對成交量、價格與進場時段，不可直接視為當沖訊號。" : "盤中候選僅在 10:00–12:30 的即時行情條件下成立，行情變化後需重新評估。"}${systemicRiskDay ? "本日觸發大盤偏空防守開關，建議持現金／防守，名單不補位。" : "大盤防守開關於下跌至少 1,500 檔或跌漲比至少 3.0 時啟動。"}AI 排除有來源支持的重大營運利空、法說會風險、財報衰退或訴訟風險。頁面歷史回測為多日策略統計，不代表當沖績效或未來獲利。`,
    forwardValidation,
    aiSelectionAttempted: selectionBatchCount > 0,
    aiProvider: provider,
    watchlist,
    dailyPendingChanges,
    picks: recommendedReportPicks.slice(0, 30).map(({ pick, quote, analyzed, selectionTier, operationPlan }): AiPick => {
      const { scorecard, scenarios, tags } = analyzed;
      const smcPlan = analyzed.pendingPlan;
      const triggerLabel = smcPlan?.triggerType === "Sweep"
        ? "掃蕩後站回"
        : smcPlan?.triggerType === "Zone"
          ? `${smcPlan.zoneType} 支撐區觸及`
          : smcPlan?.triggerType ?? "未形成完整訊號";
      const stopSourceLabel = smcPlan?.triggerType === "Sweep"
        ? "掃蕩影線低點"
        : smcPlan?.zoneType === "OB"
          ? "OB 下緣"
          : smcPlan?.zoneType === "FVG"
            ? "FVG 下緣"
            : smcPlan ? "近期波段低點" : "未設定";
      const tierTag = selectionTier === "tier1" ? "[🟢 完美符合條件]" : "[🟡 綜合高分補位標的]";
      const reason = `${tierTag} ${pick.reason}${smcPlan ? `【SMC：${triggerLabel}】` : "【補位候選，未通過完整 SMC／回測門檻】"}`;
      const backtest = ruleResults.get(quote.symbol);
      const ruleResult = backtest?.ruleResult ?? analyzed.ruleResult;
      const pricePlanBacktest = backtest?.pricePlanBacktest;
      return {
        symbol: quote.symbol,
        ticker: `${quote.symbol}.${quote.exchange === "twse" ? "TW" : "TWO"}`,
        name: quote.name,
        close: quote.referencePrice,
        change: quote.referenceChange,
        changePercent: quote.referenceChangePercent,
        tradedValue: quote.tradedValue!,
        referencePrice: quote.referencePrice,
        referenceChange: quote.referenceChange,
        referenceChangePercent: quote.referenceChangePercent,
        referenceType: quote.referenceType,
        referenceAsOf: quote.referenceAsOf,
        referenceSource: quote.referenceSource,
        directionProbabilityPercent: pick.directionProbabilityPercent!,
        aiDirectionProbabilityPercent: pick.directionProbabilityPercent,
        ruleHitRatePercent: ruleResult.hitRatePercent,
        ruleCorrectCount: ruleResult.correctCount,
        ruleSampleCount: ruleResult.sampleCount,
        ruleLowerBoundPercent: calculateWilsonInterval(
          ruleResult.correctCount,
          ruleResult.sampleCount,
        ).lowerBoundPercent,
        ruleUpperBoundPercent: calculateWilsonInterval(
          ruleResult.correctCount,
          ruleResult.sampleCount,
        ).upperBoundPercent,
        historicalValidationQualified: qualifiesDailyPendingBacktest(analyzed.pendingBacktest),
        historicalAiDirectionHitRatePercent: null,
        historicalDirectionLowerBoundPercent: null,
        historicalDirectionSampleCount: 0,
        historicalAiPricePlanHitRatePercent: ruleResult.hitRatePercent,
        historicalPricePlanLowerBoundPercent: calculateWilsonInterval(
          ruleResult.correctCount,
          ruleResult.sampleCount,
        ).lowerBoundPercent,
        historicalPricePlanSampleCount: ruleResult.sampleCount,
         cdpLevels: analyzed.cdpLevels
           ? {
               ...analyzed.cdpLevels,
               referenceDate: new Date(`${analyzed.cdpLevels.referenceDate}T00:00:00+08:00`),
             }
           : null,
        operationPlan,
        reason,
        probabilityEvidence: [
          selectionTier === "fallback"
            ? `量化綜合得分 ${scorecard.earnedPoints}/100；此為次級池補位，不代表通過 Tier-1。${smcPlan ? `SMC ${triggerLabel}、R/R ${smcPlan.rewardToRisk.toFixed(2)}，但未通過全部嚴格門檻。` : "未形成完整 SMC 計畫，僅供高分觀察。"}`
            : `SMC ${triggerLabel}（${smcPlan!.triggerDate}）；${smcPlan!.zoneType} ${smcPlan!.zoneLower.toFixed(2)}–${smcPlan!.zoneUpper.toFixed(2)}；量比 ${smcPlan!.volumeRatio.toFixed(2)} 倍；停損採${stopSourceLabel} ${smcPlan!.stopPrice.toFixed(2)}、目標 ${smcPlan!.targetPrice.toFixed(2)}、R/R ${smcPlan!.rewardToRisk.toFixed(2)}；24 個月回測 ${ruleResult.correctCount}/${ruleResult.sampleCount} 勝（${ruleResult.hitRatePercent!.toFixed(1)}%）；未觸及 ${analyzed.pendingBacktest.noTouchCount} 筆不計勝率；日線來源：${backtest?.directionHistorySource ?? analyzed.historySource ?? "來源未辨識"}`,
          (() => {
            const research = newsCandidates.find((item) => item.symbol === quote.symbol);
            const source = research?.results[0];
            return source
              ? `消息來源：${source.title}（${source.url}）`
              : "沒有可核實的個股消息來源";
          })(),
          "由程式根據標示來源的歷史日線重播，不是 AI 歷史勝率或未來保證。",
        ].join("；"),
        screeningReportMarkdown: screeningReport(
          quote,
          pick.directionProbabilityPercent!,
          reason,
          scorecard,
          scenarios,
          tags,
          { ...ruleResult, currentDirection: "bullish" },
          pricePlanBacktest ?? calculateLocalPricePlanBacktest([], () => null),
        ),
      };
    }),
  };
  scanProgress = {
    ...scanProgress,
    stage: "complete",
    percent: 100,
    completedBatches: selectionBatchCount,
    totalBatches: selectionBatchCount,
    completedCandidates: candidateQuotes.length,
  };
  return result;
}

export async function runMarketWideAiPickScan(): Promise<ScanResult> {
  const key = "latest";
  const existing = inFlightScans.get(key);
  if (existing) return existing;
  const promise = buildScan().catch((error) => {
    scanProgress = { ...scanProgress, stage: "error", percent: 0 };
    logger.warn({ err: error }, "Unable to generate market-wide AI stock picks");
    throw error;
  });
  inFlightScans.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inFlightScans.get(key) === promise) inFlightScans.delete(key);
  }
}

export async function getMarketWideAiPicks(): Promise<ScanResult> {
  const job = await startMarketWideAiPickScanJob();
  const deadline = Date.now() + 45 * 60 * 1_000;
  let current = job;
  while (Date.now() <= deadline) {
    if (current.status === "completed") {
      if (!current.result) throw new Error("今日掃描已結束，但沒有可用結果。");
      return current.result as unknown as ScanResult;
    }
    if (current.status === "failed") {
      throw new Error(current.errorMessage ?? "今日全市場掃描未完成。");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const refreshed = await getMarketWideAiPickScanJob(job.id);
    if (!refreshed) throw new Error("找不到今日全市場掃描工作。");
    current = refreshed;
  }
  throw new Error("今日全市場掃描仍在進行；請使用掃描狀態查看進度。");
}
