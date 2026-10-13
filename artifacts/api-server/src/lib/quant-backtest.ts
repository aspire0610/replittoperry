import {
  isFundOrEtf,
  type ParsedQuantMarketDay,
  type QuantMarketQuote,
} from "./quant-market-parse.js";
import {
  matchesQuantSignalRule,
  type QuantSignalRule,
} from "./quant-signal-rules.js";

export type QuantFactorWeights = {
  momentum20: number;
  momentum60: number;
  liquidity20: number;
  lowVolatility20: number;
};

export type QuantRebalance = "daily" | "weekly" | "monthly";
export type QuantWeekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday";

export type QuantTradeRecord = {
  date: string;
  ticker: string;
  name: string;
  side: "buy" | "sell";
  shares: number;
  price: number;
  slippageCost: number;
  commission: number;
  transactionTax: number;
};

export type QuantEquityPoint = {
  date: string;
  equity: number;
  taiexEquity: number;
};

export type QuantBacktestResult = {
  metrics: {
    totalReturnPercent: number;
    annualizedReturnPercent: number;
    maxDrawdownPercent: number;
    annualizedVolatilityPercent: number;
    sharpeRatio: number;
    tradeCount: number;
    closedTradeCount: number;
    winningTradeCount: number;
    winRatePercent: number | null;
    averageWinPercent: number | null;
    averageLossPercent: number | null;
    payoffRatio: number | null;
    finalEquity: number;
    contributedCapital: number;
    taiexReturnPercent: number;
  };
  equityCurve: QuantEquityPoint[];
  trades: QuantTradeRecord[];
  tradeLogTruncated: boolean;
  tradingDays: number;
  eligibleSecurities: number;
  dataStartDate: string;
  dataEndDate: string;
};

type Position = {
  ticker: string;
  name: string;
  shares: number;
  averageCost: number;
  lastClose: number;
};

type MarketBar = QuantMarketQuote & { date: string };

type TickerSeries = {
  bars: MarketBar[];
  dateIndex: Map<string, number>;
};

type FeatureRow = {
  ticker: string;
  name: string;
  momentum20: number;
  momentum60: number;
  liquidity20: number;
  lowVolatility20: number;
  volatility20: number;
};

const COMMISSION_RATE = 0.001425;
const STOCK_TRANSACTION_TAX_RATE = 0.003;
const FUND_TRANSACTION_TAX_RATE = 0.001;
const MAX_RETURNED_TRADES = 300;

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function isValidWeights(weights: QuantFactorWeights): boolean {
  const values = Object.values(weights);
  return (
    values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
    values.reduce((sum, value) => sum + value, 0) > 0
  );
}

export function normalizeFactorWeights(
  weights: QuantFactorWeights,
): QuantFactorWeights {
  if (!isValidWeights(weights)) {
    throw new Error("AI 策略因子權重無效。");
  }
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return {
    momentum20: weights.momentum20 / total,
    momentum60: weights.momentum60 / total,
    liquidity20: weights.liquidity20 / total,
    lowVolatility20: weights.lowVolatility20 / total,
  };
}

