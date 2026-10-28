import {
  getMarketQuotes,
  getMarketWideStockQuotes,
  getOfficialDailyCloseData,
  isTaiwanStockSessionOpen,
  type MarketQuoteData,
} from "./market-data.js";
import { isTaiwanMarketClosed } from "./twse-holiday-calendar.js";
import { searchMarketNews } from "./market-ai-daily-summary.js";
import type { DuckDuckGoSearchResult } from "./duckduckgo-search.js";

export type MarketChecklistSignal = "bullish" | "mixed" | "bearish" | "unavailable";
export type MarketChecklistItem = {
  key: string;
  label: string;
  signal: MarketChecklistSignal;
  detail: string;
  source: string | null;
  observedAt: string | null;
  sources?: Array<{ title: string; url: string }>;
};
export type MarketScenario = { label: string; condition: string; implication: string };
export type MarketChecklist = {
  marketDate: string;
  analyzedAt: string;
  conclusion: "bullish" | "mixed" | "bearish" | "insufficient";
  conclusionText: string;
  items: MarketChecklistItem[];
  scenarios: MarketScenario[];
};

const cache = new Map<string, { expiresAt: number; promise: Promise<MarketChecklist> }>();
const TTL_MS = 10_000;
const EVENT_SEARCH_CACHE_MS = 5 * 60_000;
let eventSearchCache: {
  expiresAt: number;
  promise: Promise<{ searchedAt: string; status: string; sources: DuckDuckGoSearchResult[] }>;
} | null = null;
const WEIGHT_STOCKS = ["2330", "2317", "2454", "2308", "2382"];
const SEMICONDUCTOR_STOCKS = ["2330", "2454", "2303", "3711", "3034"];
const MARKET_EVENT_TOPIC =
  /(?:央行|利率|FOMC|CPI|GDP|非農|就業|通膨|通胀|消費者物價|消費者價格|關稅|法說會|月營收|財報|出口|地震|戰事|選舉|政策|central bank|inflation|employment|tariff|earnings|economic data)/iu;
const MARKET_EVENT_DATE =
  /(?:\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}月\d{1,2}日\b|\b\d{1,2}\/\d{1,2}\b|今日|明日|本週|本周|下週|下周|today|tomorrow|this week|next week)/iu;
const GENERIC_NEWS_HEADLINE =
  /^(?:全球政經|國際|財經|即時新聞|新聞中心|市場焦點)(?:\s*[-|｜:]|\s*$)/iu;

function getRecentMarketEvents() {
  if (eventSearchCache && eventSearchCache.expiresAt > Date.now()) {
    return eventSearchCache.promise;
  }
  const promise = searchMarketNews("premarket").then((result) => ({
    searchedAt: new Date().toISOString(),
    status: result.status,
    sources: result.sources
      .filter((source) =>
        MARKET_EVENT_TOPIC.test(`${source.title} ${source.snippet}`) &&
        MARKET_EVENT_DATE.test(`${source.title} ${source.snippet}`),
      )
      .map((source) => ({
        ...source,
        title: (GENERIC_NEWS_HEADLINE.test(source.title) ? source.snippet : source.title)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180),
      }))
      .filter((source) => source.title.length > 0)
      .slice(0, 3),
  }));
  eventSearchCache = {
    expiresAt: Date.now() + EVENT_SEARCH_CACHE_MS,
    promise,
  };
  void promise.catch(() => {
    if (eventSearchCache?.promise === promise) eventSearchCache = null;
  });
  return promise;
}

function getSignal(value: number | null): MarketChecklistSignal {
  return value === null ? "unavailable" : value > 0 ? "bullish" : value < 0 ? "bearish" : "mixed";
}

function amountText(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "資料不足";
  const sign = value > 0 ? "買超" : value < 0 ? "賣超" : "持平";
  return `${sign} ${Math.round(Math.abs(value) / 1_000).toLocaleString("zh-TW")} 張`;
}

function buildInstitutionalUrl(date: string, market: "twse" | "tpex"): URL {
  const [year, month, day] = date.split("-").map(Number);
  const url = market === "twse"
    ? new URL("https://www.twse.com.tw/rwd/zh/fund/T86")
    : new URL("https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php");
  if (market === "twse") {
    url.searchParams.set("response", "json");
    url.searchParams.set("date", date.replaceAll("-", ""));
    url.searchParams.set("selectType", "ALLBUT0999");
  } else {
    url.searchParams.set("l", "zh-tw");
    url.searchParams.set("d", `${year! - 1911}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`);
    url.searchParams.set("s", "0,asc,0");
    url.searchParams.set("o", "json");
  }
  return url;
}

