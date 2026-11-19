import type { FuturesDayIntraday, MarketQuote } from "@workspace/api-client-react";
import { completedFuturesEntryBars } from "./futures-entry-points.ts";

export type FuturesLiveSignal = {
  action: "long" | "short" | "wait" | "unavailable";
  confirmationMode: "five_min_trend" | "unavailable";
  candidate: {
    direction: "long" | "short";
    triggerPrice: number;
    invalidationPrice: number;
    targetPrice: number;
    rewardRisk: number;
    triggerCondition: string;
    invalidationCondition: string;
  } | null;
  reason: string;
  currentPrice: number | null;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  rewardRisk: number | null;
  futuresAsOf: string | null;
  taiexAsOf: string | null;
  futuresSource: string;
  taiexSource: string | null;
};

const QUOTE_MAX_AGE_MS = 90_000;
const MIN_TARGET_POINTS = 150;
const MINUTE_MS = 60_000;
const FIVE_MINUTE_MS = 5 * MINUTE_MS;
const MIN_TREND_BARS = 13;

type CandidateDirection = "long" | "short";

function exponentialMovingAverage(values: number[], period: number) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let average = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) {
    average = value * multiplier + average * (1 - multiplier);
  }
  return average;
}

function createCandidate(
  direction: CandidateDirection,
  triggerPrice: number,
  invalidationPrice: number,
  maxRisk: number,
  triggerCondition: string,
  invalidationCondition: string,
) {
  const riskPoints = direction === "long"
    ? triggerPrice - invalidationPrice
    : invalidationPrice - triggerPrice;
  if (!(riskPoints > 0) || riskPoints > maxRisk) return null;

  const rewardPoints = Math.max(MIN_TARGET_POINTS, Math.ceil(2 * riskPoints));
  const targetPrice = direction === "long"
    ? Math.ceil(triggerPrice + rewardPoints)
    : Math.floor(triggerPrice - rewardPoints);
  const actualReward = direction === "long"
    ? targetPrice - triggerPrice
    : triggerPrice - targetPrice;

  return {
    direction,
    triggerPrice,
    invalidationPrice,
    targetPrice,
    rewardRisk: actualReward / riskPoints,
    triggerCondition,
    invalidationCondition,
  };
}

function unavailable(
  reason: string,
  data?: FuturesDayIntraday,
  taiex?: MarketQuote,
): FuturesLiveSignal {
  return {
    action: "unavailable",
    confirmationMode: ["TXF1", "TXF8"].includes(data?.symbol ?? "")
      ? "five_min_trend"
      : "unavailable",
    candidate: null,
    reason,
    currentPrice: typeof data?.price === "number" && Number.isFinite(data.price) && data.price > 0
      ? data.price
      : null,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    rewardRisk: null,
    futuresAsOf: data?.asOf ?? null,
    taiexAsOf: data?.symbol === "TXF8" ? null : taiex?.asOf ?? null,
    futuresSource: data?.source ?? "未提供",
    taiexSource: data?.symbol === "TXF8" ? null : taiex?.source ?? null,
  };
}

function wait(
  reason: string,
  data: FuturesDayIntraday,
  taiex: MarketQuote | undefined,
): FuturesLiveSignal {
  return {
    ...unavailable(reason, data, taiex),
    action: "wait",
  };
}

function isInSession(time: number, date: string, symbol: string) {
  if (!/^\d{8}$/u.test(date) || !["TXF1", "TXF8"].includes(symbol)) return false;
  const sessionDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const sessionStart = Date.parse(
    `${sessionDate}T${symbol === "TXF1" ? "08:45" : "15:00"}:00+08:00`,
  );
  const sessionEnd = sessionStart + (symbol === "TXF1" ? 5 : 14) * 60 * MINUTE_MS;
  return Number.isFinite(sessionStart) && time >= sessionStart && time < sessionEnd;
}

function isValidBar(
  bar: FuturesDayIntraday["bars"][number],
  now: number,
  date: string,
  symbol: string,
) {
  const time = Date.parse(bar.time);
  if (!Number.isFinite(time)) return false;
  return time % MINUTE_MS === 0 &&
    time + MINUTE_MS <= now &&
    isInSession(time, date, symbol) &&
    [bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0) &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= bar.high;
}

function isFreshQuote(asOf: string | null, now: number) {
  if (!asOf) return false;
  const time = Date.parse(asOf);
  const age = now - time;
  return Number.isFinite(time) && age >= -60_000 && age <= QUOTE_MAX_AGE_MS;
}

