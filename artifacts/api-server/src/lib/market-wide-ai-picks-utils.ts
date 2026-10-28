export const MARKET_PICK_MINIMUM_REWARD_TO_RISK = 1.5;
export const MAX_FINAL_MARKET_AI_PICKS = 30;
export const MAX_AI_DIRECTION_PROBABILITY_PERCENT = 95;
export const DAY_TRADE_SHARES_PER_LOT = 1_000;
export const DAY_TRADE_EXCLUDED_SYMBOLS = new Set(["2330", "2002", "2317"]);

export type CdpPriceZone =
  | "above_ah"
  | "ah_to_nh"
  | "nh_to_cdp"
  | "cdp_to_nl"
  | "nl_to_al"
  | "below_al";

export type CdpLevels = {
  referenceDate: string;
  cdp: number;
  ah: number;
  nh: number;
  nl: number;
  al: number;
  currentZone: CdpPriceZone;
  openingZone: CdpPriceZone | null;
};

export function calculateCdpLevels(
  priorSession: { date: string; high: number; low: number; close: number },
  currentPrice: number,
  openingPrice: number | null = null,
): CdpLevels | null {
  const { high, low, close } = priorSession;
  if (
    !priorSession.date ||
    ![high, low, close, currentPrice].every(Number.isFinite) ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    currentPrice <= 0 ||
    high < low ||
    close < low ||
    close > high ||
    (openingPrice !== null && (!Number.isFinite(openingPrice) || openingPrice <= 0))
  ) return null;

  const cdp = (high + low + 2 * close) / 4;
  const ah = cdp + (high - low);
  const nh = 2 * cdp - low;
  const al = cdp - (high - low);
  const nl = 2 * cdp - high;
  const zoneFor = (price: number): CdpPriceZone =>
    price >= ah ? "above_ah"
      : price >= nh ? "ah_to_nh"
        : price >= cdp ? "nh_to_cdp"
          : price >= nl ? "cdp_to_nl"
            : price >= al ? "nl_to_al"
              : "below_al";

  return {
    referenceDate: priorSession.date,
    cdp,
    ah,
    nh,
    nl,
    al,
    currentZone: zoneFor(currentPrice),
    openingZone: openingPrice === null ? null : zoneFor(openingPrice),
  };
}

export function dayTradeMinimumDailyShares(price: number): number {
  return (price < 100 ? 10_000 : 5_000) * DAY_TRADE_SHARES_PER_LOT;
}

export function isDayTradeLiquidityEligible(
  price: number,
  dailyVolumeShares: number | null | undefined,
): boolean {
  return Number.isFinite(price) &&
    price > 0 &&
    Number.isFinite(dailyVolumeShares) &&
    (dailyVolumeShares ?? 0) >= dayTradeMinimumDailyShares(price);
}

export type TaiwanDayTradeScanMode = "intraday" | "no_entry_window" | "next_session_watchlist";

export function getTaiwanDayTradeScanMode(now: Date): TaiwanDayTradeScanMode {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const minuteOfDay = hour * 60 + minute;
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday ?? "")) {
    return "next_session_watchlist";
  }
  if (minuteOfDay >= 9 * 60 && minuteOfDay < 10 * 60) {
    return "no_entry_window";
  }
  if (minuteOfDay >= 10 * 60 && minuteOfDay < 12 * 60 + 30) {
    return "intraday";
  }
  if (minuteOfDay < 13 * 60 + 30) return "no_entry_window";
  return "next_session_watchlist";
}

export function isSystemicRiskDay(advances: number, declines: number): boolean {
  if (declines >= 1_500) return true;
  if (declines <= 0) return false;
  if (advances <= 0) return true;
  return declines / advances >= 3;
}

export type MarketPickWatchlistFailureStage =
  | "historical_data"
  | "smc_signal"
  | "reward_to_risk"
  | "backtest";

