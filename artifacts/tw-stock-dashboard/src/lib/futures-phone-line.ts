export type FuturesPhoneTimeframe = 1 | 5 | 15;
export type FuturesPhoneTrend = "bullish" | "bearish" | "neutral";

export type FuturesPhoneInputBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

export type FuturesPhoneLinePoint = {
  time: string;
  value: number | null;
  trend: FuturesPhoneTrend;
};

export type FuturesPhoneLineResult = {
  bars: FuturesPhoneInputBar[];
  points: FuturesPhoneLinePoint[];
  trend: FuturesPhoneTrend;
  linePrice: number | null;
  broken: boolean | null;
};

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function bucketStart(time: string, timeframe: FuturesPhoneTimeframe) {
  const timestamp = new Date(time).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const taipei = new Date(timestamp + TAIPEI_OFFSET_MS);
  const year = taipei.getUTCFullYear();
  const month = taipei.getUTCMonth();
  const date = taipei.getUTCDate();
  const minuteOfDay = taipei.getUTCHours() * 60 + taipei.getUTCMinutes();
  const startMinute = Math.floor(minuteOfDay / timeframe) * timeframe;
  const utcStart = Date.UTC(
    year,
    month,
    date,
    Math.floor(startMinute / 60),
    startMinute % 60,
  ) - TAIPEI_OFFSET_MS;
  return { key: `${year}-${month}-${date}-${startMinute}`, time: new Date(utcStart).toISOString() };
}

export function aggregateFuturesPhoneBars(
  input: FuturesPhoneInputBar[],
  timeframe: FuturesPhoneTimeframe,
): FuturesPhoneInputBar[] {
  if (timeframe === 1) return input;
  const groups = new Map<string, FuturesPhoneInputBar>();
  for (const bar of input) {
    const bucket = bucketStart(bar.time, timeframe);
    if (!bucket) continue;
    const current = groups.get(bucket.key);
    if (!current) {
      groups.set(bucket.key, {
        ...bar,
        time: bucket.time,
        volume: bar.volume ?? 0,
      });
      continue;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.volume = (current.volume ?? 0) + (bar.volume ?? 0);
  }
  return [...groups.values()].sort(
    (left, right) => new Date(left.time).getTime() - new Date(right.time).getTime(),
  );
}

export function calculateFuturesPhoneLine(
  input: FuturesPhoneInputBar[],
  timeframe: FuturesPhoneTimeframe,
  lookback: number,
): FuturesPhoneLineResult {
  const bars = aggregateFuturesPhoneBars(input, timeframe);
  const points: FuturesPhoneLinePoint[] = [];
  let trend: FuturesPhoneTrend = "neutral";
  let linePrice: number | null = null;

  for (let index = 0; index < bars.length; index += 1) {
    if (index + 1 < lookback * 2) {
      points.push({ time: bars[index].time, value: null, trend });
      continue;
    }

    const previous = bars.slice(index + 1 - lookback * 2, index + 1 - lookback);
    const current = bars.slice(index + 1 - lookback, index + 1);
    const previousLow = Math.min(...previous.map((bar) => bar.low));
    const previousHigh = Math.max(...previous.map((bar) => bar.high));
    const currentLow = Math.min(...current.map((bar) => bar.low));
    const currentHigh = Math.max(...current.map((bar) => bar.high));
    const higherLows = currentLow > previousLow;
    const lowerHighs = currentHigh < previousHigh;

    if (higherLows && !lowerHighs) {
      trend = "bullish";
      linePrice = linePrice === null || trend !== points[index - 1]?.trend
        ? currentLow
        : Math.max(linePrice, currentLow);
    } else if (lowerHighs && !higherLows) {
      trend = "bearish";
      linePrice = linePrice === null || trend !== points[index - 1]?.trend
        ? currentHigh
        : Math.min(linePrice, currentHigh);
    }
    points.push({ time: bars[index].time, value: linePrice, trend });
  }

  const lastBar = bars.at(-1);
  const broken = !lastBar || linePrice === null || trend === "neutral"
    ? null
    : trend === "bullish"
      ? lastBar.close < linePrice
      : lastBar.close > linePrice;

  return { bars, points, trend, linePrice, broken };
}
