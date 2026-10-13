import { and, eq, gte, lte } from "drizzle-orm";
import { db, quantMarketSnapshotsTable } from "@workspace/db";
import {
  parseTpexDailyMarket,
  parseTwseDailyMarket,
  type ParsedQuantMarketDay,
  type QuantExchange,
} from "./quant-market-parse.js";
import {
  fetchOfficialJson,
  type OfficialJsonFetchRetry,
} from "./official-json-fetch.js";
import type { QuantResearchProgressCallback } from "./quant-research-progress.js";

const EXCHANGES: QuantExchange[] = ["twse", "tpex"];
const MAX_CONSECUTIVE_FETCH_FAILURES = 3;

export class QuantMarketDataError extends Error {
  readonly status = 502;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QuantMarketDataError";
  }
}

export type QuantMarketRange = {
  snapshots: ParsedQuantMarketDay[];
  fetchedDays: number;
  cachedDays: number;
};

type StoredMarketPayload = {
  quotes?: unknown;
  benchmarkClose?: unknown;
};

function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

function marketUrl(exchange: QuantExchange, date: string): URL {
  if (exchange === "twse") {
    const url = new URL(
      "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX",
    );
    url.searchParams.set("response", "json");
    url.searchParams.set("date", compactDate(date));
    url.searchParams.set("type", "ALLBUT0999");
    return url;
  }

  const url = new URL(
    "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes",
  );
  url.searchParams.set(
    "date",
    `${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}`,
  );
  return url;
}

async function fetchJson(
  url: URL,
  exchange: QuantExchange,
  date: string,
  signal?: AbortSignal,
  onRetry?: (retry: OfficialJsonFetchRetry) => void,
): Promise<unknown> {
  try {
    return await fetchOfficialJson(url, exchange, date, undefined, signal, {
      onRetry,
    });
  } catch (error) {
    const label = exchange === "twse" ? "TWSE" : "TPEx";
    const errorDetail = error instanceof Error ? error.message : String(error);
    let message: string;
    if (/timed out|timeout/i.test(errorDetail)) {
      message = `${label} ${date} 官方日行情回應逾時，請稍後重試。`;
    } else if (/connection|socket|terminated|closed/i.test(errorDetail)) {
      message = `${label} ${date} 官方日行情連線中斷，請稍後重試。`;
    } else if (/HTTP 307|without a Location header/i.test(errorDetail)) {
      message = `${label} ${date} 官方日行情端點回傳 HTTP 307，但未提供重新導向位置。請稍後重試。`;
    } else {
      message = `${label} ${date} 官方日行情目前無法取得，請稍後重試。`;
    }
    throw new QuantMarketDataError(
      message,
      { cause: error },
    );
  }
}

function parseSnapshot(
  exchange: QuantExchange,
  payload: unknown,
  date: string,
  url: URL,
): ParsedQuantMarketDay {
  try {
    return exchange === "twse"
      ? parseTwseDailyMarket(payload, date, url.toString())
      : parseTpexDailyMarket(payload, date, url.toString());
  } catch (error) {
    throw new QuantMarketDataError(
      `${exchange === "twse" ? "TWSE" : "TPEx"} ${date} 官方日行情格式無法辨識。`,
      { cause: error },
    );
  }
}

function parseStoredSnapshot(row: {
  exchange: string;
  tradingDate: string;
  payload: unknown;
  sourceUrl: string;
}): ParsedQuantMarketDay {
  const payload = row.payload as StoredMarketPayload;
  if (!Array.isArray(payload?.quotes)) {
    throw new QuantMarketDataError(
      `快取中的 ${row.exchange} ${row.tradingDate} 日行情格式錯誤。`,
    );
  }
  const exchange = row.exchange as QuantExchange;
  if (!EXCHANGES.includes(exchange)) {
    throw new QuantMarketDataError("日行情快取含有不支援的交易所。");
  }
  return {
    date: row.tradingDate,
    exchange,
    quotes: payload.quotes as ParsedQuantMarketDay["quotes"],
    benchmarkClose:
      typeof payload.benchmarkClose === "number" &&
      Number.isFinite(payload.benchmarkClose)
        ? payload.benchmarkClose
        : null,
    source:
      exchange === "twse"
        ? "TWSE official daily market report"
        : "TPEx official daily market report",
    sourceUrl: row.sourceUrl,
  };
}

function weekdayDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function fetchExchangeDays(
  exchange: QuantExchange,
  dates: string[],
  reportDayProgress: (
    exchange: QuantExchange,
    date: string,
    state: "fetching" | "retrying" | "saved" | "failed" | "paused",
    detail?: string,
  ) => void,
): Promise<{
  snapshots: ParsedQuantMarketDay[];
  failures: { exchange: QuantExchange; date: string; message: string }[];
  skippedDays: number;
}> {
  const fetched: ParsedQuantMarketDay[] = [];
  const failures: {
    exchange: QuantExchange;
    date: string;
    message: string;
  }[] = [];
  let consecutiveFailures = 0;
  let skippedDays = 0;
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const url = marketUrl(exchange, date);
    let snapshot: ParsedQuantMarketDay;
    try {
      reportDayProgress(exchange, date, "fetching");
      const payload = await fetchJson(
        url,
        exchange,
        date,
        undefined,
        (retry) => {
          reportDayProgress(
            exchange,
            date,
            "retrying",
            `第 ${retry.nextAttempt}/${retry.maxAttempts} 次重試，${Math.ceil(retry.delayMs / 1_000)} 秒後再試。`,
          );
        },
      );
      snapshot = parseSnapshot(exchange, payload, date, url);
    } catch (error) {
      if (!(error instanceof QuantMarketDataError)) throw error;
      consecutiveFailures += 1;
      failures.push({ exchange, date, message: error.message });
      reportDayProgress(
        exchange,
        date,
        "failed",
        `${error.message} 本次會先略過這一天，繼續讀取其他日期。`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
        skippedDays = dates.length - index - 1;
        if (skippedDays > 0) {
          reportDayProgress(
            exchange,
            date,
            "paused",
            `連續 ${MAX_CONSECUTIVE_FETCH_FAILURES} 個日期無法取得；本次暫停此交易所剩下的 ${skippedDays} 個日期，另一交易所仍會繼續。`,
          );
        }
        break;
      }
      continue;
    }
    await cacheSnapshots([snapshot]);
    fetched.push(snapshot);
    consecutiveFailures = 0;
    reportDayProgress(exchange, date, "saved");
  }
  return { snapshots: fetched, failures, skippedDays };
}

async function cacheSnapshots(
  snapshots: ParsedQuantMarketDay[],
): Promise<void> {
  const rows = snapshots.map((snapshot) => ({
    exchange: snapshot.exchange,
    tradingDate: snapshot.date,
    payload: {
      quotes: snapshot.quotes,
      benchmarkClose: snapshot.benchmarkClose,
    },
    sourceUrl: snapshot.sourceUrl,
  }));
  for (let start = 0; start < rows.length; start += 40) {
    await db
      .insert(quantMarketSnapshotsTable)
      .values(rows.slice(start, start + 40))
      .onConflictDoNothing({
        target: [
          quantMarketSnapshotsTable.exchange,
          quantMarketSnapshotsTable.tradingDate,
        ],
      });
  }
}

