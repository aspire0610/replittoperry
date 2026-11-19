import {
  isFuturesSessionQuoteTimestamp,
  isFuturesSessionTimestamp,
  resolveFuturesSession,
} from "./futures-session.js";

const MINUTE_MS = 60_000;
const FIVE_MINUTE_MS = 5 * MINUTE_MS;
const QUOTE_MAX_AGE_MS = 90_000;
const BAR_MAX_AGE_MS = 90_000;
const FIVE_MINUTE_MAX_AGE_MS = FIVE_MINUTE_MS + 90_000;
const MINUTE_BARS_REQUIRED = 16;
const TREND_BARS_REQUIRED = 13;

export type FuturesNightBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type FuturesNightEvidence = {
  direction: "long" | "short" | null;
  entryLevel: number | null;
  atr14: number;
  maxEntryDistance: number;
  entryConfirmed: boolean;
  ema5: number;
  ema13: number;
  minuteBars: FuturesNightBar[];
  trendBars: FuturesNightBar[];
  reason: string;
};

export type FuturesNightEvidenceResult =
  | { available: true; evidence: FuturesNightEvidence }
  | { available: false; reason: string };

function validBar(bar: FuturesNightBar): boolean {
  return (
    [bar.open, bar.high, bar.low, bar.close].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= bar.high
  );
}

function exponentialMovingAverage(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let average =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) {
    average = value * multiplier + average * (1 - multiplier);
  }
  return average;
}

function aggregateCompletedFiveMinuteBars(
  bars: FuturesNightBar[],
  session: ReturnType<typeof resolveFuturesSession>,
  now: number,
): FuturesNightBar[] {
  const groups = new Map<number, Map<number, FuturesNightBar>>();
  const invalidBuckets = new Set<number>();
  for (const bar of bars) {
    const time = Date.parse(bar.time);
    if (
      !Number.isFinite(time) ||
      time % MINUTE_MS !== 0 ||
      !isFuturesSessionTimestamp(time, session, now)
    ) continue;

    const bucket = Math.floor(time / FIVE_MINUTE_MS) * FIVE_MINUTE_MS;
    const rows = groups.get(bucket) ?? new Map<number, FuturesNightBar>();
    if (!validBar(bar) || rows.has(time)) invalidBuckets.add(bucket);
    rows.set(time, bar);
    groups.set(bucket, rows);
  }

  return [...groups.entries()]
    .filter(([bucket, rows]) =>
      !invalidBuckets.has(bucket) &&
      bucket + FIVE_MINUTE_MS <= now &&
      rows.size === 5 &&
      Array.from({ length: 5 }, (_, index) =>
        rows.has(bucket + index * MINUTE_MS),
      ).every(Boolean)
    )
    .sort(([left], [right]) => left - right)
    .map(([bucket, rows]) => {
      const minutes = Array.from({ length: 5 }, (_, index) =>
        rows.get(bucket + index * MINUTE_MS)!,
      );
      return {
        time: new Date(bucket).toISOString(),
        open: minutes[0]!.open,
        high: Math.max(...minutes.map((bar) => bar.high)),
        low: Math.min(...minutes.map((bar) => bar.low)),
        close: minutes[4]!.close,
      };
    });
}