export function calculateFuturesLiveSignal(
  data: FuturesDayIntraday | undefined,
  taiex: MarketQuote | undefined,
  now = Date.now(),
): FuturesLiveSignal {
  if (!data || data.status === "unavailable" || data.status === "closed" ||
      typeof data.price !== "number" || !Number.isFinite(data.price) || data.price <= 0) {
    return unavailable("目前沒有可用的期貨即時成交；資料恢復前不提供進場方向。", data, taiex);
  }
  const isNight = data.symbol === "TXF8";
  if (!["TXF1", "TXF8"].includes(data.symbol ?? "") || data.status !== "live") {
    return wait(
      `即時進場判斷等待有效${isNight ? "夜盤 TXF8" : "本盤別"}行情；不沿用舊訊號。`,
      data,
      taiex,
    );
  }
  if (!/分 K：Yuanta SPARK/u.test(data.source)) {
    return wait("Yuanta SPARK 本盤分鐘 K 暫不可用；不使用其他來源代替進場波動風險判斷。", data, taiex);
  }
  if (!isFreshQuote(data.asOf, now)) {
    return wait("期貨報價已超過 90 秒新鮮度門檻，暫停現價進場判斷。", data, taiex);
  }
  const completeBars = data.bars
    .filter(bar => isValidBar(bar, now, data.date, data.symbol!))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const bars = completeBars.slice(-16);
  if (bars.length < 16) {
    return wait(`完整連續 1 分 K 不足（${bars.length}/16 根），暫不猜測突破方向。`, data, taiex);
  }
  if (bars.some((bar, index) => index > 0 &&
      Date.parse(bar.time) - Date.parse(bars[index - 1]!.time) !== MINUTE_MS)) {
    return wait("最近 16 根 1 分 K 有缺漏，等待連續觀測資料。", data, taiex);
  }
  const lastBarCloseTime = Date.parse(bars[15]!.time) + MINUTE_MS;
  if (now - lastBarCloseTime > 90_000) {
    return wait("最近 1 分 K 已超過 90 秒，等待新成交確認。", data, taiex);
  }

  const ranges = bars.slice(1).map((bar, index) =>
    Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - bars[index]!.close),
      Math.abs(bar.low - bars[index]!.close),
    ));
  const atr14 = ranges.slice(-14).reduce((sum, range) => sum + range, 0) / 14;
  if (!(atr14 > 0)) return wait("近期 1 分 K 波幅不足，無法設定合理的停損距離。", data, taiex);
  const maxRisk = atr14;
  const fiveMinuteBars = completedFuturesEntryBars(data, now);
  const trendBars = fiveMinuteBars.slice(-MIN_TREND_BARS);
  if (trendBars.length < MIN_TREND_BARS) {
    return wait(
      `完整 5 分 K 不足（${trendBars.length}/${MIN_TREND_BARS} 根）；至少需要 13 根判斷 5 分 EMA5/EMA13 趨勢。`,
      data,
      taiex,
    );
  }
  if (trendBars.some((bar, index) => index > 0 &&
      Date.parse(bar.time) - Date.parse(trendBars[index - 1]!.time) !== FIVE_MINUTE_MS)) {
    return wait("最近 13 根完整 5 分 K 有缺漏，等待連續 SPARK 資料後再判斷趨勢。", data, taiex);
  }
  const latestFiveMinuteCloseAt = Date.parse(trendBars.at(-1)!.time) + FIVE_MINUTE_MS;
  if (now - latestFiveMinuteCloseAt > FIVE_MINUTE_MS + 90_000) {
    return wait("最近完成的 5 分 K 已超過 6 分 30 秒，暫停趨勢進場判斷。", data, taiex);
  }

  const closes = fiveMinuteBars.map(bar => bar.close);
  const ema5 = exponentialMovingAverage(closes, 5);
  const ema13 = exponentialMovingAverage(closes, 13);
  if (ema5 === null || ema13 === null) {
    return wait("5 分 K 趨勢均線資料不足，暫不推測方向。", data, taiex);
  }
  const neutralGap = Math.max(1, Math.ceil(atr14 * 0.1));
  const trend: CandidateDirection | null = ema5 - ema13 > neutralGap
    ? "long"
    : ema13 - ema5 > neutralGap
      ? "short"
      : null;
  if (!trend) {
    return wait(
      `5 分 EMA5 ${Math.round(ema5)} 與 EMA13 ${Math.round(ema13)} 尚未明確分開；不依當日漲跌幅選方向。`,
      data,
      taiex,
    );
  }

  const entryLevel = Math.round(ema5);
  const stopBuffer = Math.max(1, Math.ceil(maxRisk * 0.25));
  const maxEntryDistance = Math.max(1, Math.floor(maxRisk * 0.75));
  const stopPrice = trend === "long"
    ? Math.floor(entryLevel - stopBuffer)
    : Math.ceil(entryLevel + stopBuffer);
  const trendLabel = trend === "long" ? "偏多" : "偏空";
  const candidate = createCandidate(
    trend,
    entryLevel,
    stopPrice,
    maxRisk,
    trend === "long"
      ? `13 根以上完整 5 分 K 的 EMA5 高於 EMA13；現價站回 EMA5 ${entryLevel} 點，且距離不超過 ${maxEntryDistance} 點時列進場。`
      : `13 根以上完整 5 分 K 的 EMA5 低於 EMA13；現價跌回 EMA5 ${entryLevel} 點下方，且距離不超過 ${maxEntryDistance} 點時列進場。`,
    trend === "long"
      ? `跌破 ${stopPrice} 點時取消做多條件`
      : `站上 ${stopPrice} 點時取消做空條件`,
  );
  if (!candidate) {
    return wait(
      `5 分趨勢${trendLabel}，但停損參考距離 ${stopBuffer} 點超過 SPARK 1 分 ATR14 上限 ${maxRisk.toFixed(1)} 點；暫不提供進場點。`,
      data,
      taiex,
    );
  }

  const entryDistance = data.price - entryLevel;
  const entryConfirmed = trend === "long"
    ? entryDistance >= 0 && entryDistance <= maxEntryDistance
    : entryDistance <= 0 && Math.abs(entryDistance) <= maxEntryDistance;
  if (!entryConfirmed) {
    const condition = trend === "long"
      ? entryDistance < 0
        ? `現價尚未站回 EMA5 ${entryLevel} 點；等待回到均線附近再列做多進場。`
        : `現價高於 EMA5 ${entryLevel} 點超過 ${maxEntryDistance} 點；不追價，等待回踩。`
      : entryDistance > 0
        ? `現價尚未跌回 EMA5 ${entryLevel} 點下方；等待回到均線附近再列做空進場。`
        : `現價低於 EMA5 ${entryLevel} 點超過 ${maxEntryDistance} 點；不追價，等待反彈。`;
    return {
      ...wait(
        `最近完整 5 分 K 趨勢${trendLabel}（EMA5 ${Math.round(ema5)}／EMA13 ${Math.round(ema13)}）。${condition}`,
        data,
        taiex,
      ),
      candidate,
    };
  }

  const entryPrice = data.price;
  const riskPoints = trend === "long"
    ? entryPrice - stopPrice
    : stopPrice - entryPrice;
  if (!(riskPoints > 0) || riskPoints > maxRisk) {
    return wait(
      `5 分趨勢${trendLabel}且現價接近 EMA5，但停損風險 ${Math.ceil(riskPoints)} 點超過 SPARK 1 分 ATR14 上限 ${Math.floor(maxRisk)} 點；暫不出點。`,
      data,
      taiex,
    );
  }
  const rewardPoints = Math.max(MIN_TARGET_POINTS, Math.ceil(2 * riskPoints));
  const targetPrice = trend === "long"
    ? Math.ceil(entryPrice + rewardPoints)
    : Math.floor(entryPrice - rewardPoints);
  const actualReward = trend === "long"
    ? targetPrice - entryPrice
    : entryPrice - targetPrice;

  return {
    action: trend,
    confirmationMode: "five_min_trend",
    candidate: null,
    reason: `最近完整 5 分 K 趨勢${trendLabel}（EMA5 ${Math.round(ema5)}／EMA13 ${Math.round(ema13)}）；現價位於 EMA5 進場帶內。停損風險 ${Math.ceil(riskPoints)} 點，未超過 SPARK 1 分 ATR14 ${Math.floor(maxRisk)} 點；目標至少 150 點且不低於 2R。`,
    currentPrice: entryPrice,
    entryPrice,
    stopPrice,
    targetPrice,
    rewardRisk: actualReward / riskPoints,
    futuresAsOf: data.asOf,
    taiexAsOf: isNight ? null : taiex?.asOf ?? null,
    futuresSource: data.source,
    taiexSource: isNight ? null : taiex?.source ?? null,
  };
}