function isValidQuote(quote: QuantMarketQuote): boolean {
  return (
    quote.close > 0 &&
    quote.open > 0 &&
    quote.turnover > 0 &&
    Number.isFinite(quote.close) &&
    Number.isFinite(quote.open) &&
    Number.isFinite(quote.turnover)
  );
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function featuresAt(
  ticker: string,
  bars: MarketBar[],
  dateIndex: Map<string, number>,
  signalDate: string,
): FeatureRow | null {
  const currentIndex = dateIndex.get(signalDate);
  if (currentIndex === undefined || currentIndex < 60) return null;
  const current = bars[currentIndex]!;
  const close20 = bars[currentIndex - 20]!.close;
  const close60 = bars[currentIndex - 60]!.close;
  if (close20 <= 0 || close60 <= 0) return null;

  const returns: number[] = [];
  let totalTurnover = 0;
  for (let index = currentIndex - 19; index <= currentIndex; index += 1) {
    const previous = bars[index - 1]!;
    const bar = bars[index]!;
    if (previous.close <= 0 || !isValidQuote(bar)) return null;
    returns.push(bar.close / previous.close - 1);
    totalTurnover += bar.turnover;
  }

  const volatility20 = standardDeviation(returns);
  return {
    ticker,
    name: current.name,
    momentum20: current.close / close20 - 1,
    momentum60: current.close / close60 - 1,
    liquidity20: totalTurnover / 20,
    lowVolatility20: -volatility20,
    volatility20,
  };
}

function percentileScores(
  rows: FeatureRow[],
  key: keyof Omit<FeatureRow, "ticker" | "name">,
): Map<string, number> {
  const sorted = [...rows].sort(
    (left, right) =>
      left[key] - right[key] || left.ticker.localeCompare(right.ticker),
  );
  const scores = new Map<string, number>();
  if (sorted.length === 1) {
    scores.set(sorted[0]!.ticker, 0.5);
    return scores;
  }

  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (
      end + 1 < sorted.length &&
      sorted[end + 1]![key] === sorted[start]![key]
    ) {
      end += 1;
    }
    const score = ((start + end) / 2) / (sorted.length - 1);
    for (let index = start; index <= end; index += 1) {
      scores.set(sorted[index]!.ticker, score);
    }
    start = end + 1;
  }
  return scores;
}

