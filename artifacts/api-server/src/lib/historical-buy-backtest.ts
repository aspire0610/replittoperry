import type { StockAiAssessment } from "@workspace/api-zod";

type DailyOhlcBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

type BacktestSummary = StockAiAssessment["historicalStrategyBacktest"];

type SimulatedTrade = {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  netReturnPercent: number;
  exitReason: "stop_loss" | "take_profit" | "time_limit";
};

const MOVING_AVERAGE_PERIOD = 20;
const TREND_LOOKBACK = 5;
const ATR_PERIOD = 14;
const ATR_STOP_MULTIPLE = 2;
const ATR_TARGET_MULTIPLE = 2;
const EVALUATION_TRADING_DAYS = 5;
const MINIMUM_SAMPLE_COUNT = 30;
const MINIMUM_DATA_WINDOW_DAYS = 180;
const BROKERAGE_RATE_PER_SIDE = 0.001425;
const SELL_TRANSACTION_TAX_RATE = 0.003;
const WILSON_Z_SCORE = 1.96;

function simpleMovingAverage(values: number[], endIndex: number, period: number): number | null {
  if (endIndex - period + 1 < 0) return null;
  let total = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    total += values[index]!;
  }
  return total / period;
}

function calculateTrueRanges(bars: DailyOhlcBar[]): number[] {
  return bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = bars[index - 1]!.close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
}

function averageTrueRange(trueRanges: number[], endIndex: number): number | null {
  if (endIndex - ATR_PERIOD + 1 < 0) return null;
  let total = 0;
  for (let index = endIndex - ATR_PERIOD + 1; index <= endIndex; index += 1) {
    total += trueRanges[index]!;
  }
  return total / ATR_PERIOD;
}

