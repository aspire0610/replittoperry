import type { StockAiAssessment } from "@workspace/api-zod";

export type DailyOhlcBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type SmcAnalysis = StockAiAssessment["smcAnalysis"];

type SwingPoint = {
  index: number;
  date: string;
  price: number;
  side: "high" | "low";
};

type BreakEvent = {
  index: number;
  date: string;
  level: number;
  kind: NonNullable<SmcAnalysis["latestBreak"]["kind"]>;
};

const PIVOT_RADIUS = 2;
const MAX_ANALYSIS_BARS = 120;
const MIN_ANALYSIS_BARS = 20;
const LIQUIDITY_LOOKBACK_BARS = 60;

function roundPrice(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function apiDate(value: string | null): Date | null {
  if (value === null) return null;
  return new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`);
}

function isValidBar(bar: DailyOhlcBar): boolean {
  return (
    typeof bar.date === "string" &&
    bar.date.length > 0 &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.open > 0 &&
    bar.high > 0 &&
    bar.low > 0 &&
    bar.close > 0 &&
    bar.high >= Math.max(bar.open, bar.close, bar.low) &&
    bar.low <= Math.min(bar.open, bar.close, bar.high)
  );
}

function emptySmcAnalysis(
  sourceDate: string | null,
  barsUsed: number,
  notes: string,
): SmcAnalysis {
  return {
    status: "insufficient",
    timeframe: "daily",
    sourceDate: apiDate(sourceDate),
    barsUsed,
    structure: "insufficient",
    swingHigh: { price: null, date: null },
    swingLow: { price: null, date: null },
    latestBreak: { kind: null, date: null, level: null },
    liquiditySweeps: [],
    liquidityPools: [],
    candidateOrderBlocks: [],
    fairValueGaps: [],
    notes,
  };
}

function findConfirmedSwings(bars: DailyOhlcBar[]): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (
    let index = PIVOT_RADIUS;
    index < bars.length - PIVOT_RADIUS;
    index += 1
  ) {
    const bar = bars[index];
    const neighbours = [
      ...bars.slice(index - PIVOT_RADIUS, index),
      ...bars.slice(index + 1, index + PIVOT_RADIUS + 1),
    ];
    if (neighbours.every((neighbour) => bar.high > neighbour.high)) {
      swings.push({
        index,
        date: bar.date,
        price: bar.high,
        side: "high",
      });
    }
    if (neighbours.every((neighbour) => bar.low < neighbour.low)) {
      swings.push({
        index,
        date: bar.date,
        price: bar.low,
        side: "low",
      });
    }
  }

  return swings.sort((left, right) => left.index - right.index);
}

function swingsKnownBefore(
  swings: SwingPoint[],
  barIndexExclusive: number,
  side: SwingPoint["side"],
): SwingPoint[] {
  return swings.filter(
    (swing) =>
      swing.side === side && swing.index + PIVOT_RADIUS < barIndexExclusive,
  );
}

function structureAt(
  swings: SwingPoint[],
  barIndexExclusive: number,
): SmcAnalysis["structure"] {
  const highs = swingsKnownBefore(swings, barIndexExclusive, "high").slice(-2);
  const lows = swingsKnownBefore(swings, barIndexExclusive, "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "developing";

  const higherHighs = highs[1].price > highs[0].price;
  const higherLows = lows[1].price > lows[0].price;
  const lowerHighs = highs[1].price < highs[0].price;
  const lowerLows = lows[1].price < lows[0].price;

  if (higherHighs && higherLows) return "bullish";
  if (lowerHighs && lowerLows) return "bearish";
  return "range";
}

function findBreakEvents(
  bars: DailyOhlcBar[],
  swings: SwingPoint[],
): BreakEvent[] {
  const events: BreakEvent[] = [];

  for (let index = 1; index < bars.length; index += 1) {
    const previousClose = bars[index - 1].close;
    const bar = bars[index];
    const priorStructure = structureAt(swings, index);
    const priorHigh = swingsKnownBefore(swings, index, "high").at(-1);
    const priorLow = swingsKnownBefore(swings, index, "low").at(-1);

    if (
      priorHigh &&
      previousClose <= priorHigh.price &&
      bar.close > priorHigh.price
    ) {
      const kind =
        priorStructure === "bearish"
          ? "bullish_choch"
          : priorStructure === "bullish"
            ? "bullish_bos"
            : "bullish_break";
      events.push({
        index,
        date: bar.date,
        level: priorHigh.price,
        kind,
      });
    }

    if (
      priorLow &&
      previousClose >= priorLow.price &&
      bar.close < priorLow.price
    ) {
      const kind =
        priorStructure === "bullish"
          ? "bearish_choch"
          : priorStructure === "bearish"
            ? "bearish_bos"
            : "bearish_break";
      events.push({
        index,
        date: bar.date,
        level: priorLow.price,
        kind,
      });
    }
  }

  return events.sort((left, right) => left.index - right.index);
}

function findLiquiditySweeps(
  bars: DailyOhlcBar[],
  swings: SwingPoint[],
): SmcAnalysis["liquiditySweeps"] {
  const sweeps: SmcAnalysis["liquiditySweeps"] = [];
  const firstIndex = Math.max(1, bars.length - LIQUIDITY_LOOKBACK_BARS);

  for (let index = firstIndex; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1].close;
    const high = swingsKnownBefore(swings, index, "high").at(-1);
    const low = swingsKnownBefore(swings, index, "low").at(-1);

    if (
      high &&
      previousClose <= high.price &&
      bar.high > high.price &&
      bar.close < high.price
    ) {
      sweeps.push({
        side: "buy_side",
        date: apiDate(bar.date)!,
        level: roundPrice(high.price),
        wickExtreme: roundPrice(bar.high),
        close: roundPrice(bar.close),
      });
    }
    if (
      low &&
      previousClose >= low.price &&
      bar.low < low.price &&
      bar.close > low.price
    ) {
      sweeps.push({
        side: "sell_side",
        date: apiDate(bar.date)!,
        level: roundPrice(low.price),
        wickExtreme: roundPrice(bar.low),
        close: roundPrice(bar.close),
      });
    }
  }

  return sweeps.slice(-3).reverse();
}

function averageTrueRange(bars: DailyOhlcBar[]): number | null {
  const ranges: number[] = [];
  const start = Math.max(1, bars.length - 14);
  for (let index = Math.max(1, start); index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1].close;
    ranges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previousClose),
        Math.abs(bar.low - previousClose),
      ),
    );
  }
  if (ranges.length === 0) return null;
  return ranges.reduce((sum, range) => sum + range, 0) / ranges.length;
}

function findLiquidityPools(
  bars: DailyOhlcBar[],
  swings: SwingPoint[],
): SmcAnalysis["liquidityPools"] {
  const atr = averageTrueRange(bars);
  if (atr === null || atr <= 0) return [];

  const tolerance = atr * 0.1;
  const firstIndex = Math.max(0, bars.length - LIQUIDITY_LOOKBACK_BARS);
  const pools: SmcAnalysis["liquidityPools"] = [];

  for (const side of ["high", "low"] as const) {
    const points = swings.filter(
      (swing) => swing.side === side && swing.index >= firstIndex,
    );
    const groups: SwingPoint[][] = [];

    for (const point of points) {
      const group = groups.find((candidate) => {
        const average =
          candidate.reduce((sum, item) => sum + item.price, 0) /
          candidate.length;
        return Math.abs(point.price - average) <= tolerance;
      });
      if (group) group.push(point);
      else groups.push([point]);
    }

    for (const group of groups.filter((candidate) => candidate.length >= 2)) {
      const prices = group.map((point) => point.price);
      const chronological = [...group].sort(
        (left, right) => left.index - right.index,
      );
      pools.push({
        side: side === "high" ? "buy_side" : "sell_side",
        lower: roundPrice(Math.min(...prices)),
        upper: roundPrice(Math.max(...prices)),
        touches: group.length,
        firstDate: apiDate(chronological[0].date)!,
        lastDate: apiDate(chronological.at(-1)!.date)!,
      });
    }
  }

  return pools
    .sort((left, right) => right.lastDate.getTime() - left.lastDate.getTime())
    .slice(0, 4);
}

function findCandidateOrderBlocks(
  bars: DailyOhlcBar[],
  events: BreakEvent[],
): SmcAnalysis["candidateOrderBlocks"] {
  const firstIndex = Math.max(0, bars.length - 40);
  const blocks: SmcAnalysis["candidateOrderBlocks"] = [];
  const seen = new Set<string>();

  for (const event of [...events].reverse()) {
    if (event.index < firstIndex) continue;
    const direction = event.kind.startsWith("bullish") ? "bullish" : "bearish";
    let candidateIndex = -1;

    for (
      let index = event.index - 1;
      index >= Math.max(0, event.index - 5);
      index -= 1
    ) {
      const bar = bars[index];
      const isOpposingCandle =
        direction === "bullish"
          ? bar.close < bar.open
          : bar.close > bar.open;
      if (isOpposingCandle) {
        candidateIndex = index;
        break;
      }
    }

    if (candidateIndex < 0) continue;
    const candidate = bars[candidateIndex];
    const key = `${direction}:${candidate.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const retested = bars
      .slice(event.index + 1)
      .some(
        (bar) => bar.high >= candidate.low && bar.low <= candidate.high,
      );
    blocks.push({
      direction,
      date: apiDate(candidate.date)!,
      lower: roundPrice(candidate.low),
      upper: roundPrice(candidate.high),
      status: retested ? "retested" : "unretested",
      breakDate: apiDate(event.date)!,
    });
    if (blocks.length >= 3) break;
  }

  return blocks;
}

function findFairValueGaps(
  bars: DailyOhlcBar[],
): SmcAnalysis["fairValueGaps"] {
  const gaps: SmcAnalysis["fairValueGaps"] = [];

  for (let index = 2; index < bars.length; index += 1) {
    const first = bars[index - 2];
    const third = bars[index];
    let direction: "bullish" | "bearish";
    let lower: number;
    let upper: number;

    if (first.high < third.low) {
      direction = "bullish";
      lower = first.high;
      upper = third.low;
    } else if (first.low > third.high) {
      direction = "bearish";
      lower = third.high;
      upper = first.low;
    } else {
      continue;
    }

    let status: "open" | "partially_filled" | "filled" = "open";
    for (const laterBar of bars.slice(index + 1)) {
      if (direction === "bullish") {
        if (laterBar.low <= lower) {
          status = "filled";
          break;
        }
        if (laterBar.low <= upper) status = "partially_filled";
      } else {
        if (laterBar.high >= upper) {
          status = "filled";
          break;
        }
        if (laterBar.high >= lower) status = "partially_filled";
      }
    }

    gaps.push({
      direction,
      date: apiDate(third.date)!,
      lower: roundPrice(lower),
      upper: roundPrice(upper),
      status,
    });
  }

  return gaps.slice(-4).reverse();
}

export function analyzeDailySmc(
  sourceBars: DailyOhlcBar[],
): SmcAnalysis {
  const sourceDate = sourceBars.at(-1)?.date ?? null;
  const bars = sourceBars.slice(-MAX_ANALYSIS_BARS);
  if (bars.some((bar) => !isValidBar(bar))) {
    return emptySmcAnalysis(
      sourceDate,
      bars.length,
      "日線欄位未通過檢查，SMC 結構暫不判讀。",
    );
  }
  if (bars.length < MIN_ANALYSIS_BARS) {
    return emptySmcAnalysis(
      sourceDate,
      bars.length,
      `可用官方日線只有 ${bars.length} 根；至少需要 ${MIN_ANALYSIS_BARS} 根才能整理 SMC 結構。`,
    );
  }

  const swings = findConfirmedSwings(bars);
  const confirmedSwings = swings.filter(
    (swing) => swing.index + PIVOT_RADIUS < bars.length,
  );
  const latestHigh = confirmedSwings
    .filter((swing) => swing.side === "high")
    .at(-1);
  const latestLow = confirmedSwings
    .filter((swing) => swing.side === "low")
    .at(-1);
  const events = findBreakEvents(bars, swings);
  const structure = structureAt(swings, bars.length);

  return {
    status: "available",
    timeframe: "daily",
    sourceDate: apiDate(sourceDate),
    barsUsed: bars.length,
    structure,
    swingHigh: {
      price: latestHigh ? roundPrice(latestHigh.price) : null,
      date: apiDate(latestHigh?.date ?? null),
    },
    swingLow: {
      price: latestLow ? roundPrice(latestLow.price) : null,
      date: apiDate(latestLow?.date ?? null),
    },
    latestBreak: events.at(-1)
      ? {
          kind: events.at(-1)!.kind,
          date: apiDate(events.at(-1)!.date)!,
          level: roundPrice(events.at(-1)!.level),
        }
      : { kind: null, date: null, level: null },
    liquiditySweeps: findLiquiditySweeps(bars, swings),
    liquidityPools: findLiquidityPools(bars, swings),
    candidateOrderBlocks: findCandidateOrderBlocks(bars, events),
    fairValueGaps: findFairValueGaps(bars),
    notes:
      "依最近 120 根官方日線整理；波段高低點需兩根後續日 K 確認。相近高低點以近 14 日平均真實波幅的 10% 聚合，只是候選流動性區；掃蕩、訂單塊與失衡區都不代表實際機構委託，也不保證反轉或回補，未經回測，不能單獨作為買賣訊號。",
  };
}