function factorRank(
  snapshotsByTicker: Map<string, TickerSeries>,
  signalDate: string,
  weights: QuantFactorWeights,
  topN: number,
  executionQuotes: Map<string, QuantMarketQuote>,
  entryRule: QuantSignalRule,
  excludedTickers: Set<string>,
): FeatureRow[] {
  const rows: FeatureRow[] = [];
  for (const [ticker, series] of snapshotsByTicker) {
    const feature = featuresAt(
      ticker,
      series.bars,
      series.dateIndex,
      signalDate,
    );
    if (
      feature &&
      executionQuotes.has(ticker) &&
      !excludedTickers.has(ticker) &&
      matchesQuantSignalRule(entryRule, feature)
    ) {
      rows.push(feature);
    }
  }
  if (!rows.length) return [];

  const momentum20 = percentileScores(rows, "momentum20");
  const momentum60 = percentileScores(rows, "momentum60");
  const liquidity20 = percentileScores(rows, "liquidity20");
  const lowVolatility20 = percentileScores(rows, "lowVolatility20");
  return rows
    .map((row) => ({
      ...row,
      score:
        weights.momentum20 * (momentum20.get(row.ticker) ?? 0) +
        weights.momentum60 * (momentum60.get(row.ticker) ?? 0) +
        weights.liquidity20 * (liquidity20.get(row.ticker) ?? 0) +
        weights.lowVolatility20 * (lowVolatility20.get(row.ticker) ?? 0),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.ticker.localeCompare(right.ticker),
    )
    .slice(0, topN);
}

function rebalanceBucket(date: string, rebalance: QuantRebalance): string {
  if (rebalance === "daily") return date;
  if (rebalance === "monthly") return date.slice(0, 7);
  const day = new Date(`${date}T00:00:00.000Z`);
  const weekday = day.getUTCDay();
  day.setUTCDate(day.getUTCDate() - ((weekday + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function costForTrade(
  quote: QuantMarketQuote,
  shares: number,
  side: "buy" | "sell",
  slippageRate: number,
  costMultiplier: number,
): { gross: number; executionPrice: number; slippageCost: number; commission: number; transactionTax: number } {
  const executionPrice = quote.open * (1 + (side === "buy" ? 1 : -1) * slippageRate * costMultiplier);
  const gross = roundMoney(executionPrice * shares);
  return {
    gross,
    executionPrice,
    slippageCost: roundMoney(Math.abs(executionPrice - quote.open) * shares),
    commission: roundMoney(gross * COMMISSION_RATE * costMultiplier),
    transactionTax: roundMoney(
      gross *
        (isFundOrEtf(quote.symbol)
          ? FUND_TRANSACTION_TAX_RATE
          : STOCK_TRANSACTION_TAX_RATE) * costMultiplier,
    ),
  };
}

function executeSell(
  date: string,
  position: Position,
  shares: number,
  quote: QuantMarketQuote,
  cash: { value: number },
  positions: Map<string, Position>,
  trades: QuantTradeRecord[],
  slippageRate: number,
  costMultiplier: number,
): void {
  if (shares <= 0) return;
  const costs = costForTrade(quote, shares, "sell", slippageRate, costMultiplier);
  cash.value = roundMoney(
    cash.value + costs.gross - costs.commission - costs.transactionTax,
  );
  trades.push({
    date,
    ticker: quote.ticker,
    name: quote.name,
    side: "sell",
    shares,
    price: costs.executionPrice,
    slippageCost: costs.slippageCost,
    commission: costs.commission,
    transactionTax: costs.transactionTax,
  });
  const remaining = position.shares - shares;
  if (remaining <= 0) {
    positions.delete(position.ticker);
  } else {
    positions.set(position.ticker, { ...position, shares: remaining });
  }
}

function executeBuy(
  date: string,
  position: Position | undefined,
  quote: QuantMarketQuote,
  requestedShares: number,
  cash: { value: number },
  positions: Map<string, Position>,
  trades: QuantTradeRecord[],
  slippageRate: number,
  costMultiplier: number,
): void {
  const affordableShares = Math.floor(
    cash.value /
      (quote.open * (1 + slippageRate * costMultiplier) *
        (1 + COMMISSION_RATE * costMultiplier)),
  );
  const shares = Math.min(requestedShares, affordableShares);
  if (shares <= 0) return;

  const costs = costForTrade(quote, shares, "buy", slippageRate, costMultiplier);
  const totalCost = roundMoney(costs.gross + costs.commission);
  cash.value = roundMoney(cash.value - totalCost);
  const priorShares = position?.shares ?? 0;
  const averageCost =
    (priorShares * (position?.averageCost ?? 0) + totalCost) /
    (priorShares + shares);
  positions.set(quote.ticker, {
    ticker: quote.ticker,
    name: quote.name,
    shares: priorShares + shares,
    averageCost,
    lastClose: position?.lastClose ?? quote.open,
  });
  trades.push({
    date,
    ticker: quote.ticker,
    name: quote.name,
    side: "buy",
    shares,
    price: costs.executionPrice,
    slippageCost: costs.slippageCost,
    commission: costs.commission,
    transactionTax: 0,
  });
}

function rebalancePortfolio(
  date: string,
  signalDate: string,
  weights: QuantFactorWeights,
  topN: number,
  entryRule: QuantSignalRule,
  exitRule: QuantSignalRule,
  snapshotQuotes: Map<string, QuantMarketQuote>,
  tickerSeries: Map<string, TickerSeries>,
  cash: { value: number },
  positions: Map<string, Position>,
  trades: QuantTradeRecord[],
  slippageRate: number,
  costMultiplier: number,
  sharesPerEntry: number | null,
): void {
  const exitedTickers = new Set<string>();
  for (const position of [...positions.values()]) {
    const series = tickerSeries.get(position.ticker);
    const quote = snapshotQuotes.get(position.ticker);
    if (!series || !quote) continue;
    const feature = featuresAt(
      position.ticker,
      series.bars,
      series.dateIndex,
      signalDate,
    );
    if (!feature || !matchesQuantSignalRule(exitRule, feature)) continue;
    executeSell(date, position, position.shares, quote, cash, positions, trades, slippageRate, costMultiplier);
    exitedTickers.add(position.ticker);
  }

  if (sharesPerEntry !== null) {
    for (const position of [...positions.values()]) {
      const series = tickerSeries.get(position.ticker);
      const quote = snapshotQuotes.get(position.ticker);
      if (!series || !quote) continue;
      const feature = featuresAt(position.ticker, series.bars, series.dateIndex, signalDate);
      if (feature && matchesQuantSignalRule(entryRule, feature)) {
        executeBuy(date, position, quote, sharesPerEntry, cash, positions, trades, slippageRate, costMultiplier);
      }
    }
  }

  const availableSlots = Math.max(0, topN - positions.size);
  if (availableSlots === 0) return;
  const excludedTickers = new Set([
    ...positions.keys(),
    ...exitedTickers,
  ]);
  const targets = factorRank(
    tickerSeries,
    signalDate,
    weights,
    availableSlots,
    snapshotQuotes,
    entryRule,
    excludedTickers,
  );
  if (!targets.length) return;

  const portfolioValueAtOpen = [...positions.values()].reduce(
    (total, position) => {
      const quote = snapshotQuotes.get(position.ticker);
      return (
        total + position.shares * (quote?.open ?? position.lastClose)
      );
    },
    cash.value,
  );
  const slotCapital = portfolioValueAtOpen / topN;

  for (const target of targets) {
    const quote = snapshotQuotes.get(target.ticker);
    if (!quote || quote.open <= 0) continue;
    const targetShares = sharesPerEntry ?? Math.floor(
      slotCapital /
        (quote.open * (1 + slippageRate * costMultiplier) *
          (1 + COMMISSION_RATE * costMultiplier)),
    );
    executeBuy(date, undefined, quote, targetShares, cash, positions, trades, slippageRate, costMultiplier);
  }
}

function dailyBenchmark(
  snapshotByDate: Map<string, Map<string, QuantMarketQuote>>,
  benchmarkByDate: Map<string, number>,
  dates: string[],
  evaluationDates: string[],
  startingCapital: number,
): Map<string, number> {
  const firstBenchmark = evaluationDates
    .map((date) => benchmarkByDate.get(date))
    .find((value): value is number => value !== undefined && value > 0);
  if (!firstBenchmark) {
    throw new Error("TWSE historical index values are unavailable for this period.");
  }

  const result = new Map<string, number>();
  let latestBenchmark = firstBenchmark;
  for (const date of dates) {
    const current = benchmarkByDate.get(date);
    if (current && current > 0) latestBenchmark = current;
    if (date >= evaluationDates[0]!) {
      result.set(date, (latestBenchmark / firstBenchmark) * startingCapital);
    }
  }
  void snapshotByDate;
  return result;
}

function weekdayNumber(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function weekStart(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  const offset = value.getUTCDay() === 0 ? 6 : value.getUTCDay() - 1;
  value.setUTCDate(value.getUTCDate() - offset);
  return value.toISOString().slice(0, 10);
}

function scheduledContributionDates(
  dates: string[],
  startDate: string,
  weekday: QuantWeekday,
): Set<string> {
  const wanted = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    .indexOf(weekday);
  const weeks = new Map<string, string[]>();
  for (const date of dates) {
    if (date < startDate) continue;
    const key = weekStart(date);
    weeks.set(key, [...(weeks.get(key) ?? []), date]);
  }
  const scheduled = new Set<string>();
  for (const weekDates of weeks.values()) {
    const exactDate = weekDates.find((date) => weekdayNumber(date) === wanted);
    if (exactDate) {
      scheduled.add(exactDate);
      continue;
    }
    const firstTradingDate = weekDates[0];
    if (firstTradingDate && weekdayNumber(firstTradingDate) < wanted) {
      const rolledDate = weekDates.find((date) => weekdayNumber(date) > wanted);
      if (rolledDate) scheduled.add(rolledDate);
    }
  }
  return scheduled;
}

function recurringBenchmark(
  dates: string[],
  benchmarkByDate: Map<string, number>,
  startDate: string,
  purchaseDates: Set<string>,
  amount: number,
  totalContributionLimit?: number | null,
): Map<string, number> {
  const result = new Map<string, number>();
  let units = 0;
  let latestBenchmark = 0;
  let contributed = 0;
  for (const date of dates) {
    const quote = benchmarkByDate.get(date);
    if (quote && quote > 0) latestBenchmark = quote;
    if (purchaseDates.has(date) && latestBenchmark > 0) {
      const contribution = Math.min(
        amount,
        totalContributionLimit == null
          ? amount
          : Math.max(0, totalContributionLimit - contributed),
      );
      if (contribution > 0) {
        units += contribution / latestBenchmark;
        contributed += contribution;
      }
    }
    if (date >= startDate && latestBenchmark > 0) {
      result.set(date, units * latestBenchmark);
    }
  }
  return result;
}

export function calculateQuantBacktest(input: {
  snapshots: ParsedQuantMarketDay[];
  requestedStartDate: string;
  startingCapital: number;
  topN: number;
  rebalance: QuantRebalance;
  factorWeights: QuantFactorWeights;
  entryRule: QuantSignalRule;
  exitRule: QuantSignalRule;
  tickerFilter?: string | null;
  requestedEndDate?: string;
  slippageRate?: number;
  costMultiplier?: number;
  sharesPerEntry?: number | null;
  recurringContribution?: {
    amount: number;
    weekday: QuantWeekday;
    totalContributionLimit?: number | null;
  };
}): QuantBacktestResult {
  const weights = normalizeFactorWeights(input.factorWeights);
  const slippageRate = input.slippageRate ?? 0.001;
  const costMultiplier = input.costMultiplier ?? 1;
  const sharesPerEntry = input.sharesPerEntry ?? null;
  const recurringContribution = input.recurringContribution ?? null;
  if (
    !Number.isFinite(input.startingCapital) ||
    input.startingCapital <= 0 ||
    !Number.isInteger(input.topN) ||
    input.topN < 1 ||
    !Number.isFinite(slippageRate) ||
    slippageRate < 0 ||
    slippageRate > 0.05 ||
    !Number.isFinite(costMultiplier) ||
    costMultiplier < 1 ||
    costMultiplier > 5 ||
    (sharesPerEntry !== null &&
      (!Number.isInteger(sharesPerEntry) || sharesPerEntry < 1 || sharesPerEntry > 100000))
    ||
    (recurringContribution !== null &&
      (!Number.isFinite(recurringContribution.amount) ||
        recurringContribution.amount <= 0))
  ) {
    throw new Error("回測本金或持股檔數無效。");
  }
  if (recurringContribution && !input.tickerFilter) {
    throw new Error("定期投入回測必須指定單一股票或 ETF 標的。");
  }

  const snapshotsByDate = new Map<string, Map<string, QuantMarketQuote>>();
  const benchmarkByDate = new Map<string, number>();
  const tickerBars = new Map<string, MarketBar[]>();
  let twseRows = 0;
  let tpexRows = 0;

  for (const snapshot of input.snapshots) {
    let dayQuotes = snapshotsByDate.get(snapshot.date);
    if (!dayQuotes) {
      dayQuotes = new Map<string, QuantMarketQuote>();
      snapshotsByDate.set(snapshot.date, dayQuotes);
    }
    if (snapshot.exchange === "twse" && snapshot.benchmarkClose) {
      benchmarkByDate.set(snapshot.date, snapshot.benchmarkClose);
    }
    for (const quote of snapshot.quotes) {
      if (!isValidQuote(quote)) continue;
      if (input.tickerFilter && quote.ticker !== input.tickerFilter) continue;
      dayQuotes.set(quote.ticker, quote);
      const series = tickerBars.get(quote.ticker) ?? [];
      series.push({ ...quote, date: snapshot.date });
      tickerBars.set(quote.ticker, series);
      if (quote.exchange === "twse") twseRows += 1;
      else tpexRows += 1;
    }
  }

  for (const series of tickerBars.values()) {
    series.sort((left, right) => left.date.localeCompare(right.date));
  }
  const tickerSeries = new Map<string, TickerSeries>();
  for (const [ticker, bars] of tickerBars) {
    tickerSeries.set(ticker, {
      bars,
      dateIndex: new Map(bars.map((bar, index) => [bar.date, index])),
    });
  }

  const dates = [...snapshotsByDate.keys()]
    .filter(
      (date) =>
        (snapshotsByDate.get(date)?.size ?? 0) > 0 ||
        Boolean(input.tickerFilter && benchmarkByDate.has(date)),
    )
    .sort((left, right) => left.localeCompare(right))
    .filter((date) => !input.requestedEndDate || date <= input.requestedEndDate);
  const evaluationDates = dates.filter(
    (date) => date >= input.requestedStartDate,
  );
  if (evaluationDates.length < 20) {
    throw new Error("官方日行情不足 20 個交易日，無法形成有效回測。");
  }

  const contributionDates = recurringContribution
    ? scheduledContributionDates(
        dates,
        input.requestedStartDate,
        recurringContribution.weekday,
      )
    : null;
  const benchmarkEquity = recurringContribution && contributionDates
    ? recurringBenchmark(
        dates,
        benchmarkByDate,
        input.requestedStartDate,
        contributionDates,
        recurringContribution.amount,
        recurringContribution.totalContributionLimit,
      )
    : dailyBenchmark(
        snapshotsByDate,
        benchmarkByDate,
        dates,
        evaluationDates,
        input.startingCapital,
      );
  const cash = { value: recurringContribution ? 0 : input.startingCapital };
  let contributedCapital = recurringContribution ? 0 : input.startingCapital;
  const positions = new Map<string, Position>();
  const trades: QuantTradeRecord[] = [];
  const equityCurve: QuantEquityPoint[] = [];
  let priorRebalanceBucket: string | null = null;
  let hasRebalanced = false;

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index]!;
    const quotes = snapshotsByDate.get(date)!;

    if (
      date >= input.requestedStartDate &&
      (index > 0 || recurringContribution !== null)
    ) {
      if (recurringContribution && contributionDates?.has(date)) {
        const contribution = Math.min(
          recurringContribution.amount,
          recurringContribution.totalContributionLimit == null
            ? recurringContribution.amount
            : Math.max(
                0,
                recurringContribution.totalContributionLimit -
                  contributedCapital,
              ),
        );
        if (contribution > 0) {
          contributedCapital += contribution;
          cash.value = roundMoney(cash.value + contribution);
          const quote = quotes.get(input.tickerFilter!);
          if (quote && quote.open > 0) {
            const position = positions.get(quote.ticker);
            const totalCostPerShare =
              quote.open *
              (1 + slippageRate * costMultiplier) *
              (1 + COMMISSION_RATE * costMultiplier);
            executeBuy(
              date,
              position,
              quote,
              Math.floor(cash.value / totalCostPerShare),
              cash,
              positions,
              trades,
              slippageRate,
              costMultiplier,
            );
          }
        }
      } else if (!recurringContribution) {
        const bucket = rebalanceBucket(date, input.rebalance);
        if (!hasRebalanced || bucket !== priorRebalanceBucket) {
        rebalancePortfolio(
          date,
          dates[index - 1]!,
          weights,
          input.topN,
          input.entryRule,
          input.exitRule,
          quotes,
          tickerSeries,
          cash,
          positions,
          trades,
          slippageRate,
          costMultiplier,
          sharesPerEntry,
        );
        hasRebalanced = true;
        priorRebalanceBucket = bucket;
        }
      }
    }

    for (const position of positions.values()) {
      const quote = quotes.get(position.ticker);
      if (quote && quote.close > 0) {
        position.lastClose = quote.close;
        position.name = quote.name;
      }
    }

    if (date < input.requestedStartDate) continue;
    const equity =
      cash.value +
      [...positions.values()].reduce(
        (total, position) => total + position.shares * position.lastClose,
        0,
      );
    const taiexEquity = benchmarkEquity.get(date);
    if (taiexEquity === undefined) continue;
    equityCurve.push({
      date,
      equity: roundMoney(equity),
      taiexEquity: roundMoney(taiexEquity),
    });
  }

  if (equityCurve.length < 20) {
    throw new Error("回測期間的有效上市櫃行情不足。");
  }
  const first = equityCurve[0]!;
  const last = equityCurve.at(-1)!;
  const returnBasis = contributedCapital;
  const totalReturnPercent =
    returnBasis > 0 ? ((last.equity / returnBasis) - 1) * 100 : 0;
  const elapsedSessions = Math.max(1, equityCurve.length - 1);
  const annualizedReturnPercent =
    last.equity > 0 && returnBasis > 0
      ? (Math.pow(last.equity / returnBasis, 252 / elapsedSessions) -
          1) *
        100
      : -100;

  const dailyReturns = equityCurve.slice(1).map((point, index) => {
    const previous = equityCurve[index]!.equity;
    return previous > 0 ? point.equity / previous - 1 : 0;
  });
  const meanDailyReturn =
    dailyReturns.length > 0
      ? dailyReturns.reduce((sum, value) => sum + value, 0) /
        dailyReturns.length
      : 0;
  const dailyVolatility = standardDeviation(dailyReturns);
  let peak = first.equity;
  let maximumDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      maximumDrawdown = Math.max(
        maximumDrawdown,
        (peak - point.equity) / peak,
      );
    }
  }
  const firstTaiex = first.taiexEquity;
  const lastTaiex = last.taiexEquity;
  const openLots = new Map<string, { shares: number; cost: number }>();
  let closedTradeCount = 0;
  let winningTradeCount = 0;
  const winningReturns: number[] = [];
  const losingReturns: number[] = [];
  for (const trade of trades) {
    const lot = openLots.get(trade.ticker) ?? { shares: 0, cost: 0 };
    if (trade.side === "buy") {
      lot.shares += trade.shares;
      lot.cost += trade.price * trade.shares + trade.commission;
      openLots.set(trade.ticker, lot);
    } else if (lot.shares > 0) {
      const soldShares = Math.min(lot.shares, trade.shares);
      const allocatedCost = lot.cost * (soldShares / lot.shares);
      const proceeds =
        trade.price * soldShares - trade.commission - trade.transactionTax;
      lot.shares -= soldShares;
      lot.cost -= allocatedCost;
      if (lot.shares === 0) {
        closedTradeCount += 1;
        const returnPercent = allocatedCost > 0
          ? ((proceeds - allocatedCost) / allocatedCost) * 100
          : 0;
        if (returnPercent > 0) {
          winningTradeCount += 1;
          winningReturns.push(returnPercent);
        } else if (returnPercent < 0) {
          losingReturns.push(returnPercent);
        }
        openLots.delete(trade.ticker);
      } else {
        openLots.set(trade.ticker, lot);
      }
    }
  }

  return {
    metrics: {
      totalReturnPercent,
      annualizedReturnPercent,
      maxDrawdownPercent: maximumDrawdown * 100,
      annualizedVolatilityPercent: dailyVolatility * Math.sqrt(252) * 100,
      sharpeRatio:
        dailyVolatility > 0
          ? (meanDailyReturn / dailyVolatility) * Math.sqrt(252)
          : 0,
      tradeCount: trades.length,
      closedTradeCount,
      winningTradeCount,
      winRatePercent:
        closedTradeCount > 0 ? (winningTradeCount / closedTradeCount) * 100 : null,
      averageWinPercent: winningReturns.length
        ? winningReturns.reduce((sum, value) => sum + value, 0) / winningReturns.length
        : null,
      averageLossPercent: losingReturns.length
        ? losingReturns.reduce((sum, value) => sum + value, 0) / losingReturns.length
        : null,
      payoffRatio:
        winningReturns.length && losingReturns.length
          ? (winningReturns.reduce((sum, value) => sum + value, 0) / winningReturns.length) /
            Math.abs(losingReturns.reduce((sum, value) => sum + value, 0) / losingReturns.length)
          : null,
      finalEquity: last.equity,
      contributedCapital: roundMoney(contributedCapital),
      taiexReturnPercent:
        recurringContribution && returnBasis > 0
          ? (lastTaiex / returnBasis - 1) * 100
          : firstTaiex > 0
            ? (lastTaiex / firstTaiex - 1) * 100
            : 0,
    },
    equityCurve: equityCurve.slice(-400),
    trades: trades.slice(-MAX_RETURNED_TRADES),
    tradeLogTruncated: trades.length > MAX_RETURNED_TRADES,
    tradingDays: evaluationDates.length,
    eligibleSecurities: tickerBars.size,
    dataStartDate: evaluationDates[0]!,
    dataEndDate: evaluationDates.at(-1)!,
  };
}
