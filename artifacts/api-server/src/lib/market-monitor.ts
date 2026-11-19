import {
  getMarketWideRecentStockHistory,
  getOfficialMarketScanSnapshot,
  type OfficialDailyClose,
} from "./market-data.js";

export const MARKET_MONITOR_CATEGORIES = [
  { id: "yesterday_strength", label: "昨日強勢股" },
  { id: "active_etf", label: "主動式 ETF" },
  { id: "candlestick", label: "K 棒型態" },
  { id: "five_day_strength", label: "近 5 日強勢股" },
  { id: "ten_day_strength", label: "近 10 日強勢股" },
  { id: "bollinger_expansion", label: "布林上軌突破" },
  { id: "trend", label: "趨勢股" },
  { id: "surge", label: "急漲股" },
  { id: "ma_cluster_breakout", label: "突破均線糾結" },
  { id: "break_five_day_average", label: "突破 5 日線" },
] as const;

export type MarketMonitorCategoryId = (typeof MARKET_MONITOR_CATEGORIES)[number]["id"];

export type MarketMonitorItem = {
  symbol: string;
  ticker: string;
  name: string;
  exchange: "twse" | "tpex";
  price: number;
  changePercent: number | null;
  force: number | null;
  status: "多方轉強" | "偏多" | "多空拉鋸" | "偏空" | "空方轉強" | "資料不足";
  signal: string;
  asOf: string;
  source: string;
  forceDefinition: string;
};

export type MarketMonitorData = {
  marketDate: string;
  analyzedAt: string;
  source: string;
  coverage: { universe: number; withHistory: number; partial: boolean };
  categories: Array<{ id: MarketMonitorCategoryId; label: string; count: number; items: MarketMonitorItem[] }>;
};

type ScoredMonitorItem = MarketMonitorItem & {
  yesterday_strength: boolean;
  candlestick: boolean;
  five_day_strength: boolean;
  ten_day_strength: boolean;
  bollinger_expansion: boolean;
  trend: boolean;
  surge: boolean;
  ma_cluster_breakout: boolean;
  break_five_day_average: boolean;
  return5: number | null;
  return10: number | null;
};

const excludedNames = /(權證|認購|認售|牛證|熊證|ETN|債券|反向|槓桿|期貨|原油|黃金|白銀|貨幣|外匯)/iu;
const pressureFormula = "近 5 根日 K 的成交量加權多空實體：(收−開)/(高−低)×成交量，再除以總量，×100；不是委買賣或逐筆主力資料。";

function movingAverage(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const tail = values.slice(-period);
  return tail.reduce((sum, value) => sum + value, 0) / period;
}

function pressure(bars: Array<{ open: number; high: number; low: number; close: number; volume: number | null }>): number | null {
  const tail = bars.slice(-5).filter((bar) => bar.volume !== null && bar.volume > 0 && bar.high > bar.low);
  const volume = tail.reduce((sum, bar) => sum + (bar.volume ?? 0), 0);
  if (tail.length < 3 || volume <= 0) return null;
  return Math.round(tail.reduce((sum, bar) =>
    sum + ((bar.close - bar.open) / (bar.high - bar.low)) * (bar.volume ?? 0), 0) / volume * 100);
}

function state(force: number | null): MarketMonitorItem["status"] {
  if (force === null) return "資料不足";
  if (force >= 35) return "多方轉強";
  if (force >= 10) return "偏多";
  if (force > -10) return "多空拉鋸";
  if (force > -35) return "偏空";
  return "空方轉強";
}

function isOrdinaryStock(quote: OfficialDailyClose): boolean {
  return !excludedNames.test(quote.name) && !/(ETF|主動)/iu.test(quote.name) &&
    quote.volume !== null && quote.volume > 0 && quote.tradedValue !== null && quote.tradedValue > 0;
}