function isValidBar(bar: DailyOhlcBar): boolean {
  return (
    Number.isFinite(Date.parse(bar.date)) &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.open > 0 &&
    bar.high > 0 &&
    bar.low > 0 &&
    bar.high >= Math.max(bar.open, bar.close, bar.low) &&
    bar.low <= Math.min(bar.open, bar.close, bar.high)
  );
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function wilsonInterval(wins: number, sampleCount: number): [number, number] {
  const proportion = wins / sampleCount;
  const zSquared = WILSON_Z_SCORE ** 2;
  const denominator = 1 + zSquared / sampleCount;
  const center =
    (proportion + zSquared / (2 * sampleCount)) / denominator;
  const margin =
    (WILSON_Z_SCORE *
      Math.sqrt(
        (proportion * (1 - proportion)) / sampleCount +
          zSquared / (4 * sampleCount ** 2),
      )) /
    denominator;
  return [
    roundPercent(Math.max(0, center - margin) * 100),
    roundPercent(Math.min(1, center + margin) * 100),
  ];
}

function simulateTrade(
  bars: DailyOhlcBar[],
  signalIndex: number,
  atr: number,
): SimulatedTrade | null {
  const entryIndex = signalIndex + 1;
  const lastIndex = entryIndex + EVALUATION_TRADING_DAYS - 1;
  if (lastIndex >= bars.length) return null;

  const entryBar = bars[entryIndex]!;
  const entryPrice = entryBar.open;
  const stopPrice = entryPrice - ATR_STOP_MULTIPLE * atr;
  const targetPrice = entryPrice + ATR_TARGET_MULTIPLE * atr;
  if (!(entryPrice > 0 && stopPrice > 0 && targetPrice > entryPrice)) return null;

  let exitPrice = bars[lastIndex]!.close;
  let exitIndex = lastIndex;
  let exitReason: SimulatedTrade["exitReason"] = "time_limit";

  for (let index = entryIndex; index <= lastIndex; index += 1) {
    const bar = bars[index]!;
    if (bar.open <= stopPrice) {
      exitPrice = bar.open;
      exitIndex = index;
      exitReason = "stop_loss";
      break;
    }

    const stopTouched = bar.low <= stopPrice;
    const targetTouched = bar.high >= targetPrice;
    if (stopTouched) {
      // Daily candles cannot reveal which level was touched first; choose the
      // adverse outcome when both the stop and target occur in one session.
      exitPrice = stopPrice;
      exitIndex = index;
      exitReason = "stop_loss";
      break;
    }
    if (targetTouched) {
      // A favorable gap is filled at the target, not at the better opening price.
      exitPrice = targetPrice;
      exitIndex = index;
      exitReason = "take_profit";
      break;
    }
  }

  const cashPaid = entryPrice * (1 + BROKERAGE_RATE_PER_SIDE);
  const cashReceived =
    exitPrice * (1 - BROKERAGE_RATE_PER_SIDE - SELL_TRANSACTION_TAX_RATE);
  const netReturnPercent = (cashReceived / cashPaid - 1) * 100;
  return {
    entryDate: entryBar.date,
    exitDate: bars[exitIndex]!.date,
    entryPrice,
    exitPrice,
    netReturnPercent,
    exitReason,
  };
}

export function simulateHistoricalBuyTrades(
  inputBars: DailyOhlcBar[],
): SimulatedTrade[] {
  const bars = inputBars.filter(isValidBar).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const closes = bars.map((bar) => bar.close);
  const trueRanges = calculateTrueRanges(bars);
  const trades: SimulatedTrade[] = [];
  const firstSignalIndex = Math.max(
    MOVING_AVERAGE_PERIOD - 1 + TREND_LOOKBACK,
    ATR_PERIOD - 1,
  );

  for (
    let signalIndex = firstSignalIndex;
    signalIndex + EVALUATION_TRADING_DAYS < bars.length;
    signalIndex += 1
  ) {
    const currentAverage = simpleMovingAverage(
      closes,
      signalIndex,
      MOVING_AVERAGE_PERIOD,
    );
    const earlierAverage = simpleMovingAverage(
      closes,
      signalIndex - TREND_LOOKBACK,
      MOVING_AVERAGE_PERIOD,
    );
    const atr = averageTrueRange(trueRanges, signalIndex);
    if (
      currentAverage === null ||
      earlierAverage === null ||
      atr === null ||
      closes[signalIndex]! <= currentAverage ||
      currentAverage <= earlierAverage
    ) {
      continue;
    }

    const trade = simulateTrade(bars, signalIndex, atr);
    if (!trade) continue;
    trades.push(trade);
    const exitIndex = bars.findIndex((bar) => bar.date === trade.exitDate);
    signalIndex = Math.max(signalIndex, exitIndex);
  }
  return trades;
}

export function calculateHistoricalStrategyBacktest(
  inputBars: DailyOhlcBar[],
  source: string,
): BacktestSummary {
  const bars = inputBars.filter(isValidBar).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const dataStartDate = bars[0]?.date ?? null;
  const dataEndDate = bars.at(-1)?.date ?? null;
  const dataWindowDays =
    dataStartDate && dataEndDate
      ? (Date.parse(`${dataEndDate}T00:00:00Z`) -
          Date.parse(`${dataStartDate}T00:00:00Z`)) /
        86_400_000
      : 0;
  const trades = simulateHistoricalBuyTrades(bars);
  const sampleCount = trades.length;
  const wins = trades.filter((trade) => trade.netReturnPercent > 0).length;
  const calibrated =
    sampleCount >= MINIMUM_SAMPLE_COUNT &&
    dataWindowDays >= MINIMUM_DATA_WINDOW_DAYS;
  const interval = calibrated ? wilsonInterval(wins, sampleCount) : null;

  return {
    status: calibrated ? "calibrated" : "insufficient_data",
    sampleCount,
    wins: calibrated ? wins : null,
    winRatePercent: calibrated
      ? roundPercent((wins / sampleCount) * 100)
      : null,
    confidenceIntervalLowPercent: interval?.[0] ?? null,
    confidenceIntervalHighPercent: interval?.[1] ?? null,
    dataStartDate: dataStartDate
      ? new Date(`${dataStartDate}T00:00:00.000Z`)
      : null,
    dataEndDate: dataEndDate
      ? new Date(`${dataEndDate}T00:00:00.000Z`)
      : null,
    minimumSampleCount: MINIMUM_SAMPLE_COUNT,
    minimumDataWindowDays: MINIMUM_DATA_WINDOW_DAYS,
    evaluationTradingDays: EVALUATION_TRADING_DAYS,
    source,
  };
}