export function classifyMarketPickWatchlistFailure(input: {
  historyAvailable: boolean;
  signalPassed: boolean;
  rewardToRisk: number | null;
  backtestQualified: boolean;
}): { failedStage: MarketPickWatchlistFailureStage; failureReason: string } | null {
  if (!input.historyAvailable) {
    return {
      failedStage: "historical_data",
      failureReason: "未取得與掃描日對齊的完整歷史日線，無法完成策略回測。",
    };
  }
  if (!input.signalPassed) {
    return {
      failedStage: "smc_signal",
      failureReason: "未通過現行 SMC 訊號條件。",
    };
  }
  if (input.rewardToRisk === null || input.rewardToRisk < 2) {
    return {
      failedStage: "reward_to_risk",
      failureReason: "風險報酬未達現行 1:2 門檻。",
    };
  }
  if (!input.backtestQualified) {
    return {
      failedStage: "backtest",
      failureReason: "歷史回測未達現行最低樣本數與勝率門檻。",
    };
  }
  return null;
}

export function getSmcPendingSignalFailureReasons(plan: {
  dailyChangePercent: number;
  fiveDayChangePercent: number;
  volumeIncreased: boolean;
  volumeRatio: number;
  rewardToRisk: number;
}): string[] {
  const reasons: string[] = [];
  if (plan.dailyChangePercent < 1.5 || plan.dailyChangePercent > 9) {
    reasons.push(`單日漲幅需介於 1.5%–9%，目前 ${plan.dailyChangePercent.toFixed(2)}%`);
  }
  if (plan.fiveDayChangePercent >= 15) {
    reasons.push(`五日漲幅需低於 15%，目前 ${plan.fiveDayChangePercent.toFixed(2)}%`);
  }
  if (!plan.volumeIncreased) {
    reasons.push("成交量需高於前一交易日，目前未增加");
  }
  if (plan.volumeRatio <= 1.2) {
    reasons.push(`量比需高於 1.2，目前 ${plan.volumeRatio.toFixed(2)}`);
  }
  if (plan.rewardToRisk < 1.5) {
    reasons.push(`SMC 訊號的風險報酬需至少 1.5，目前 ${plan.rewardToRisk.toFixed(2)}:1`);
  }
  return reasons;
}

export function dedupeMarketDailyQuotes<T extends { exchange: string; symbol: string }>(
  quotes: T[],
): T[] {
  const unique = new Map<string, T>();
  for (const quote of quotes) {
    const key = `${quote.exchange}:${quote.symbol}`;
    if (!unique.has(key)) unique.set(key, quote);
  }
  return [...unique.values()];
}

export type CloseBar = { close: number };

export function calculateWilsonInterval(
  successes: number,
  sampleCount: number,
): { lowerBoundPercent: number | null; upperBoundPercent: number | null } {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(sampleCount) ||
    sampleCount <= 0 ||
    successes < 0 ||
    successes > sampleCount
  ) return { lowerBoundPercent: null, upperBoundPercent: null };

  const z = 1.959963984540054;
  const observedRate = successes / sampleCount;
  const denominator = 1 + (z * z) / sampleCount;
  const center = (observedRate + (z * z) / (2 * sampleCount)) / denominator;
  const margin = (z * Math.sqrt(
    (observedRate * (1 - observedRate)) / sampleCount +
      (z * z) / (4 * sampleCount * sampleCount),
  )) / denominator;
  return {
    lowerBoundPercent: Math.max(0, center - margin) * 100,
    upperBoundPercent: Math.min(1, center + margin) * 100,
  };
}