export function analyzeFuturesNightEvidence(input: {
  bars: FuturesNightBar[];
  price: number | null;
  quoteAsOf: Date | string | null;
  source: string;
  session: ReturnType<typeof resolveFuturesSession>;
  now?: number;
}): FuturesNightEvidenceResult {
  const now = input.now ?? Date.now();
  const { session } = input;
  if (!session.active || session.symbol !== "TXF8") {
    return { available: false, reason: "目前不是有效的 TXF8 夜盤交易時段。" };
  }
  if (!/分 K：Yuanta SPARK/u.test(input.source)) {
    return {
      available: false,
      reason: "Yuanta SPARK TXF8 夜盤分鐘 K 尚不可用，不以日盤或其他時段 K 線代替。",
    };
  }
  const quoteAt = input.quoteAsOf instanceof Date
    ? input.quoteAsOf.getTime()
    : typeof input.quoteAsOf === "string"
      ? Date.parse(input.quoteAsOf)
      : Number.NaN;
  if (
    !Number.isFinite(input.price) ||
    input.price! <= 0 ||
    !Number.isFinite(quoteAt) ||
    !isFuturesSessionQuoteTimestamp(quoteAt, session, now) ||
    now - quoteAt < -60_000 ||
    now - quoteAt > QUOTE_MAX_AGE_MS
  ) {
    return {
      available: false,
      reason: "TXF8 報價未通過夜盤時段或 90 秒新鮮度檢查。",
    };
  }

  const validMinutes = input.bars
    .filter((bar) => {
      const time = Date.parse(bar.time);
      return (
        Number.isFinite(time) &&
        time % MINUTE_MS === 0 &&
        time + MINUTE_MS <= now &&
        isFuturesSessionTimestamp(time, session, now) &&
        validBar(bar)
      );
    })
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const minuteBars = validMinutes.slice(-MINUTE_BARS_REQUIRED);
  if (
    minuteBars.length < MINUTE_BARS_REQUIRED ||
    minuteBars.some((bar, index) =>
      index > 0 &&
      Date.parse(bar.time) - Date.parse(minuteBars[index - 1]!.time) !== MINUTE_MS
    )
  ) {
    return {
      available: false,
      reason: `TXF8 夜盤完整連續 1 分 K 不足（${minuteBars.length}/${MINUTE_BARS_REQUIRED} 根）。`,
    };
  }
  const latestMinuteCloseAt = Date.parse(minuteBars.at(-1)!.time) + MINUTE_MS;
  if (now - latestMinuteCloseAt > BAR_MAX_AGE_MS) {
    return {
      available: false,
      reason: "TXF8 夜盤最近完成的一分 K 已超過 90 秒。",
    };
  }

  const ranges = minuteBars.slice(1).map((bar, index) =>
    Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - minuteBars[index]!.close),
      Math.abs(bar.low - minuteBars[index]!.close),
    ),
  );
  const atr14 = ranges.slice(-14).reduce((sum, range) => sum + range, 0) / 14;
  if (!(atr14 > 0)) {
    return { available: false, reason: "TXF8 夜盤一分 ATR14 無有效波動資料。" };
  }

  const allFiveMinuteBars = aggregateCompletedFiveMinuteBars(
    validMinutes,
    session,
    now,
  );
  const fiveMinuteBars = allFiveMinuteBars.slice(-TREND_BARS_REQUIRED);
  if (
    fiveMinuteBars.length < TREND_BARS_REQUIRED ||
    fiveMinuteBars.some((bar, index) =>
      index > 0 &&
      Date.parse(bar.time) - Date.parse(fiveMinuteBars[index - 1]!.time) !==
        FIVE_MINUTE_MS
    )
  ) {
    return {
      available: false,
      reason: `TXF8 夜盤完整連續 5 分 K 不足（${fiveMinuteBars.length}/${TREND_BARS_REQUIRED} 根）。`,
    };
  }
  const latestFiveMinuteCloseAt =
    Date.parse(fiveMinuteBars.at(-1)!.time) + FIVE_MINUTE_MS;
  if (now - latestFiveMinuteCloseAt > FIVE_MINUTE_MAX_AGE_MS) {
    return {
      available: false,
      reason: "TXF8 夜盤最近完成的五分 K 已超過 6 分 30 秒。",
    };
  }

  const allFiveMinuteCloses = allFiveMinuteBars.map((bar) => bar.close);
  const ema5 = exponentialMovingAverage(allFiveMinuteCloses, 5);
  const ema13 = exponentialMovingAverage(allFiveMinuteCloses, 13);
  if (ema5 === null || ema13 === null) {
    return { available: false, reason: "TXF8 夜盤五分趨勢均線資料不足。" };
  }
  const neutralGap = Math.max(1, Math.ceil(atr14 * 0.1));
  const direction =
    ema5 - ema13 > neutralGap
      ? "long"
      : ema13 - ema5 > neutralGap
        ? "short"
        : null;
  const entryLevel = Math.round(ema5);
  const maxEntryDistance = Math.max(1, Math.floor(atr14 * 0.75));
  const entryDistance = input.price! - entryLevel;
  const entryConfirmed = direction === "long"
    ? entryDistance >= 0 && entryDistance <= maxEntryDistance
    : direction === "short"
      ? entryDistance <= 0 && Math.abs(entryDistance) <= maxEntryDistance
      : false;
  const trendLabel = direction === "long" ? "偏多" : direction === "short" ? "偏空" : "未分方向";

  return {
    available: true,
    evidence: {
      direction,
      entryLevel,
      atr14,
      maxEntryDistance,
      entryConfirmed,
      ema5,
      ema13,
      minuteBars,
      trendBars: fiveMinuteBars,
      reason:
        direction === null
          ? `TXF8 夜盤 EMA5 ${Math.round(ema5)} 與 EMA13 ${Math.round(ema13)} 尚未明確分開。`
          : `TXF8 夜盤五分趨勢${trendLabel}，EMA5 ${Math.round(ema5)}／EMA13 ${Math.round(ema13)}；一分 ATR14 ${Math.floor(atr14)} 點。`,
    },
  };
}