export async function getOfficialMarketRange(
  startDate: string,
  endDate: string,
  onProgress?: QuantResearchProgressCallback,
): Promise<QuantMarketRange> {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
    startDate > endDate
  ) {
    throw new QuantMarketDataError("回測日期範圍無效。");
  }

  const dates = weekdayDates(startDate, endDate);
  const cachedRows = await db
    .select()
    .from(quantMarketSnapshotsTable)
    .where(
      and(
        gte(quantMarketSnapshotsTable.tradingDate, startDate),
        lte(quantMarketSnapshotsTable.tradingDate, endDate),
      ),
    );
  const cached = new Map<string, ParsedQuantMarketDay>();
  for (const row of cachedRows) {
    const snapshot = parseStoredSnapshot(row);
    cached.set(`${snapshot.exchange}:${snapshot.date}`, snapshot);
  }

  const missingByExchange = new Map<QuantExchange, string[]>();
  for (const exchange of EXCHANGES) {
    missingByExchange.set(
      exchange,
      dates.filter((date) => !cached.has(`${exchange}:${date}`)),
    );
  }

  const totalDays = dates.length * EXCHANGES.length;
  let completedDays = cached.size;
  const exchangeLabel = (exchange: QuantExchange) =>
    exchange === "twse" ? "TWSE 上市" : "TPEx 上櫃";
  onProgress?.({
    type: "progress",
    stage: "market-data",
    message: `快取命中 ${cached.size} 個交易所日期，尚需取得 ${totalDays - cached.size} 個；開始讀取官方歷史日行情。`,
    current: completedDays,
    total: totalDays,
  });
  const reportDayProgress = (
    exchange: QuantExchange,
    date: string,
    state: "fetching" | "retrying" | "saved" | "failed" | "paused",
    detail?: string,
  ) => {
    if (state === "saved") completedDays += 1;
    const actionByState = {
      fetching: "正在讀取官方行情",
      retrying: "官方端點暫時未回應",
      saved: "已驗證並保存至快取",
      failed: "這一天讀取失敗",
      paused: "暫停此交易所後續日期",
    } satisfies Record<typeof state, string>;
    const action = actionByState[state];
    onProgress?.({
      type: "progress",
      stage: "market-data",
      message: `${exchangeLabel(exchange)} ${date}：${action}${detail ? `；${detail}` : "。"}`,
      current: completedDays,
      total: totalDays,
    });
  };

  const fetchGroups = EXCHANGES.map((exchange) =>
    fetchExchangeDays(
      exchange,
      missingByExchange.get(exchange) ?? [],
      reportDayProgress,
    ),
  );
  const settledGroups = await Promise.allSettled(fetchGroups);
  const unexpectedFailure = settledGroups.find(
    (group): group is PromiseRejectedResult => group.status === "rejected",
  );
  if (unexpectedFailure) throw unexpectedFailure.reason;
  const exchangeResults = settledGroups.flatMap((group) =>
    group.status === "fulfilled" ? [group.value] : [],
  );
  const fetched = exchangeResults.flatMap((result) => result.snapshots);
  const failures = exchangeResults.flatMap((result) => result.failures);
  const skippedDays = exchangeResults.reduce(
    (total, result) => total + result.skippedDays,
    0,
  );
  const missingDays = failures.length + skippedDays;
  if (missingDays > 0) {
    const failureDetails = failures
      .slice(0, 3)
      .map(
        (failure) =>
          `${failure.exchange === "twse" ? "TWSE" : "TPEx"} ${failure.date}：${failure.message}`,
      )
      .join("；");
    const omittedFailures = failures.length - Math.min(failures.length, 3);
    const remainingDetails = [
      omittedFailures > 0 ? `另有 ${omittedFailures} 個日期讀取失敗` : "",
      skippedDays > 0 ? `另有 ${skippedDays} 個日期因連續失敗暫未讀取` : "",
    ].filter(Boolean);
    const message = [
      `官方日行情仍缺少 ${missingDays} 個交易所日期。`,
      failureDetails,
      remainingDetails.join("；"),
      `已成功取得的 ${completedDays}/${totalDays} 個日期都已保存；重新執行會只補抓缺漏資料。`,
    ]
      .filter(Boolean)
      .join(" ");
    onProgress?.({
      type: "progress",
      stage: "market-data",
      message: `官方行情讀取結束，仍缺少 ${missingDays} 個交易所日期；已取得的資料已保存，可重新執行補抓。`,
      current: completedDays,
      total: totalDays,
    });
    throw new QuantMarketDataError(message, {
      cause: failures[0] ? new Error(failures[0].message) : undefined,
    });
  }

  const snapshots = [...cached.values(), ...fetched].sort((left, right) => {
    const dateOrder = left.date.localeCompare(right.date);
    return dateOrder || left.exchange.localeCompare(right.exchange);
  });
  return {
    snapshots,
    fetchedDays: fetched.length,
    cachedDays: cached.size,
  };
}

export async function getOfficialMarketDay(
  exchange: QuantExchange,
  date: string,
  signal?: AbortSignal,
): Promise<ParsedQuantMarketDay> {
  const [row] = await db
    .select()
    .from(quantMarketSnapshotsTable)
    .where(
      and(
        eq(quantMarketSnapshotsTable.exchange, exchange),
        eq(quantMarketSnapshotsTable.tradingDate, date),
      ),
    )
    .limit(1);
  if (row) return parseStoredSnapshot(row);

  const url = marketUrl(exchange, date);
  const snapshot = parseSnapshot(
    exchange,
    await fetchJson(url, exchange, date, signal),
    date,
    url,
  );
  await cacheSnapshots([snapshot]);
  return snapshot;
}

function taiwanDateParts(): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

function previousCalendarDay(date: string): string {
  const cursor = new Date(`${date}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  return cursor.toISOString().slice(0, 10);
}

export function getLastCompletedTaiwanMarketDate(): string {
  const current = taiwanDateParts();
  return current.hour > 15 || (current.hour === 15 && current.minute >= 30)
    ? current.date
    : previousCalendarDay(current.date);
}

export async function getLatestOfficialMarketDays(
  signal?: AbortSignal,
): Promise<
  ParsedQuantMarketDay[]
> {
  const endDate = getLastCompletedTaiwanMarketDate();
  const start = new Date(`${endDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 14);
  const startDate = start.toISOString().slice(0, 10);
  const candidates = weekdayDates(startDate, endDate).reverse();
  const latest = await Promise.all(
    EXCHANGES.map(async (exchange) => {
      for (const date of candidates) {
        const snapshot = await getOfficialMarketDay(exchange, date, signal);
        if (snapshot.quotes.length > 0) return snapshot;
      }
      throw new QuantMarketDataError(
        `最近兩週找不到 ${exchange === "twse" ? "上市" : "上櫃"} 官方收盤行情。`,
      );
    }),
  );
  return latest;
}
