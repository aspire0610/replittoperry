import { analyzeDailySmc } from "./smc-analysis.js";
import { getSmcPendingSignalFailureReasons as getSmcSignalFailureReasons } from "./market-wide-ai-picks-utils.js";

export type PendingBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type SmcPendingPlan = {
  triggerType: "BOS" | "CHoCH" | "Sweep" | "Zone";
  triggerDate: string;
  zoneType: "OB" | "FVG" | "SWING";
  zoneLower: number;
  zoneUpper: number;
  stopPrice: number;
  targetPrice: number;
  entryPrice: number;
  rewardToRisk: number;
  volumeRatio: number;
  dailyChangePercent: number;
  fiveDayChangePercent: number;
  volumeIncreased: boolean;
};

export type PendingBacktest = {
  wins: number;
  losses: number;
  noTouchCount: number;
  sampleCount: number;
  winRatePercent: number | null;
  payoffRatio: number | null;
};

export const MINIMUM_BACKTEST_SAMPLES = 5;

function toDateKey(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function triggerIsRecent(date: Date, bars: PendingBar[], maxAge = 4): boolean {
  const key = toDateKey(date);
  const index = bars.findIndex((bar) => bar.date === key);
  return index >= 0 && bars.length - 1 - index <= maxAge;
}

export function buildSmcPendingPlan(bars: PendingBar[]): SmcPendingPlan | null {
  if (bars.length < 21) return null;
  const recentBars = bars.slice(-120);
  const latest = recentBars.at(-1)!;
  const previous = recentBars.at(-2)!;
  const fiveSessionsAgo = recentBars.at(-6)!;
  const prior20 = recentBars.slice(-21, -1).map((bar) => bar.volume);
  if (prior20.length !== 20 || prior20.some((volume) => volume === null || volume <= 0)) return null;
  const averageVolume = prior20.reduce<number>((sum, volume) => sum + (volume ?? 0), 0) / 20;
  const volumeRatio = (latest.volume ?? 0) / averageVolume;
  const dailyChangePercent = ((latest.close / previous.close) - 1) * 100;
  const fiveDayChangePercent = ((latest.close / fiveSessionsAgo.close) - 1) * 100;

  const smc = analyzeDailySmc(recentBars);
  if (smc.status !== "available") return null;
  const latestBreak = smc.latestBreak;
  const breakType: "BOS" | "CHoCH" | null = latestBreak.kind === "bullish_bos"
    ? "BOS"
    : latestBreak.kind === "bullish_choch"
      ? "CHoCH"
      : null;
  const validBreak: { type: "BOS" | "CHoCH"; date: string } | null =
    breakType && latestBreak.date && triggerIsRecent(latestBreak.date, recentBars)
    ? { type: breakType, date: toDateKey(latestBreak.date) }
    : null;
  const recentSweep = smc.liquiditySweeps.find((sweep) =>
    sweep.side === "sell_side" && triggerIsRecent(sweep.date, recentBars),
  );

  const orderBlock = smc.candidateOrderBlocks
    .filter((zone) =>
      zone.direction === "bullish" &&
      latest.close >= zone.lower &&
      latest.close <= zone.upper * 1.03,
    )
    .sort((left, right) => right.date.getTime() - left.date.getTime())[0];
  const fairValueGap = smc.fairValueGaps
    .filter((zone) =>
      zone.direction === "bullish" &&
      zone.status !== "filled" &&
      latest.close >= zone.lower &&
      latest.close <= zone.upper * 1.05,
    )
    .sort((left, right) => right.date.getTime() - left.date.getTime())[0];
  const zone = orderBlock
    ? { type: "OB" as const, lower: orderBlock.lower, upper: orderBlock.upper }
    : fairValueGap
      ? { type: "FVG" as const, lower: fairValueGap.lower, upper: fairValueGap.upper }
      : null;
  const trigger: { type: SmcPendingPlan["triggerType"]; date: string } | null =
    validBreak ??
    (recentSweep
      ? { type: "Sweep" as const, date: toDateKey(recentSweep.date) }
      : null) ??
    (zone ? { type: "Zone" as const, date: latest.date } : null);
  if (!trigger) return null;

  const swingLow = smc.swingLow.price;
  const stopPrice = trigger.type === "Sweep" && recentSweep
    ? recentSweep.wickExtreme
    : zone?.lower ?? swingLow ?? Number.NaN;
  if (!Number.isFinite(stopPrice)) return null;
  const resistance = recentBars.slice(-60, -1)
    .map((bar) => bar.high)
    .filter((high) => high > latest.close)
    .sort((left, right) => left - right)[0];
  if (!resistance || stopPrice <= 0 || stopPrice >= latest.close) return null;
  const rewardToRisk = (resistance - latest.close) / (latest.close - stopPrice);
  return {
    triggerType: trigger.type,
    triggerDate: trigger.date,
    zoneType: zone?.type ?? "SWING",
    zoneLower: zone?.lower ?? stopPrice,
    zoneUpper: zone?.upper ?? stopPrice,
    stopPrice,
    targetPrice: resistance,
    entryPrice: latest.close,
    rewardToRisk,
    volumeRatio,
    dailyChangePercent,
    fiveDayChangePercent,
    volumeIncreased: (latest.volume ?? 0) > (previous.volume ?? Number.POSITIVE_INFINITY),
  };
}

export function passesSmcPendingSignal(plan: SmcPendingPlan): boolean {
  return getSmcPendingSignalFailureReasons(plan).length === 0;
}

export function getSmcPendingSignalFailureReasons(plan: SmcPendingPlan): string[] {
  return getSmcSignalFailureReasons(plan);
}

export function qualifiesDailyPendingBacktest(result: PendingBacktest): boolean {
  return result.sampleCount >= MINIMUM_BACKTEST_SAMPLES &&
    (result.winRatePercent ?? 0) >= 50;
}

export function countDailyPendingHistoryBars(bars: PendingBar[], asOfDate: string): number {
  const cutoff = new Date(`${asOfDate}T00:00:00Z`);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  return bars.filter((bar) => bar.date > cutoffDate && bar.date <= asOfDate).length;
}

export function calculateDailyPendingBacktest(
  bars: PendingBar[],
  asOfDate: string,
): PendingBacktest {
  let endIndex = -1;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    if (bars[index]!.date <= asOfDate) {
      endIndex = index;
      break;
    }
  }
  if (endIndex < 0) {
    return { wins: 0, losses: 0, noTouchCount: 0, sampleCount: 0, winRatePercent: null, payoffRatio: null };
  }
  const cutoff = new Date(`${asOfDate}T00:00:00Z`);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  let wins = 0;
  let losses = 0;
  let noTouchCount = 0;
  let totalWinningReturn = 0;
  let totalLosingReturn = 0;
  let lastSignalIndex = -10;

  for (let index = 20; index + 10 <= endIndex; index += 1) {
    const signalBar = bars[index]!;
    if (signalBar.date <= cutoffDate || index - lastSignalIndex < 10) continue;
    const plan = buildSmcPendingPlan(bars.slice(0, index + 1));
    if (!plan || plan.triggerDate !== signalBar.date || !passesSmcPendingSignal(plan)) continue;
    const nextBar = bars[index + 1]!;
    const entryPrice = nextBar.open;
    if (
      entryPrice <= plan.stopPrice ||
      entryPrice >= plan.targetPrice ||
      (plan.targetPrice - entryPrice) / (entryPrice - plan.stopPrice) < 2
    ) continue;
    lastSignalIndex = index;
    const winningReturn = (plan.targetPrice - entryPrice) / entryPrice;
    const losingReturn = (entryPrice - plan.stopPrice) / entryPrice;
    let settled = false;
    for (const bar of bars.slice(index + 1, index + 11)) {
      const targetHit = bar.high >= plan.targetPrice;
      const stopHit = bar.low <= plan.stopPrice;
      if (targetHit && stopHit) {
        losses += 1;
        totalLosingReturn += losingReturn;
        settled = true;
        break;
      }
      if (targetHit) {
        wins += 1;
        totalWinningReturn += winningReturn;
        settled = true;
        break;
      }
      if (stopHit) {
        losses += 1;
        totalLosingReturn += losingReturn;
        settled = true;
        break;
      }
    }
    if (!settled) noTouchCount += 1;
  }
  const sampleCount = wins + losses;
  return {
    wins,
    losses,
    noTouchCount,
    sampleCount,
    winRatePercent: sampleCount ? wins / sampleCount * 100 : null,
    payoffRatio: wins > 0 && losses > 0 && totalLosingReturn > 0
      ? (totalWinningReturn / wins) / (totalLosingReturn / losses)
      : null,
  };
}