export function calculateBullishMomentumWinRate(
  bars: CloseBar[],
  options: { lookback?: number; horizon?: number; step?: number; maxSamples?: number } = {},
): { currentDirection: "bullish" | "bearish" | "neutral" | null; sampleCount: number; correctCount: number; hitRatePercent: number | null } {
  const lookback = options.lookback ?? 20;
  const horizon = options.horizon ?? 5;
  const step = options.step ?? horizon;
  const maxSamples = options.maxSamples ?? 20;
  if (
    !Number.isInteger(lookback) || lookback < 1 ||
    !Number.isInteger(horizon) || horizon < 1 ||
    !Number.isInteger(step) || step < 1 ||
    !Number.isInteger(maxSamples) || maxSamples < 1
  ) return { currentDirection: null, sampleCount: 0, correctCount: 0, hitRatePercent: null };

  const directionAt = (index: number) => {
    const current = bars[index]?.close;
    const reference = bars[index - lookback]?.close;
    if (
      typeof current !== "number" || typeof reference !== "number" ||
      !Number.isFinite(current) || !Number.isFinite(reference) ||
      current <= 0 || reference <= 0
    ) return null;
    return current > reference ? "bullish" as const : current < reference ? "bearish" as const : "neutral" as const;
  };

  const currentDirection = directionAt(bars.length - 1);
  const outcomes: boolean[] = [];
  for (let index = lookback; index + horizon < bars.length; index += step) {
    const forecastDirection = directionAt(index);
    if (forecastDirection !== "bullish") continue;
    const reference = bars[index]?.close;
    const actual = bars[index + horizon]?.close;
    if (
      typeof reference !== "number" || typeof actual !== "number" ||
      !Number.isFinite(reference) || !Number.isFinite(actual) ||
      reference <= 0 || actual <= 0 || actual === reference
    ) continue;
    outcomes.push(actual > reference);
  }
  const recentOutcomes = outcomes.slice(-maxSamples);
  const sampleCount = recentOutcomes.length;
  const correctCount = recentOutcomes.filter(Boolean).length;
  return {
    currentDirection,
    sampleCount,
    correctCount,
    hitRatePercent: sampleCount ? (correctCount / sampleCount) * 100 : null,
  };
}

export type LocalPricePlanBacktest = {
  windowCount: number;
  resolvedCount: number;
  targetFirstCount: number;
  stopFirstCount: number;
  ambiguousCount: number;
  noEntryCount: number;
  expiredCount: number;
  winRatePercent: number | null;
};

export function calculateLocalPricePlanBacktest<T extends {
  date: string;
  high: number;
  low: number;
}>(
  bars: T[],
  planAtIndex: (index: number, historyThroughSignal: T[]) => {
    entryPrice: number;
    targetPrice: number;
    stopPrice: number;
  } | null,
  options: { lookbackBars?: number; horizon?: number; maxPeriods?: number } = {},
): LocalPricePlanBacktest {
  const lookbackBars = options.lookbackBars ?? 60;
  const horizon = options.horizon ?? 5;
  const maxPeriods = options.maxPeriods ?? 20;
  const empty = {
    windowCount: 0,
    resolvedCount: 0,
    targetFirstCount: 0,
    stopFirstCount: 0,
    ambiguousCount: 0,
    noEntryCount: 0,
    expiredCount: 0,
    winRatePercent: null,
  };
  if (
    !Number.isInteger(lookbackBars) || lookbackBars < 1 ||
    !Number.isInteger(horizon) || horizon < 1 ||
    !Number.isInteger(maxPeriods) || maxPeriods < 1
  ) return empty;

  const firstIndex = Math.max(lookbackBars, bars.length - ((maxPeriods + 1) * horizon));
  let windowCount = 0;
  let targetFirstCount = 0;
  let stopFirstCount = 0;
  let ambiguousCount = 0;
  let noEntryCount = 0;
  let expiredCount = 0;

  for (let index = firstIndex; index + horizon < bars.length; index += horizon) {
    const plan = planAtIndex(index, bars.slice(0, index + 1));
    if (
      !plan ||
      !Number.isFinite(plan.entryPrice) ||
      !Number.isFinite(plan.targetPrice) ||
      !Number.isFinite(plan.stopPrice) ||
      !(plan.stopPrice < plan.entryPrice && plan.entryPrice < plan.targetPrice)
    ) continue;
    windowCount += 1;
    let entered = false;
    let settled = false;
    for (const bar of bars.slice(index + 1, index + horizon + 1)) {
      if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low) || bar.low <= 0 || bar.high < bar.low) continue;
      if (!entered) {
        if (bar.low > plan.entryPrice || bar.high < plan.entryPrice) continue;
        entered = true;
      }
      const stopTouched = bar.low <= plan.stopPrice;
      const targetTouched = bar.high >= plan.targetPrice;
      if (stopTouched && targetTouched) {
        ambiguousCount += 1;
        settled = true;
        break;
      }
      if (targetTouched) {
        targetFirstCount += 1;
        settled = true;
        break;
      }
      if (stopTouched) {
        stopFirstCount += 1;
        settled = true;
        break;
      }
    }
    if (settled) continue;
    if (entered) expiredCount += 1;
    else noEntryCount += 1;
  }
  // A target-first event is the only success. Ambiguous and expired entered
  // trades remain in the denominator rather than inflating the hit rate.
  const resolvedCount = targetFirstCount + stopFirstCount + ambiguousCount + expiredCount;
  return {
    windowCount,
    resolvedCount,
    targetFirstCount,
    stopFirstCount,
    ambiguousCount,
    noEntryCount,
    expiredCount,
    winRatePercent: resolvedCount > 0 ? (targetFirstCount / resolvedCount) * 100 : null,
  };
}

