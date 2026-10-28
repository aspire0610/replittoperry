import {
  getOfficialDailyCloseData,
  getStockCatalog,
} from "./market-data.js";
import { logger } from "./logger.js";
import {
  parseEtfNavDisclosure,
  type EtfNavDisclosure,
} from "./etf-nav-disclosure.js";

export type EtfDistributionRecord = {
  exDividendDate: string;
  paymentDate: string;
  cashAmountPerUnit: number | null;
  announcedYear: number | null;
};

export type EtfDistributionData = {
  symbol: string;
  status: "available" | "unavailable";
  reason: string | null;
  fundName: string | null;
  records: EtfDistributionRecord[];
  source: string | null;
  sourceUrl: string | null;
  fetchedAt: string | null;
};

const TWSE_ETF_DIVIDEND_PAGE =
  "https://www.twse.com.tw/zh/ETFortune-institute/dividendList";
const TWSE_ETF_NAV_DISCLOSURE =
  "https://mis.twse.com.tw/stock/data/all_etf.txt";
const cache = new Map<
  string,
  { expiresAt: number; promise: Promise<EtfDistributionData> }
>();
let marketCache: { expiresAt: number; promise: Promise<EtfMarketData> } | null = null;

export type EtfMarketInstrument = {
  symbol: string;
  ticker: string;
  name: string;
  exchangeName: "上市" | "上櫃";
  price: number | null;
  marketPrice: number | null;
  netAssetValue: number | null;
  discountPremiumAmount: number | null;
  discountPremiumPercent: number | null;
  navUpdatedAt: string | null;
  distributions: Array<{
    exDividendDate: string;
    paymentDate: string;
    cashAmountPerUnit: number;
  }>;
  trailing12MonthDividend: number;
  trailing12MonthYieldPercent: number | null;
  latestDistribution: number | null;
  frequency: string;
};

export type EtfMarketData = {
  asOf: string;
  source: string;
  navDataStatus: "available" | "partial" | "unavailable";
  navDataUpdatedAt: string | null;
  instruments: EtfMarketInstrument[];
};

function cleanHtmlText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value: string) =>
      String.fromCodePoint(Number(value)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) =>
      String.fromCodePoint(Number.parseInt(value, 16)),
    )
    .replace(/\s+/g, " ")
    .trim();
}

function validDate(value: string): string | null {
  const normalized = value.trim();
  const gregorian = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  const roc = normalized.match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日$/);
  if (!gregorian && !roc) return null;
  const year = Number((gregorian ?? roc)![1]) + (roc ? 1911 : 0);
  const month = Number((gregorian ?? roc)![2]);
  const day = Number((gregorian ?? roc)![3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseAmount(value: string): number | null {
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized || normalized === "-" || normalized === "--") return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function unavailable(
  symbol: string,
  reason: string,
  sourceUrl: string | null = null,
): EtfDistributionData {
  return {
    symbol,
    status: "unavailable",
    reason,
    fundName: null,
    records: [],
    source: null,
    sourceUrl,
    fetchedAt: null,
  };
}

export function parseEtfDistributionHtml(
  html: string,
  symbol: string,
  sourceUrl: string,
  fetchedAt = new Date().toISOString(),
): EtfDistributionData {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const records: EtfDistributionRecord[] = [];
  let fundName: string | null = null;

  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => cleanHtmlText(cell[1]!));
    if (cells.length < 6 || cells[0]!.toUpperCase() !== normalizedSymbol) {
      continue;
    }

    const exDividendDate = validDate(cells[2]!);
    const modernPaymentDate = validDate(cells[4]!);
    const paymentDate = modernPaymentDate ?? validDate(cells[3]!);
    if (!exDividendDate || !paymentDate) continue;

    fundName ??= cells[1] || null;
    const amountIndex = modernPaymentDate ? 5 : 4;
    const yearValue = Number(cells.at(-1));
    const announcedYear =
      Number.isInteger(yearValue) && yearValue > 0
        ? yearValue < 1911
          ? yearValue + 1911
          : yearValue
        : null;
    records.push({
      exDividendDate,
      paymentDate,
      cashAmountPerUnit: parseAmount(cells[amountIndex] ?? ""),
      announcedYear,
    });
  }

  if (!records.length) {
    return unavailable(
      normalizedSymbol,
      "官方 ETF 配息資料中沒有可辨識的紀錄",
      sourceUrl,
    );
  }

  records.sort((left, right) =>
    right.exDividendDate.localeCompare(left.exDividendDate),
  );
  return {
    symbol: normalizedSymbol,
    status: "available",
    reason: null,
    fundName,
    records: records.slice(0, 20),
    source: "臺灣證券交易所 ETF 配息資料",
    sourceUrl,
    fetchedAt,
  };
}