function numeric(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).replaceAll(",", "").trim();
  if (!normalized || normalized === "--" || normalized === "----") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getInstitutionalFlows(date: string): Promise<{
  foreign: number;
  trust: number;
  sources: string[];
} | null> {
  const [twse, tpex] = await Promise.allSettled([
    fetch(buildInstitutionalUrl(date, "twse"), { signal: AbortSignal.timeout(8_000) })
      .then((r) => r.ok ? r.json() as Promise<{ fields?: string[]; data?: string[][] }> : Promise.reject(new Error("TWSE T86 unavailable"))),
    fetch(buildInstitutionalUrl(date, "tpex"), { signal: AbortSignal.timeout(8_000) })
      .then((r) => r.ok ? r.json() as Promise<{ tables?: Array<{ data?: string[][] }> }> : Promise.reject(new Error("TPEx institutional data unavailable"))),
  ]);
  let foreign = 0;
  let trust = 0;
  const sources: string[] = [];
  if (twse.status === "fulfilled" && twse.value.fields && twse.value.data?.length) {
    const fields = twse.value.fields;
    const index = (text: string) => fields.findIndex((field) => field.includes(text));
    const foreignMain = index("外陸資買賣超股數(不含外資自營商)");
    const foreignDealer = index("外資自營商買賣超股數");
    const trustIndex = index("投信買賣超股數");
    if (foreignMain >= 0 && foreignDealer >= 0 && trustIndex >= 0) {
      for (const row of twse.value.data) {
        if (!/^\d{4,6}$/.test(row[0]?.trim() ?? "")) continue;
        const a = numeric(row[foreignMain]);
        const b = numeric(row[foreignDealer]);
        const c = numeric(row[trustIndex]);
        if (a !== null && b !== null && c !== null) {
          foreign += a + b;
          trust += c;
        }
      }
      sources.push("TWSE T86");
    }
  }
  if (tpex.status === "fulfilled") {
    const rows = tpex.value.tables?.[0]?.data ?? [];
    if (rows.length) {
      let found = false;
      for (const row of rows) {
        if (!/^\d{4,6}$/.test(row[0]?.trim() ?? "")) continue;
        const f = numeric(row[10]);
        const t = numeric(row[13]);
        if (f !== null && t !== null) {
          foreign += f;
          trust += t;
          found = true;
        }
      }
      if (found) sources.push("TPEx 三大法人日交易資訊");
    }
  }
  return sources.length ? { foreign, trust, sources } : null;
}

function latestMarketQuote(quotes: MarketQuoteData[]): MarketQuoteData | null {
  return quotes
    .filter((quote) => quote.key === "futures_day" || quote.key === "futures_night")
    .filter((quote) => quote.available && quote.changePercent !== null)
    .sort((a, b) => (b.asOf?.getTime() ?? 0) - (a.asOf?.getTime() ?? 0))[0] ?? null;
}

function taipeiDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function loadChecklist(
  marketDate: string,
  currentPrice: number,
  ma20: number | null,
  ma60: number | null,
  support: number | null,
  resistance: number | null,
): Promise<MarketChecklist> {
  const now = new Date();
  const taipeiToday = taipeiDate(now);
  const isIntraday = isTaiwanStockSessionOpen(now);
  const [futuresResult, officialClose, institutionalResult, eventSearchResult] = await Promise.allSettled([
    getMarketQuotes(),
    getOfficialDailyCloseData(),
    getInstitutionalFlows(marketDate),
    getRecentMarketEvents(),
  ]);
  const items: MarketChecklistItem[] = [];
  const closeData = officialClose.status === "fulfilled" ? officialClose.value : null;
  const marketClosedToday = await isTaiwanMarketClosed(now);
  const staleDailyData =
    !isIntraday &&
    marketClosedToday !== true &&
    marketDate < taipeiToday;
  const quotes = futuresResult.status === "fulfilled" ? futuresResult.value : [];
  const liveIndex = quotes.find((quote) =>
    quote.key === "taiex" &&
    quote.available &&
    quote.price !== null &&
    quote.asOf !== null &&
    taipeiDate(quote.asOf) === taipeiToday &&
    (!isIntraday || now.getTime() - quote.asOf.getTime() <= 120_000),
  ) ?? null;
  const indexPrice = isIntraday ? liveIndex?.price ?? null : currentPrice;
  const indexObservedAt = isIntraday
    ? liveIndex?.asOf?.toISOString() ?? null
    : marketDate;
  const indexSource = isIntraday
    ? liveIndex?.source ? `${liveIndex.source} · 盤中即時` : null
    : "TWSE 官方指數歷史資料";
  const representativeSymbols = [...new Set([...WEIGHT_STOCKS, ...SEMICONDUCTOR_STOCKS])];
  const liveStockQuotes = isIntraday
    ? await getMarketWideStockQuotes(
        representativeSymbols.map((symbol) => ({ symbol, exchange: "twse" as const })),
        now,
      )
    : new Map();
  const above20 = indexPrice === null || ma20 === null ? null : indexPrice >= ma20;
  const above60 = indexPrice === null || ma60 === null ? null : indexPrice >= ma60;
  const trendSignal = above20 === null || above60 === null
    ? "unavailable"
    : above20 && above60 ? "bullish" : !above20 && !above60 ? "bearish" : "mixed";
  items.push({
    key: "trend",
    label: "大盤趨勢",
    signal: trendSignal,
    detail: indexPrice !== null
      ? `${isIntraday ? "盤中指數" : "最新收盤"} ${indexPrice.toLocaleString("zh-TW")} 點；${ma20 === null ? "20 日均線資料不足" : `${indexPrice >= ma20 ? "高於" : "低於"} 20 日均線 ${ma20.toLocaleString("zh-TW")}`}；${ma60 === null ? "60 日均線資料不足" : `${indexPrice >= ma60 ? "高於" : "低於"} 60 日均線 ${ma60.toLocaleString("zh-TW")}`}`
      : "目前沒有可驗證的盤中指數報價",
    source: indexSource,
    observedAt: indexObservedAt,
  });

  const validChanges = (closeData?.quotes ?? [])
    .map((quote) => quote.change)
    .filter((value): value is number => value !== null);
  const advances = validChanges.filter((value) => value > 0).length;
  const declines = validChanges.filter((value) => value < 0).length;
  const unchanged = validChanges.filter((value) => value === 0).length;
  const breadthDirection = closeData ? advances - declines : null;
  const tradedValue = (closeData?.quotes ?? [])
    .map((quote) => quote.tradedValue)
    .filter((value): value is number => value !== null)
    .reduce((sum, value) => sum + value, 0);
  const volumeShares = (closeData?.quotes ?? [])
    .map((quote) => quote.volume)
    .filter((value): value is number => value !== null)
    .reduce((sum, value) => sum + value, 0);
  items.push({
    key: "volume",
    label: "成交量與廣度",
    signal: isIntraday || breadthDirection === null ? "unavailable" : getSignal(breadthDirection),
    detail: isIntraday
      ? "盤中官方漲跌家數與全市場成交金額未取得；不以代表股推估，收盤後更新"
      : closeData
      ? `${closeData.asOf} 上漲 ${advances}、下跌 ${declines}、平盤 ${unchanged}；官方成交金額 ${(tradedValue / 1e12).toFixed(2)} 兆、成交股數 ${(volumeShares / 1e8).toFixed(2)} 億股`
      : "官方漲跌家數與成交金額暫不可用",
    source: isIntraday ? null : closeData ? "TWSE／TPEx 官方每日行情" : null,
    observedAt: isIntraday ? null : closeData?.asOf ?? null,
  });

  const institutional = institutionalResult.status === "fulfilled"
    ? institutionalResult.value
    : null;
  const eventSearch = eventSearchResult.status === "fulfilled"
    ? eventSearchResult.value
    : null;
  const institutionalNet = institutional ? institutional.foreign + institutional.trust : null;
  items.push({
    key: "institutional",
    label: "外資與投信",
    signal: isIntraday ? "unavailable" : getSignal(institutionalNet),
    detail: isIntraday
      ? "法人流向採官方日資料，盤中尚未公布，不以即時個股成交推估"
      : institutional
      ? `外資${amountText(institutional.foreign)}；投信${amountText(institutional.trust)}`
      : "當日上市櫃官方三大法人資料尚未完整取得",
    source: isIntraday ? null : institutional?.sources.join("、") ?? null,
    observedAt: isIntraday ? null : institutional ? marketDate : null,
  });

  const futures = latestMarketQuote(quotes);
  const futuresDate = futures?.asOf
    ? taipeiDate(futures.asOf)
    : null;
  const futuresIsCurrent = Boolean(futures && futuresDate && futuresDate >= taipeiToday);
  items.push({
    key: "futures",
    label: "台指期",
    signal: futuresIsCurrent ? getSignal(futures?.changePercent ?? null) : "unavailable",
    detail: futures
      ? futuresIsCurrent
        ? `${futures.name} ${futures.changePercent! > 0 ? "上漲" : futures.changePercent! < 0 ? "下跌" : "持平"} ${Math.abs(futures.changePercent!).toFixed(2)}%（${futures.source ?? "TAIFEX"}）`
        : `最近行情日期 ${futuresDate}，早於大盤資料日 ${marketDate}，不納入方向判讀`
      : "目前沒有可驗證的台指期報價",
    source: futuresIsCurrent ? futures?.source ?? null : null,
    observedAt: futures?.asOf?.toISOString() ?? null,
  });

  const closeMap = new Map((closeData?.quotes ?? []).map((quote) => [quote.symbol, quote]));
  const representativeGroup = (symbols: string[]) => {
    const rows = symbols.map((symbol) => {
      const official = closeMap.get(symbol);
      const live = liveStockQuotes.get(symbol);
      if (isIntraday && live?.available && live.change !== null && live.asOf && taipeiDate(live.asOf) === taipeiToday) {
        return {
          symbol,
          change: live.change,
          date: taipeiToday,
          observedAt: live.asOf.toISOString(),
          source: live.source,
        };
      }
      return !isIntraday && official?.change !== null && official?.change !== undefined && closeData
        ? { symbol, change: official.change, date: closeData.asOf, observedAt: closeData.asOf, source: "TWSE／TPEx 官方日行情" }
        : null;
    });
    const dates = new Set(rows.flatMap((row) => row ? [row.date] : []));
    const completeAndAligned = rows.every((row) => row !== null) && dates.size === 1;
    return {
      rows,
      change: completeAndAligned
        ? rows.reduce((sum, row) => sum + row!.change, 0) / rows.length
        : null,
      date: completeAndAligned ? rows[0]!.date : null,
      observedAt: completeAndAligned ? rows[0]!.observedAt : null,
      sources: [...new Set(rows.flatMap((row) => row ? [row.source] : []))],
    };
  };
  const topWeight = representativeGroup(WEIGHT_STOCKS);
  const topWeightChange = topWeight.change;
  const weightDetail = WEIGHT_STOCKS.map((symbol) => {
    const row = topWeight.rows[WEIGHT_STOCKS.indexOf(symbol)];
    return row ? `${symbol} ${row.change > 0 ? "+" : ""}${row.change}` : `${symbol}無資料`;
  }).join("、");
  items.push({
    key: "heavyweights",
    label: "權值股",
    signal: getSignal(topWeightChange),
    detail: `${weightDetail}；${isIntraday ? "盤中即時報價，代表股平均不代表全市場廣度" : "以代表性權值股官方日漲跌判讀"}`,
    source: topWeight.sources.join("、") || null,
    observedAt: topWeight.observedAt,
  });

  const semiconductors = representativeGroup(SEMICONDUCTOR_STOCKS);
  const semiChange = semiconductors.change;
  const semiDetail = SEMICONDUCTOR_STOCKS.map((symbol) => {
    const row = semiconductors.rows[SEMICONDUCTOR_STOCKS.indexOf(symbol)];
    return row ? `${symbol} ${row.change > 0 ? "+" : ""}${row.change}` : `${symbol}無資料`;
  }).join("、");
  items.push({
    key: "semiconductors",
    label: "半導體代表股",
    signal: getSignal(semiChange),
    detail: `${semiDetail}；${isIntraday ? "盤中即時報價，代表股等權觀察，非官方產業指數" : "代表股等權觀察，非官方產業指數"}`,
    source: semiconductors.sources.join("、") || null,
    observedAt: semiconductors.observedAt,
  });

  const price = indexPrice;
  const levelsSignal = price === null || support === null || resistance === null
    ? "unavailable"
    : price < support ? "bearish" : price > resistance ? "bullish" : "mixed";
  items.push({
    key: "levels",
    label: "支撐與壓力",
    signal: levelsSignal,
    detail: price !== null && support !== null && resistance !== null
      ? `近 20 個交易日區間：支撐參考 ${support.toLocaleString("zh-TW")}、壓力參考 ${resistance.toLocaleString("zh-TW")} 點；${isIntraday ? "盤中" : "目前"} ${price.toLocaleString("zh-TW")} 點`
      : "近 20 個交易日高低點資料不足",
    source: indexSource,
    observedAt: indexObservedAt,
  });

  const recentEvents = eventSearch?.sources ?? [];
  items.push({
    key: "events",
    label: "近期市場事件",
    signal: recentEvents.length ? "mixed" : "unavailable",
    detail: recentEvents.length
      ? `直接搜尋到 ${recentEvents.length} 則具明確日期的事件線索；新聞標題與摘要尚未核實全文。`
      : eventSearch?.status === "unavailable"
        ? "近期市場事件搜尋來源暫不可用，請稍後再試。"
        : "已直接搜尋新聞與市場資料，未找到同時符合事件主題與明確日期的近期資料。",
    source: recentEvents.length
      ? "新聞搜尋結果（尚未核實）"
      : eventSearch?.status === "unavailable"
        ? "新聞搜尋來源暫不可用"
        : "DuckDuckGo／Google News RSS 直接搜尋",
    observedAt: eventSearch?.searchedAt ?? new Date().toISOString(),
    sources: recentEvents.map(({ title, url }) => ({ title, url })),
  });

  if (staleDailyData) {
    for (const item of items) {
      if (item.signal === "unavailable" || !item.observedAt) continue;
      const observedDate = /^\d{4}-\d{2}-\d{2}$/.test(item.observedAt)
        ? item.observedAt
        : taipeiDate(new Date(item.observedAt));
      if (observedDate <= marketDate) item.signal = "unavailable";
    }
  }
  const known = items.filter((item) => item.key !== "events" && item.signal !== "unavailable");
  const bullish = known.filter((item) => item.signal === "bullish").length;
  const bearish = known.filter((item) => item.signal === "bearish").length;
  const conclusion = known.length < 3
    ? "insufficient"
    : bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "mixed";
  const scenarios: MarketScenario[] = [
    { label: "偏多", condition: `加權指數站上 ${resistance?.toLocaleString("zh-TW") ?? "近期壓力"} 點，且成交量與權值股同步改善`, implication: "多方訊號增加；仍須觀察外資、投信及台指期是否配合。" },
    { label: "震盪", condition: support !== null && resistance !== null ? `指數守住 ${support.toLocaleString("zh-TW")} 點支撐，但未有效突破 ${resistance.toLocaleString("zh-TW")} 點壓力` : "指數在可確認的支撐與壓力區間內整理", implication: "方向未明；等待量價、法人與權值股訊號一致。" },
    { label: "偏空", condition: `加權指數跌破 ${support?.toLocaleString("zh-TW") ?? "近期支撐"} 點，且成交量擴大或法人續賣`, implication: "空方風險升高；若資料不足，先視為警示條件而非預測。" },
  ];
  return {
    marketDate,
    analyzedAt: new Date().toISOString(),
    conclusion,
    conclusionText: staleDailyData
      ? `官方日線仍截至 ${marketDate}，目前沒有當日收盤資料；過期日線不作方向判讀，只保留日期較新的即時報價。`
      : isIntraday
      ? `盤中依即時指數、代表股與台指期報價更新；成交廣度與法人流向只採官方日資料，收盤前不推估。`
      : conclusion === "insufficient"
        ? "可核對訊號不足，暫不歸類。"
      : `依可用檢查項等權統計：偏多 ${bullish} 項、偏空 ${bearish} 項；不是上漲機率。`,
    items,
    scenarios,
  };
}

export function getMarketChecklist(
  marketDate: string,
  currentPrice: number,
  ma20: number | null,
  ma60: number | null,
  support20: number | null,
  resistance20: number | null,
): Promise<MarketChecklist> {
  const existing = cache.get(marketDate);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;
  const promise = loadChecklist(marketDate, currentPrice, ma20, ma60, support20, resistance20);
  const entry = { expiresAt: Date.now() + TTL_MS, promise };
  cache.set(marketDate, entry);
  void promise.catch(() => {
    if (cache.get(marketDate) === entry) cache.delete(marketDate);
  });
  return promise;
}
