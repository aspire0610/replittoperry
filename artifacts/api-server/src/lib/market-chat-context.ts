import type { AssistantChatSource } from "@workspace/api-zod";
import {
  getOfficialDailyCloseData,
  getTaiexQuote,
} from "./market-data.js";
import { getLatestOfficialMarketDays } from "./quant-market-data.js";
import { fetchOfficialJson } from "./official-json-fetch.js";

type TpexIndexRow = {
  Date?: unknown;
  Close?: unknown;
  Change?: unknown;
};

type DailyMarketContext = {
  otcIndex: {
    close: number;
    change: number | null;
    date: string;
  } | null;
  breadth: {
    date: string;
    advances: number;
    declines: number;
    unchanged: number;
  } | null;
  turnover: Array<{
    exchange: string;
    date: string;
    volumeShares: number;
    amount: number;
  }>;
  sources: AssistantChatSource[];
};

const DAILY_CONTEXT_TTL_MS = 3 * 60 * 1_000;
const TPEX_INDEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_index";
let dailyContextCache:
  | { expiresAt: number; promise: Promise<DailyMarketContext> }
  | undefined;

function toTaiwanDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().replaceAll("-", "").replaceAll("/", "");
  const match = /^(\d{3}|\d{4})(\d{2})(\d{2})$/.exec(compact);
  if (!match) return null;
  const year = match[1]!.length === 3
    ? Number(match[1]) + 1911
    : Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).replaceAll(",", "").trim();
  if (!normalized || normalized === "--" || normalized === "----") return null;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function currentTaiwanDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function getLatestTpexIndex(): Promise<DailyMarketContext["otcIndex"]> {
  const payload = await fetchOfficialJson(
    new URL(TPEX_INDEX_URL),
    "tpex",
    currentTaiwanDate(),
    fetch,
    AbortSignal.timeout(15_000),
  );
  if (!Array.isArray(payload)) return null;
  const entries = payload
    .map((value) => value as TpexIndexRow)
    .map((row) => ({
      date: toTaiwanDate(row.Date),
      close: finiteNumber(row.Close),
      change: finiteNumber(row.Change),
    }))
    .filter(
      (row): row is { date: string; close: number; change: number | null } =>
        row.date !== null && row.close !== null && row.close > 0,
    )
    .sort((left, right) => right.date.localeCompare(left.date));
  const latest = entries[0];
  return latest ? latest : null;
}

async function loadDailyContext(): Promise<DailyMarketContext> {
  const marketSourceSignal = AbortSignal.timeout(15_000);
  const [officialCloseResult, marketDaysResult, otcIndexResult] =
    await Promise.allSettled([
      getOfficialDailyCloseData(),
      getLatestOfficialMarketDays(marketSourceSignal),
      getLatestTpexIndex(),
    ]);
  const sources: AssistantChatSource[] = [];
  let breadth: DailyMarketContext["breadth"] = null;
  if (officialCloseResult.status === "fulfilled") {
    const { asOf, quotes } = officialCloseResult.value;
    const validChanges = quotes
      .map((quote) => quote.change)
      .filter((change): change is number => change !== null);
    breadth = {
      date: asOf,
      advances: validChanges.filter((change) => change > 0).length,
      declines: validChanges.filter((change) => change < 0).length,
      unchanged: validChanges.filter((change) => change === 0).length,
    };
    sources.push({
      title: "TWSE 上市與 TPEx 上櫃官方日行情",
      url: "https://openapi.twse.com.tw/",
    });
  }

  const turnover: DailyMarketContext["turnover"] = [];
  if (marketDaysResult.status === "fulfilled") {
    for (const day of marketDaysResult.value) {
      const amount = day.quotes.reduce((sum, quote) => sum + quote.turnover, 0);
      const volumeShares = day.quotes.reduce(
        (sum, quote) => sum + quote.volume,
        0,
      );
      if (
        day.quotes.length &&
        Number.isFinite(amount) &&
        amount > 0 &&
        Number.isFinite(volumeShares) &&
        volumeShares > 0
      ) {
        turnover.push({
          exchange: day.exchange === "twse" ? "上市" : "上櫃",
          date: day.date,
          volumeShares,
          amount,
        });
      }
    }
    if (turnover.length) {
      sources.push({
        title: "TWSE / TPEx 官方每日行情",
        url: "https://www.twse.com.tw/zh/trading/historical/mi-index.html",
      });
    }
  }

  let otcIndex: DailyMarketContext["otcIndex"] = null;
  if (otcIndexResult.status === "fulfilled" && otcIndexResult.value) {
    otcIndex = otcIndexResult.value;
    sources.push({
      title: "TPEx 櫃買指數官方日行情",
      url: TPEX_INDEX_URL,
    });
  }

  return { otcIndex, breadth, turnover, sources };
}

function getDailyContext(): Promise<DailyMarketContext> {
  if (dailyContextCache && dailyContextCache.expiresAt > Date.now()) {
    return dailyContextCache.promise;
  }
  const promise = loadDailyContext();
  dailyContextCache = {
    expiresAt: Date.now() + DAILY_CONTEXT_TTL_MS,
    promise,
  };
  void promise.catch(() => {
    if (dailyContextCache?.promise === promise) dailyContextCache = undefined;
  });
  void promise.then((context) => {
    if (
      !context.otcIndex &&
      !context.breadth &&
      context.turnover.length === 0 &&
      dailyContextCache?.promise === promise
    ) {
      dailyContextCache = undefined;
    }
  });
  return promise;
}

export async function getTaiwanBroadMarketContext(): Promise<{
  taiex: {
    price: number | null;
    change: number | null;
    changePercent: number | null;
    asOf: string | null;
    source: string | null;
    status: string;
  };
  otcIndex: DailyMarketContext["otcIndex"];
  breadth: DailyMarketContext["breadth"];
  turnover: DailyMarketContext["turnover"];
  unavailable: string[];
  sources: AssistantChatSource[];
}> {
  const [taiexResult, dailyContextResult] = await Promise.allSettled([
    getTaiexQuote(),
    getDailyContext(),
  ]);
  const unavailable: string[] = [];
  const sources: AssistantChatSource[] = [];
  const taiex =
    taiexResult.status === "fulfilled" && taiexResult.value.available
      ? taiexResult.value
      : null;
  if (taiex) {
    sources.push({
      title: taiex.source ?? "加權指數行情",
      url: "https://developer.fugle.tw/docs/data/intro/",
    });
  } else {
    unavailable.push("加權指數");
  }

  const daily =
    dailyContextResult.status === "fulfilled" ? dailyContextResult.value : null;
  if (!daily?.otcIndex) unavailable.push("櫃買指數");
  if (!daily?.breadth) unavailable.push("漲跌家數");
  if (!daily?.turnover.length) unavailable.push("成交金額");
  if (daily) sources.push(...daily.sources);

  const taiexSource = taiex?.source ?? "";
  const taiexIsClose =
    /最近收盤|盤後最後|非交易時段更新/u.test(taiexSource);
  const taiexAsOf =
    taiex?.asOf instanceof Date ? taiex.asOf.toISOString() : null;

  return {
    taiex: {
      price: taiex?.price ?? null,
      change: taiex?.change ?? null,
      changePercent: taiex?.changePercent ?? null,
      asOf: taiexAsOf,
      source: taiexSource || null,
      status: taiexIsClose ? "latest_official_close_or_off_session" : "live_quote",
    },
    otcIndex: daily?.otcIndex ?? null,
    breadth: daily?.breadth ?? null,
    turnover: daily?.turnover ?? [],
    unavailable,
    sources,
  };
}
