import type { MarketSummaryData, UsPremarketIndex } from "./market-data.js";

export type MarketAiDailySummaryMode = "premarket" | "closing";
export type PremarketMarketAnalysis = {
  marketRead: string;
  outlook: string;
  watch: string;
  events: string;
  action: string;
};
export type ClosingMarketAnalysis = {
  cause: string;
  watch: string;
  fiveDayOutlook: string;
  events: string;
  action: string;
};
export type DailyMarketAnalysis = PremarketMarketAnalysis | ClosingMarketAnalysis;

export const PREMARKET_SUMMARY_FIELDS = ["marketRead", "outlook", "watch", "events", "action"] as const;
export const CLOSING_SUMMARY_FIELDS = ["cause", "watch", "fiveDayOutlook", "events", "action"] as const;
export const SUMMARY_FIELD_MAX_LENGTH = 40;

export function isValidSummaryOutput(
  text: string | null,
  mode: MarketAiDailySummaryMode = "premarket",
): boolean {
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const fields = mode === "closing" ? CLOSING_SUMMARY_FIELDS : PREMARKET_SUMMARY_FIELDS;
    const expectedKeys: readonly string[] = fields;
    return fields.every((field) => {
      const value = parsed[field];
      return (
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.trim().length <= SUMMARY_FIELD_MAX_LENGTH &&
        !/(保證|必勝|穩賺|勝率|一定上漲|一定下跌)/u.test(value)
      );
    }) && Object.keys(parsed).every((key) => expectedKeys.includes(key));
  } catch {
    return false;
  }
}

export function composeDailyMarketSummary(
  data: MarketSummaryData,
  analysis: DailyMarketAnalysis,
  mode: MarketAiDailySummaryMode,
  usIndices: { nasdaq: UsPremarketIndex; dow: UsPremarketIndex } | null,
  simplify: (value: string) => string = (value) => value,
): string {
  const label = mode === "premarket" ? "前一交易日判讀" : "今日盤勢判讀";
  const direction = data.dailyCloseChange > 0
    ? "上漲"
    : data.dailyCloseChange < 0
      ? "下跌"
      : "平盤";
  const formatUsIndex = (quote: UsPremarketIndex) =>
    quote.available && quote.changePercent !== null
      ? `${quote.name}${quote.changePercent > 0 ? "漲" : quote.changePercent < 0 ? "跌" : "平"}${Math.abs(quote.changePercent).toFixed(2)}%${quote.price === null ? "" : `至${quote.price.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`}`
      : `${quote.name}漲跌資料暫不可用`;
  const quoteDate = (quote: UsPremarketIndex) => {
    if (quote.asOf) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(quote.asOf);
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    }
    return quote.source?.match(/資料日期\s+(\d{4}-\d{2}-\d{2})/u)?.[1] ?? "日期未提供";
  };
  const technicalEvidence = [
    data.ma20 === null
      ? "20 日均線資料不足"
      : `20 日均線 ${data.ma20.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 點，收盤${data.dailyClosePrice >= data.ma20 ? "高於" : "低於"}${Math.abs(data.dailyClosePrice - data.ma20).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 點`,
    data.ma60 === null
      ? null
      : `60 日均線 ${data.ma60.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 點`,
  ].filter(Boolean).join("；");
  const summaryLines = mode === "premarket"
    ? (() => {
        const premarket = analysis as PremarketMarketAnalysis;
        return [
          `📈${label}：${premarket.marketRead}`,
          `加權指數（${data.dailyCloseDate} 官方收盤）：${data.dailyClosePrice.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 點，${direction} ${Math.abs(data.dailyCloseChange).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 點（${data.dailyCloseChangePercent > 0 ? "+" : ""}${data.dailyCloseChangePercent.toFixed(2)}%）。`,
          `技術依據（${data.dailyCloseDate}）：${technicalEvidence}。`,
          ...(usIndices ? [
            `📈美股資料日：納斯達克 ${quoteDate(usIndices.nasdaq)}、道瓊 ${quoteDate(usIndices.dow)}（Nasdaq / Yahoo Finance）。`,
            `📈美股收盤：${formatUsIndex(usIndices.nasdaq)}；${formatUsIndex(usIndices.dow)}。`,
          ] : ["📈美股資料日與漲跌：指數資料暫不可用。"]),
          `📈可能走勢：${premarket.outlook}`,
          `📈消息面留意：${premarket.watch}`,
          `📈本日重要事件：${premarket.events}`,
          `📈AI 主觀建議：${premarket.action}`,
        ];
      })()
    : (() => {
        const closing = analysis as ClosingMarketAnalysis;
        return [
          `📊 ${label}`,
          `加權指數｜${data.dailyCloseDate} 收盤 ${data.dailyClosePrice.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 點｜${direction} ${Math.abs(data.dailyCloseChange).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 點（${data.dailyCloseChangePercent > 0 ? "+" : ""}${data.dailyCloseChangePercent.toFixed(2)}%）`,
          `技術依據｜${technicalEvidence}。`,
          "",
          `可能原因｜${closing.cause}`,
          `觀察重點｜${closing.watch}`,
          `未來 5 日｜${closing.fiveDayOutlook}`,
          `近期事件｜${closing.events}`,
          `AI 方向｜${closing.action}`,
        ];
      })();
  return [
    ...summaryLines,
  ].map((line) => simplify(line).replace(/\s+/gu, " ")).join("\n");
}
