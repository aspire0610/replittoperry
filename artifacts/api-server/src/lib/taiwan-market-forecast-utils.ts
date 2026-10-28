export type TaiexDailyBar = {
  date: string;
  open: number;
  close: number;
};

export type MarketDirection = "bullish" | "bearish" | "neutral";

export type DirectionBacktest = {
  direction: Exclude<MarketDirection, "neutral">;
  sampleCount: number;
  correctCount: number;
  hitRatePercent: number | null;
  lowerBound95Percent: number | null;
};

export type TaiwanMarketForecastEvidence = {
  source: string;
  latestDate: string;
  latestClose: number;
  dailyChangePercent: number | null;
  fiveDayReturnPercent: number | null;
  twentyDayReturnPercent: number | null;
  ma20: number | null;
  ma60: number | null;
  aboveMa20: boolean | null;
  ma20AboveMa60: boolean | null;
  ruleDirection: MarketDirection;
  ruleScore: number;
  ruleSummary: string;
  nextOpenBacktest: DirectionBacktest | null;
  fiveDayBacktest: DirectionBacktest | null;
  minimumSamplesForDisplay: number;
  targetDefinition: string;
};

const MINIMUM_SAMPLES_FOR_DISPLAY = 20;

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function returnPercent(current: number | undefined, reference: number | undefined): number | null {
  if (
    current === undefined ||
    reference === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(reference) ||
    reference <= 0
  ) return null;
  return ((current - reference) / reference) * 100;
}

function scoreAt(bars: TaiexDailyBar[], index: number): number | null {
  if (index < 60) return null;
  const close = bars[index]?.close;
  const ma20 = mean(bars.slice(index - 19, index + 1).map((bar) => bar.close));
  const ma60 = mean(bars.slice(index - 59, index + 1).map((bar) => bar.close));
  const fiveDayReturn = returnPercent(close, bars[index - 5]?.close);
  const twentyDayReturn = returnPercent(close, bars[index - 20]?.close);
  if (
    close === undefined ||
    ma20 === null ||
    ma60 === null ||
    fiveDayReturn === null ||
    twentyDayReturn === null
  ) return null;

  return [
    close > ma20,
    ma20 > ma60,
    fiveDayReturn > 0,
    twentyDayReturn > 0,
  ].reduce((score, passed) => score + (passed ? 1 : -1), 0);
}

function directionForScore(score: number | null): MarketDirection {
  if (score === null || score === 0) return "neutral";
  return score > 0 ? "bullish" : "bearish";
}

function wilsonLowerBoundPercent(successes: number, samples: number): number | null {
  if (!samples) return null;
  const z = 1.959963984540054;
  const rate = successes / samples;
  const denominator = 1 + (z * z) / samples;
  const center = (rate + (z * z) / (2 * samples)) / denominator;
  const margin = (z * Math.sqrt(
    (rate * (1 - rate)) / samples +
      (z * z) / (4 * samples * samples),
  )) / denominator;
  return Math.max(0, center - margin) * 100;
}

function runBacktest(
  bars: TaiexDailyBar[],
  direction: Exclude<MarketDirection, "neutral">,
  horizon: "next_open" | "five_day_close",
): DirectionBacktest {
  let sampleCount = 0;
  let correctCount = 0;
  const forwardDays = horizon === "next_open" ? 1 : 5;

  for (let index = 60; index + forwardDays < bars.length; index += 1) {
    const score = scoreAt(bars, index);
    if (directionForScore(score) !== direction) continue;

    const current = bars[index]!;
    const future = bars[index + forwardDays]!;
    const actualDirection = horizon === "next_open"
      ? future.open > current.close
        ? "bullish"
        : future.open < current.close
          ? "bearish"
          : "neutral"
      : future.close > current.close
        ? "bullish"
        : future.close < current.close
          ? "bearish"
          : "neutral";
    if (actualDirection === "neutral") continue;
    sampleCount += 1;
    if (actualDirection === direction) correctCount += 1;
  }

  return {
    direction,
    sampleCount,
    correctCount,
    hitRatePercent: sampleCount >= MINIMUM_SAMPLES_FOR_DISPLAY
      ? (correctCount / sampleCount) * 100
      : null,
    lowerBound95Percent: sampleCount >= MINIMUM_SAMPLES_FOR_DISPLAY
      ? wilsonLowerBoundPercent(correctCount, sampleCount)
      : null,
  };
}

export function calculateTaiwanMarketForecastEvidence(
  inputBars: TaiexDailyBar[],
  source = "TWSE 官方加權指數日線",
): TaiwanMarketForecastEvidence | null {
  const bars = inputBars.filter((bar) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(bar.date) &&
    [bar.open, bar.close].every((value) => Number.isFinite(value) && value > 0),
  );
  const index = bars.length - 1;
  if (index < 60) return null;

  const latest = bars[index]!;
  const previous = bars[index - 1]!;
  const latestClose = latest.close;
  const ma20 = mean(bars.slice(index - 19, index + 1).map((bar) => bar.close));
  const ma60 = mean(bars.slice(index - 59, index + 1).map((bar) => bar.close));
  const fiveDayReturnPercent = returnPercent(latestClose, bars[index - 5]?.close);
  const twentyDayReturnPercent = returnPercent(latestClose, bars[index - 20]?.close);
  const dailyChangePercent = returnPercent(latestClose, previous.close);
  const score = scoreAt(bars, index);
  if (ma20 === null || ma60 === null || score === null) return null;

  const ruleDirection = directionForScore(score);
  const direction = ruleDirection === "neutral" ? null : ruleDirection;
  const nextOpenBacktest = direction
    ? runBacktest(bars, direction, "next_open")
    : null;
  const fiveDayBacktest = direction
    ? runBacktest(bars, direction, "five_day_close")
    : null;
  const passed = [
    latestClose > ma20,
    ma20 > ma60,
    (fiveDayReturnPercent ?? 0) > 0,
    (twentyDayReturnPercent ?? 0) > 0,
  ].filter(Boolean).length;

  return {
    source,
    latestDate: latest.date,
    latestClose,
    dailyChangePercent,
    fiveDayReturnPercent,
    twentyDayReturnPercent,
    ma20,
    ma60,
    aboveMa20: latestClose > ma20,
    ma20AboveMa60: ma20 > ma60,
    ruleDirection,
    ruleScore: score,
    ruleSummary: `4項等權規則（收盤>20MA、20MA>60MA、近5日報酬>0、近20日報酬>0）符合${passed}/4；方向需分數至少+2或至多-2，否則中性。`,
    nextOpenBacktest,
    fiveDayBacktest,
    minimumSamplesForDisplay: MINIMUM_SAMPLES_FOR_DISPLAY,
    targetDefinition: "隔日開盤相對訊號日收盤；五日收盤相對訊號日收盤。歷史測試逐日使用當時可得資料，不含消息面。",
  };
}