export function qualifiesAsReliablePricePlan(
  result: LocalPricePlanBacktest,
  minimumSampleCount = 100,
  minimumLowerBoundPercent = 50,
): boolean {
  const interval = calculateWilsonInterval(result.targetFirstCount, result.resolvedCount);
  return result.resolvedCount >= minimumSampleCount &&
    (interval.lowerBoundPercent ?? 0) > minimumLowerBoundPercent;
}

export function passesAiForwardValidationGate(validation: {
  sampleCount: number;
  minimumSampleCount: number;
  lowerBoundPercent: number | null;
}): boolean {
  return validation.sampleCount >= validation.minimumSampleCount &&
    validation.lowerBoundPercent !== null &&
    validation.lowerBoundPercent > 50;
}

export function qualifiesAsBuySignal(input: {
  forwardValidation: {
    sampleCount: number;
    minimumSampleCount: number;
    lowerBoundPercent: number | null;
  };
  pricePlan: LocalPricePlanBacktest;
  hasVerifiedNews: boolean;
  rewardToRisk: number | null;
}): boolean {
  return input.hasVerifiedNews &&
    passesAiForwardValidationGate(input.forwardValidation) &&
    qualifiesAsReliablePricePlan(input.pricePlan) &&
    input.rewardToRisk !== null &&
    input.rewardToRisk >= MARKET_PICK_MINIMUM_REWARD_TO_RISK;
}

export function isValidMarketPickProbability(
  value: unknown,
): value is number | null {
  return value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_AI_DIRECTION_PROBABILITY_PERCENT);
}

export type ValidatedMarketPickSelection = {
  symbol: string;
  directionProbabilityPercent: number;
  entryScenario: "direct" | "pullback";
};

export type MarketPickOperationPlan = {
  action: "wait_for_pullback" | "conditional_entry" | "no_trade";
  entryPrice: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  rewardToRisk: number | null;
};

type MarketPickScenario = {
  entryPrice: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  rewardToRisk: number | null;
};

export function chooseMarketPickOperationPlan(
  scenarios: { directEntry: MarketPickScenario; pullbackEntry: MarketPickScenario },
  dailyChangePercent: number | null,
  preferredScenario?: "direct" | "pullback",
): MarketPickOperationPlan {
  const pullback = scenarios.pullbackEntry;
  const validPullback =
    pullback.rewardToRisk !== null &&
    pullback.rewardToRisk >= MARKET_PICK_MINIMUM_REWARD_TO_RISK &&
    pullback.entryPrice !== null &&
    pullback.targetPrice !== null &&
    pullback.stopPrice !== null;
  const direct = scenarios.directEntry;
  const validDirect =
    (dailyChangePercent === null || dailyChangePercent < 9.5) &&
    direct.rewardToRisk !== null &&
    direct.rewardToRisk >= MARKET_PICK_MINIMUM_REWARD_TO_RISK &&
    direct.entryPrice !== null &&
    direct.targetPrice !== null &&
    direct.stopPrice !== null;
  if (preferredScenario === "pullback" && validPullback) {
    return { action: "wait_for_pullback", ...pullback };
  }
  if (preferredScenario === "direct" && validDirect) {
    return { action: "conditional_entry", ...direct };
  }
  if (validPullback) return { action: "wait_for_pullback", ...pullback };
  if (validDirect) return { action: "conditional_entry", ...direct };
  return {
    action: "no_trade",
    entryPrice: null,
    targetPrice: null,
    stopPrice: null,
    rewardToRisk: null,
  };
}

