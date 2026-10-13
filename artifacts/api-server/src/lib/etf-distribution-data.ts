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
const cache = new Map<
  string,
  { expiresAt: number; promise: Promise<EtfDistributionData> }
>();

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