function makeItem(quote: OfficialDailyClose, bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number | null }>, asOf: string, source: string): ScoredMonitorItem {
  const closeValues = bars.map((bar) => bar.close);
  const latest = bars.at(-1);
  const prior = bars.at(-2);
  const prev5 = bars.at(-6);
  const prev10 = bars.at(-11);
  const pressureValue = pressure(bars);
  const ma5 = movingAverage(closeValues, 5);
  const ma20 = movingAverage(closeValues, 20);
  const ma60 = movingAverage(closeValues, 60);
  const return5 = prev5 && latest ? (latest.close / prev5.close - 1) * 100 : null;
  const return10 = prev10 && latest ? (latest.close / prev10.close - 1) * 100 : null;
  const previousClose = quote.change === null ? null : quote.close - quote.change;
  const changePercent = previousClose && previousClose > 0 ? quote.change! / previousClose * 100 : null;
  const prevFiveMa = bars.length >= 7 ? movingAverage(closeValues.slice(0, -1), 5) : null;
  const candleSignal = latest && prior
    ? latest.close > latest.open && prior.close < prior.open && latest.close >= prior.open && latest.open <= prior.close
      ? "日線多方吞噬"
      : latest.close > latest.open && (latest.high - latest.close) <= (latest.close - latest.open) * 0.35
        ? "日線收高"
        : "未符合已定義多方型態"
    : "日線資料不足";
  const bollingerMiddle = movingAverage(closeValues, 20);
  const deviation = closeValues.length >= 20 && bollingerMiddle
    ? Math.sqrt(closeValues.slice(-20).reduce((sum, value) => sum + (value - bollingerMiddle) ** 2, 0) / 20)
    : null;
  const upperBand = bollingerMiddle !== null && deviation !== null ? bollingerMiddle + 2 * deviation : null;
  const force = pressureValue;
  const maCluster = ma5 !== null && ma20 !== null && ma60 !== null
    ? (Math.max(ma5, ma20, ma60) - Math.min(ma5, ma20, ma60)) / latest!.close * 100 <= 1.5
    : false;
  const tags = {
    yesterday_strength: (changePercent ?? -Infinity) >= 3,
    candlestick: candleSignal === "日線多方吞噬" || candleSignal === "日線收高",
    five_day_strength: return5 !== null && return5 >= 3,
    ten_day_strength: return10 !== null && return10 >= 5,
    bollinger_expansion: upperBand !== null && latest !== undefined && latest.close > upperBand,
    trend: ma5 !== null && ma20 !== null && ma60 !== null && latest!.close > ma5 && ma5 > ma20 && ma20 > ma60,
    surge: (changePercent ?? -Infinity) >= 5,
    ma_cluster_breakout: maCluster && latest !== undefined && latest.close > Math.max(ma5!, ma20!, ma60!),
    break_five_day_average: prevFiveMa !== null && ma5 !== null && prior !== undefined && latest !== undefined && prior.close <= prevFiveMa && latest.close > ma5,
    return5,
    return10,
  };
  return {
    symbol: quote.symbol,
    ticker: `${quote.symbol}.${quote.exchange === "twse" ? "TW" : "TWO"}`,
    name: quote.name,
    exchange: quote.exchange,
    price: quote.close,
    changePercent,
    force,
    status: state(force),
    signal: candleSignal,
    asOf,
    source,
    forceDefinition: pressureFormula,
    ...tags,
    return5,
    return10,
  };
}

let monitorCache: { expiresAt: number; value: MarketMonitorData } | null = null;
let monitorPending: Promise<MarketMonitorData> | null = null;

async function buildMarketMonitorData(): Promise<MarketMonitorData> {
  const snapshot = await getOfficialMarketScanSnapshot();
  const ordinary = snapshot.quotes.filter(isOrdinaryStock).sort((a, b) =>
    (b.tradedValue ?? 0) - (a.tradedValue ?? 0) || a.symbol.localeCompare(b.symbol));
  const scannedUniverse = ordinary.slice(0, 120);
  const history = await getMarketWideRecentStockHistory(
    snapshot.asOf,
    scannedUniverse.map(({ symbol, exchange }) => ({ symbol, exchange })),
  );
  const items = scannedUniverse.flatMap((quote) => {
    const bars = history.barsBySymbol.get(quote.symbol) ?? [];
    if (bars.length < 11 || bars.at(-1)?.date !== snapshot.asOf) return [];
    const source = "官方市場日報 + " + (history.source ?? "官方個股日線");
    return [makeItem(quote, bars, snapshot.asOf, source)];
  });
  const activeEtfs = snapshot.quotes.filter((quote) => /(主動|active)/iu.test(quote.name)).map((quote) => ({
    symbol: quote.symbol,
    ticker: `${quote.symbol}.${quote.exchange === "twse" ? "TW" : "TWO"}`,
    name: quote.name,
    exchange: quote.exchange,
    price: quote.close,
    changePercent: quote.change === null || quote.close - quote.change <= 0
      ? null
      : quote.change / (quote.close - quote.change) * 100,
    force: null,
    status: "資料不足" as const,
    signal: "主動式 ETF；方向力道需有效分時 K 線",
    asOf: snapshot.asOf,
    source: snapshot.source ?? "TWSE / TPEx 官方市場日報",
    forceDefinition: "尚未取得分時 K 線，未計算多空力道。",
  }));
  const definitions: Record<MarketMonitorCategoryId, (item: ScoredMonitorItem) => boolean> = {
    yesterday_strength: (item) => item.yesterday_strength,
    active_etf: () => false,
    candlestick: (item) => item.candlestick,
    five_day_strength: (item) => item.five_day_strength,
    ten_day_strength: (item) => item.ten_day_strength,
    bollinger_expansion: (item) => item.bollinger_expansion,
    trend: (item) => item.trend,
    surge: (item) => item.surge,
    ma_cluster_breakout: (item) => item.ma_cluster_breakout,
    break_five_day_average: (item) => item.break_five_day_average,
  };
  const categories = MARKET_MONITOR_CATEGORIES.map((category) => {
    const selected = category.id === "active_etf"
      ? activeEtfs
      : items.filter(definitions[category.id]);
    return { id: category.id, label: category.label, count: selected.length, items: selected };
  });
  return {
    marketDate: snapshot.asOf,
    analyzedAt: new Date().toISOString(),
    source: `${snapshot.source ?? "TWSE / TPEx 官方市場日報"}；技術分類僅分析成交值前 ${scannedUniverse.length} 檔普通股，另列名稱含「主動」的 ETF`,
    coverage: { universe: ordinary.length, withHistory: items.length, partial: items.length < ordinary.length },
    categories,
  };
}

export async function getMarketMonitorData(): Promise<MarketMonitorData> {
  if (monitorCache && monitorCache.expiresAt > Date.now()) return monitorCache.value;
  if (monitorPending) return monitorPending;
  monitorPending = buildMarketMonitorData();
  try {
    const value = await monitorPending;
    monitorCache = { expiresAt: Date.now() + 60_000, value };
    return value;
  } finally {
    monitorPending = null;
  }
}