function taipeiDate(): { year: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  const year = Number(values.year);
  return {
    year,
    date: `${year}/${values.month}/${values.day}`,
  };
}

function distributionFrequency(count: number): string {
  if (count >= 10) return "月配";
  if (count >= 4) return "季配";
  if (count >= 2) return "半年配";
  if (count === 1) return "年配";
  return "未配息";
}

function parseAllEtfRows(
  html: string,
  since: string,
  through: string,
): Map<string, EtfDistributionRecord[]> {
  const grouped = new Map<string, EtfDistributionRecord[]>();
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => cleanHtmlText(cell[1]!));
    if (cells.length < 6 || !/^00[A-Z0-9]{2,4}$/i.test(cells[0]!)) continue;
    const exDividendDate = validDate(cells[2]!);
    const paymentDate = validDate(cells[4]!) ?? validDate(cells[3]!);
    const cashAmountPerUnit = parseAmount(cells[5]!);
    if (
      !exDividendDate ||
      exDividendDate < since ||
      exDividendDate > through ||
      !paymentDate ||
      cashAmountPerUnit === null
    ) continue;
    const rawYear = Number(cells.at(-1));
    const record = {
      exDividendDate,
      paymentDate,
      cashAmountPerUnit,
      announcedYear: Number.isInteger(rawYear) && rawYear > 0
        ? rawYear < 1911 ? rawYear + 1911 : rawYear
        : null,
    };
    const symbol = cells[0]!.toUpperCase();
    const records = grouped.get(symbol) ?? [];
    records.push(record);
    grouped.set(symbol, records);
  }
  for (const records of grouped.values()) {
    records.sort((left, right) => right.exDividendDate.localeCompare(left.exDividendDate));
  }
  return grouped;
}