export function validateMarketPickSelection(
  value: unknown,
  allowedSymbols: string[],
): ValidatedMarketPickSelection[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_FINAL_MARKET_AI_PICKS
  ) {
    return null;
  }
  const allowed = new Set(allowedSymbols.map((symbol) => symbol.toUpperCase()));
  const seen = new Set<string>();
  const bullishPicks: ValidatedMarketPickSelection[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const pick = item as Record<string, unknown>;
    const symbol = typeof pick.symbol === "string" ? pick.symbol.toUpperCase() : "";
    const direction = pick.direction;
    const probability = pick.directionProbabilityPercent;
    const entryScenario = pick.entryScenario;
    if (
      !allowed.has(symbol) ||
      seen.has(symbol) ||
      direction !== "bullish" ||
      (entryScenario !== "direct" && entryScenario !== "pullback") ||
      probability === null ||
      !isValidMarketPickProbability(probability)
    ) return null;
    seen.add(symbol);
    bullishPicks.push({
      symbol,
      directionProbabilityPercent: probability,
      entryScenario,
    });
  }
  return bullishPicks;
}

export function shouldSplitPreliminaryBatchAfterFailure(
  failures: Array<{ status: number | null; failureKind: string | null }>,
): boolean {
  return failures.some(
    (failure) =>
      failure.status === 413 || failure.failureKind === "invalid_output",
  );
}

export function institutionalDataMatchesMarketDate(
  observedAt: string | null | undefined,
  marketDate: string,
): boolean {
  return observedAt === marketDate;
}

export function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError("chunkSize must be a positive integer");
  }
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    chunks.push(items.slice(offset, offset + chunkSize));
  }
  return chunks;
}

export function hasUsefulMarketCandidatePool(
  availableExchangeCount: number,
  locallyQualifiedCandidateCount: number,
): boolean {
  return Number.isInteger(availableExchangeCount) &&
    availableExchangeCount >= 2 &&
    Number.isInteger(locallyQualifiedCandidateCount) &&
    locallyQualifiedCandidateCount >= MAX_FINAL_MARKET_AI_PICKS;
}

type ProbabilityPick = {
  directionProbabilityPercent: number | null;
};

export function filterPicksWithProbabilityEstimate<T extends ProbabilityPick>(
  picks: T[],
): Array<T & { directionProbabilityPercent: number }> {
  return picks.filter(
    (
      pick,
    ): pick is T & { directionProbabilityPercent: number } =>
      pick.directionProbabilityPercent !== null,
  );
}

export function calculateHitRatePercent(
  successCount: number,
  sampleCount: number,
): number | null {
  if (
    !Number.isFinite(successCount) ||
    !Number.isFinite(sampleCount) ||
    sampleCount <= 0 ||
    successCount < 0 ||
    successCount > sampleCount
  ) {
    return null;
  }
  return (successCount / sampleCount) * 100;
}

type StrictMarketPick = {
  symbol: string;
  directionProbabilityPercent: number;
  tradedValue: number;
  entryScenario: "direct" | "pullback";
  referenceChangePercent: number | null;
  scorecard: {
    earnedPoints: number;
    items: Array<{ id: string; points: number | null }>;
  };
  scenarios: {
    directEntry: { rewardToRisk: number | null };
    pullbackEntry: { rewardToRisk: number | null };
  };
};

export function rankQualifiedMarketPicks<T extends StrictMarketPick>(
  picks: T[],
): T[] {
  return picks
    .filter((pick) => {
      const foreign = pick.scorecard.items.find((item) => item.id === "institution-外資");
      const investmentTrust = pick.scorecard.items.find((item) => item.id === "institution-投信");
      const plan = chooseMarketPickOperationPlan(
        pick.scenarios as { directEntry: MarketPickScenario; pullbackEntry: MarketPickScenario },
        pick.referenceChangePercent,
        pick.entryScenario,
      );
      return (foreign?.points === 10 || investmentTrust?.points === 10) &&
        plan.action !== "no_trade";
    })
    .sort((left, right) =>
      right.directionProbabilityPercent - left.directionProbabilityPercent ||
      right.scorecard.earnedPoints - left.scorecard.earnedPoints ||
      right.tradedValue - left.tradedValue ||
      left.symbol.localeCompare(right.symbol),
    );
}
