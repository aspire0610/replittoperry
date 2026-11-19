import {
  calculateTaifexIntradayKd,
  fetchTaifexFuturesDailyHistory,
  fetchTaifexFuturesDayIntraday,
  type TaifexFuturesDayIntraday,
  type TaifexMinuteBar,
} from "./taifex-market-data.js";
import {
  fetchYuantaSparkFuturesTickBars,
  fetchYuantaSparkQuotes,
  isYuantaSparkRelayConfigured,
  type YuantaSparkQuote,
} from "./yuanta-spark-relay.js";
import { resolveYuantaSparkTickPriceScale, resolveYuantaSparkDateOnlyTickScale } from "./yuanta-spark-price-scale.js";
import { logger } from "./logger.js";
import { describeYuantaSparkFailure } from "./yuanta-spark-source-status.js";
import { resolveFuturesSession, isFuturesSessionTimestamp, isFuturesSessionQuoteTimestamp } from "./futures-session.js";
import { withFuturesDailyHistoryBudget } from "./futures-daily-history-budget.js";

const LIVE_QUOTE_MAX_AGE_MS = 90_000;
const LIVE_BAR_MAX_AGE_MS = 180_000;
let lastSparkFallbackWarningAt = 0;

export async function fetchFuturesDayIntraday(): Promise<TaifexFuturesDayIntraday> {
  const now = Date.now();
  const session = resolveFuturesSession(now);
  const { symbol, label, date } = session;
  const currentSession = session.active;
  // The TAIFEX observer only collects day-session bars. Never relabel them as night.
  const dailyHistoryPromise = fetchTaifexFuturesDailyHistory();
  const dailyHistoryForResponse = withFuturesDailyHistoryBudget(
    dailyHistoryPromise,
    {
      status: "unavailable",
      bars: [],
      atr14: null,
      atr14By4: null,
      asOf: null,
      source: "TAIFEX 官方 TX 日盤歷史仍在查詢；即時觀測先行回傳",
    },
  );
  const taifexPromise = symbol === "TXF1"
    ? fetchTaifexFuturesDayIntraday().catch(() => null)
    : Promise.resolve(null);

  let sparkQuote: YuantaSparkQuote | null = null;
  let sparkReferenceQuote: YuantaSparkQuote | null = null;
  let sparkBars: TaifexMinuteBar[] = [];
  let sparkBarPriceScale: 1 | 10 = 1;
  const sparkFailures: string[] = [];
  if (isYuantaSparkRelayConfigured()) {
    // The quote and tick-detail calls use the same SPARK futures account, so
    // keep them sequential; the Mac relay serializes access to that SDK session.
    try {
      const quotes = await fetchYuantaSparkQuotes("futures", [symbol]);
      const candidate = quotes.find((row) => row.symbol === symbol && row.asOf);
      if (candidate?.symbol === symbol) sparkReferenceQuote = candidate;
      const isSameDayClosingQuote = Boolean(
        candidate?.asOf &&
        !currentSession &&
        isFuturesSessionQuoteTimestamp(candidate.asOf.getTime(), session, now)
      );
      if (
        candidate?.asOf &&
        isFuturesSessionQuoteTimestamp(candidate.asOf.getTime(), session, now) &&
        now - candidate.asOf.getTime() >= -60_000 &&
        (
          now - candidate.asOf.getTime() <= LIVE_QUOTE_MAX_AGE_MS ||
          isSameDayClosingQuote
        )
      ) {
        sparkQuote = candidate;
      } else {
        sparkFailures.push(`SPARK ${symbol} 沒有新鮮報價`);
      }
    } catch (error) {
      sparkFailures.push(
        error instanceof Error ? error.message : "SPARK 報價查詢失敗",
      );
    }
    try {
      sparkBars = (await fetchYuantaSparkFuturesTickBars(symbol))
        .map((bar) => ({
          time: bar.time.toISOString(),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        }))
        .filter((bar) => isFuturesSessionTimestamp(new Date(bar.time).getTime(), session, now))
        .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      const lastSparkBar = sparkBars.at(-1);
      if (
        currentSession &&
        lastSparkBar &&
        now - new Date(lastSparkBar.time).getTime() > LIVE_BAR_MAX_AGE_MS
      ) {
        sparkBars = [];
        sparkFailures.push(`SPARK ${symbol} ${label}一分 K 已過期`);
      }
      const latestSparkBar = sparkBars.at(-1);
      if (latestSparkBar) {
        const scale = sparkQuote
          ? resolveYuantaSparkTickPriceScale(latestSparkBar.close, sparkQuote.price)
          : sparkReferenceQuote
            ? resolveYuantaSparkDateOnlyTickScale(
                latestSparkBar.close,
                sparkReferenceQuote.price,
                sparkReferenceQuote.asOf,
                new Date(latestSparkBar.time),
              )
            : null;
        if (scale === null) {
          sparkBars = [];
          sparkFailures.push(`SPARK ${symbol} 分 K 缺少有效的同日價格尺度驗證`);
        } else if (scale === 10) {
          // The read-only probe confirmed both callbacks identify TAIFEX/TXF1,
          // while GetStkTickDetail prices are one tenth of GetWatchListAll.
          sparkBarPriceScale = scale;
          sparkBars = sparkBars.map((bar) => ({
            ...bar,
            open: bar.open * scale,
            high: bar.high * scale,
            low: bar.low * scale,
            close: bar.close * scale,
          }));
        }
      }
      if (sparkBars.length === 0) sparkFailures.push(`SPARK ${symbol} 尚無當前${label}一分 K`);
    } catch (error) {
      sparkFailures.push(
        error instanceof Error ? error.message : "SPARK 逐筆成交查詢失敗",
      );
    }
  } else {
    sparkFailures.push("SPARK relay 尚未設定");
  }
  if (sparkFailures.length > 0 && Date.now() - lastSparkFallbackWarningAt >= 60_000) {
    logger.warn(
      { reasons: sparkFailures },
      sparkBars.length
        ? "SPARK quote timestamp unavailable; using validated session tick-derived prices"
        : "SPARK source unavailable; using same-session fallback where available",
    );
    lastSparkFallbackWarningAt = Date.now();
  }

  const [taifex, dailyHistory] = await Promise.all([
    taifexPromise,
    dailyHistoryForResponse,
  ]);
  const fallbackBars = (taifex?.bars ?? []).filter((bar) => isFuturesSessionTimestamp(new Date(bar.time).getTime(), session, now));
  const bars = sparkBars.length > 0 ? sparkBars : fallbackBars;
  const kd = calculateTaifexIntradayKd(bars);
  const barsSource = sparkBars.length > 0
    ? `Yuanta SPARK · ${symbol} 逐筆成交彙整的一分 K${sparkBarPriceScale === 10 ? "（價格 ×10 校正）" : ""}`
    : taifex
      ? "TAIFEX MIS · 伺服器連線後觀測到的日盤成交"
      : `${label}一分鐘 K 線暫不可用`;

  const lastSparkBar = sparkBars.at(-1);
  if (sparkQuote || lastSparkBar) {
    const price = sparkQuote?.price ?? lastSparkBar?.close ?? null;
    const previousClose = sparkQuote?.previousClose ?? (lastSparkBar ? sparkReferenceQuote?.previousClose ?? null : null);
    const priceSource = sparkQuote
      ? currentSession
        ? `Yuanta SPARK · ${sparkQuote.symbol}`
        : `Yuanta SPARK · ${sparkQuote.symbol} 收盤報價`
      : `Yuanta SPARK · ${symbol} 最後一根一分 K`;
    return {
      status: !currentSession ? "closed" : bars.length < 11 ? "warming_up" : "live",
      symbol,
      date: date.replaceAll("-", ""),
      bars,
      ...kd,
      price,
      change: previousClose === null || price === null
        ? null
        : price - previousClose,
      changePercent: previousClose && previousClose > 0 && price !== null
        ? ((price - previousClose) / previousClose) * 100
        : null,
      asOf: sparkQuote?.asOf ?? (lastSparkBar ? new Date(lastSparkBar.time) : null),
      source: `價格：${priceSource}；分 K：${barsSource}`,
      dailyHistory,
    };
  }

  if (taifex) return {
    ...taifex,
    symbol,
    source: `${taifex.source}；SPARK 未採用：${[...new Set(sparkFailures.map(describeYuantaSparkFailure))].join("、")}`,
    dailyHistory,
  };
  return {
    status: currentSession ? "unavailable" : "closed",
    symbol,
    date: date.replaceAll("-", ""),
    bars: [],
    ...calculateTaifexIntradayKd([]),
    price: null, change: null, changePercent: null, asOf: null,
    source: `${label}資料暫不可用；SPARK 未採用：${[...new Set(sparkFailures.map(describeYuantaSparkFailure))].join("、")}`,
    dailyHistory,
  };
}