export async function getEtfMarketData(): Promise<EtfMarketData> {
  if (marketCache && marketCache.expiresAt > Date.now()) return marketCache.promise;
  const promise = (async (): Promise<EtfMarketData> => {
    const { year, date } = taipeiDate();
    const startIso = new Date(`${date.replaceAll("/", "-")}T00:00:00Z`);
    startIso.setUTCFullYear(startIso.getUTCFullYear() - 1);
    const since = startIso.toISOString().slice(0, 10);
    const start = since.replaceAll("-", "/");
    const end = date;
    const url = new URL(TWSE_ETF_DIVIDEND_PAGE);
    url.searchParams.set("startDate", start);
    url.searchParams.set("endDate", end);
    const navUrl = new URL(TWSE_ETF_NAV_DISCLOSURE);
    navUrl.searchParams.set("_", String(Date.now()));
    const [catalog, market, response, navDisclosure] = await Promise.all([
      getStockCatalog(),
      getOfficialDailyCloseData(),
      fetch(url, {
        headers: {
          Accept: "text/html",
          "User-Agent": "Mozilla/5.0 (compatible: TaiwanStockDashboard/1.0)",
        },
        signal: AbortSignal.timeout(12_000),
      }),
      fetch(navUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible: TaiwanStockDashboard/1.0)",
          Referer:
            "https://mis.twse.com.tw/stock/various-areas/etf-price/indicator-disclosure-etf?lang=zhHant",
        },
        signal: AbortSignal.timeout(8_000),
      })
        .then(async (navResponse): Promise<Map<string, EtfNavDisclosure>> => {
          if (!navResponse.ok) {
            throw new Error(
              `TWSE ETF NAV disclosure request failed: HTTP ${navResponse.status}`,
            );
          }
          const parsed = parseEtfNavDisclosure(await navResponse.json());
          if (parsed.size === 0) {
            throw new Error("TWSE ETF NAV disclosure contained no valid rows");
          }
          return parsed;
        })
        .catch((error: unknown): Map<string, EtfNavDisclosure> => {
          logger.warn(
            { err: error },
            "Unable to load official ETF NAV disclosure data",
          );
          return new Map();
        }),
    ]);
    if (!response.ok) throw new Error(`TWSE ETF distribution request failed: HTTP ${response.status}`);
    const distributionsBySymbol = parseAllEtfRows(
      await response.text(),
      since,
      date.replaceAll("/", "-"),
    );
    const quotes = new Map(market.quotes.map((quote) => [quote.symbol, quote]));
    const priceAsOf = market.asOf.slice(0, 10);
    const latestPriceDate = new Date(`${priceAsOf}T00:00:00Z`).getTime();
    const instruments = catalog.instruments
      .filter((instrument) => /^00[A-Z0-9]{2,4}$/.test(instrument.symbol))
      .map((instrument): EtfMarketInstrument => {
        const distributions = (distributionsBySymbol.get(instrument.symbol) ?? [])
          .filter((record) => record.cashAmountPerUnit !== null)
          .map((record) => ({
            exDividendDate: record.exDividendDate,
            paymentDate: record.paymentDate,
            cashAmountPerUnit: record.cashAmountPerUnit!,
          }));
        const trailing12MonthDividend = distributions.reduce(
          (sum, record) => sum + record.cashAmountPerUnit,
          0,
        );
        const price = quotes.get(instrument.symbol)?.close ?? null;
        const rawNavDisclosure = navDisclosure.get(instrument.symbol);
        const navDisclosureDate = rawNavDisclosure?.updatedAt
          ? new Date(rawNavDisclosure.updatedAt).getTime()
          : null;
        const validNavDisclosure =
          navDisclosureDate !== null &&
          navDisclosureDate >= latestPriceDate - 7 * 24 * 60 * 60 * 1_000
            ? rawNavDisclosure
            : undefined;
        const monthCount = new Set(distributions.map((record) => record.exDividendDate.slice(0, 7))).size;
        return {
          symbol: instrument.symbol,
          ticker: instrument.ticker,
          name: instrument.name,
          exchangeName: instrument.exchangeName,
          price,
          marketPrice: validNavDisclosure?.marketPrice ?? null,
          netAssetValue: validNavDisclosure?.netAssetValue ?? null,
          discountPremiumAmount:
            validNavDisclosure?.discountPremiumAmount ?? null,
          discountPremiumPercent:
            validNavDisclosure?.discountPremiumPercent ?? null,
          navUpdatedAt: validNavDisclosure?.updatedAt ?? null,
          distributions,
          trailing12MonthDividend,
          trailing12MonthYieldPercent: price ? (trailing12MonthDividend / price) * 100 : null,
          latestDistribution: distributions[0]?.cashAmountPerUnit ?? null,
          frequency: distributionFrequency(monthCount),
        };
      })
      .sort((left, right) => left.symbol.localeCompare(right.symbol));
    const navCoveredCount = instruments.filter(
      (instrument) =>
        instrument.marketPrice !== null && instrument.netAssetValue !== null,
    ).length;
    const navDataStatus: EtfMarketData["navDataStatus"] =
      navCoveredCount === 0
        ? "unavailable"
        : navCoveredCount === instruments.length
          ? "available"
          : "partial";
    const navDataUpdatedAt =
      instruments
        .map((instrument) => instrument.navUpdatedAt)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null;
    return {
      asOf: priceAsOf,
      source:
        "臺灣證券交易所、櫃買中心行情、證交所 ETF 配息紀錄及證交所 MIS ETF 淨值揭露",
      navDataStatus,
      navDataUpdatedAt,
      instruments,
    };
  })();
  marketCache = { expiresAt: Date.now() + 5 * 60_000, promise };
  try {
    return await promise;
  } catch (error) {
    marketCache = null;
    throw error;
  }
}

export async function getEtfDistributionData(
  symbol: string,
): Promise<EtfDistributionData> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!/^00[A-Z0-9]{2,4}$/.test(normalizedSymbol)) {
    return unavailable(normalizedSymbol, "此代號不符合臺灣 ETF 代號格式");
  }

  const cached = cache.get(normalizedSymbol);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const { year: currentYear, date: endDate } = taipeiDate();
  const url = new URL(TWSE_ETF_DIVIDEND_PAGE);
  url.searchParams.set("startDate", `${currentYear - 4}/01/01`);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("stkNo", normalizedSymbol);
  const sourceUrl = url.toString();

  const promise = (async () => {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 (compatible; TaiwanStockDashboard/1.0)",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`TWSE ETF distribution request failed: HTTP ${response.status}`);
    }
    const html = await response.text();
    return parseEtfDistributionHtml(
      html,
      normalizedSymbol,
      sourceUrl,
      new Date().toISOString(),
    );
  })();

  cache.set(normalizedSymbol, {
    expiresAt: Date.now() + 30 * 60_000,
    promise,
  });
  try {
    return await promise;
  } catch (error) {
    cache.delete(normalizedSymbol);
    return unavailable(
      normalizedSymbol,
      error instanceof Error ? error.message : "官方 ETF 配息資料暫時無法取得",
      sourceUrl,
    );
  }
}
