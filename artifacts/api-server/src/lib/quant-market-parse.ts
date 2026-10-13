export type QuantExchange = "twse" | "tpex";

export type QuantMarketQuote = {
  symbol: string;
  ticker: string;
  name: string;
  exchange: QuantExchange;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
};

export type ParsedQuantMarketDay = {
  date: string;
  exchange: QuantExchange;
  quotes: QuantMarketQuote[];
  benchmarkClose: number | null;
  source: string;
  sourceUrl: string;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : null;
}

function rows(value: unknown): string[][] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is string[] =>
          Array.isArray(row) && row.every((cell) => typeof cell === "string"),
      )
    : [];
}

export function parseExchangeNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).replaceAll(",", "").trim();
  if (!normalized || normalized === "--" || normalized === "----") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function validQuote(
  row: string[],
  columns: {
    symbol: number;
    name: number;
    volume: number;
    turnover: number;
    open: number;
    high: number;
    low: number;
    close: number;
  },
  exchange: QuantExchange,
): QuantMarketQuote | null {
  const symbol = row[columns.symbol]?.trim().toUpperCase();
  const name = row[columns.name]?.trim();
  const volume = parseExchangeNumber(row[columns.volume]);
  const turnover = parseExchangeNumber(row[columns.turnover]);
  const open = parseExchangeNumber(row[columns.open]);
  const high = parseExchangeNumber(row[columns.high]);
  const low = parseExchangeNumber(row[columns.low]);
  const close = parseExchangeNumber(row[columns.close]);
  if (
    !symbol ||
    !name ||
    !/^[A-Z0-9]{4,6}$/.test(symbol) ||
    volume === null ||
    turnover === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    high < Math.max(open, close, low) ||
    low > Math.min(open, close, high)
  ) {
    return null;
  }

  return {
    symbol,
    ticker: `${symbol}.${exchange === "twse" ? "TW" : "TWO"}`,
    name,
    exchange,
    open,
    high,
    low,
    close,
    volume,
    turnover,
  };
}

function validateRequestedDate(
  payloadDate: unknown,
  requestedDate: string,
): void {
  const compact = requestedDate.replaceAll("-", "");
  if (
    typeof payloadDate !== "string" ||
    payloadDate.replaceAll("/", "").replaceAll("-", "") !== compact
  ) {
    throw new Error("Official market response date did not match the request.");
  }
}

export function parseTwseDailyMarket(
  payload: unknown,
  requestedDate: string,
  sourceUrl: string,
): ParsedQuantMarketDay {
  const response = record(payload);
  if (!response) throw new Error("TWSE returned an invalid JSON response.");
  const stat = typeof response.stat === "string" ? response.stat : "";
  if (/沒有符合條件的資料|no data/i.test(stat)) {
    return {
      date: requestedDate,
      exchange: "twse",
      quotes: [],
      benchmarkClose: null,
      source: "TWSE official daily market report",
      sourceUrl,
    };
  }
  validateRequestedDate(response.date, requestedDate);
  const tables = Array.isArray(response.tables) ? response.tables : [];
  const quoteTable = tables
    .map(record)
    .find((table) =>
      typeof table?.title === "string" &&
      table.title.includes("每日收盤行情"),
    );
  if (!quoteTable) {
    throw new Error("TWSE daily market table was not present in the response.");
  }

  const quotes = rows(quoteTable.data)
    .map((row) =>
      validQuote(
        row,
        {
          symbol: 0,
          name: 1,
          volume: 2,
          turnover: 4,
          open: 5,
          high: 6,
          low: 7,
          close: 8,
        },
        "twse",
      ),
    )
    .filter((quote): quote is QuantMarketQuote => quote !== null);

  let benchmarkClose: number | null = null;
  for (const rawTable of tables) {
    const table = record(rawTable);
    for (const row of rows(table?.data)) {
      if (row[0]?.includes("發行量加權股價指數")) {
        benchmarkClose = parseExchangeNumber(row[1]);
        break;
      }
    }
    if (benchmarkClose !== null) break;
  }

  return {
    date: requestedDate,
    exchange: "twse",
    quotes,
    benchmarkClose,
    source: "TWSE official daily market report",
    sourceUrl,
  };
}

export function parseTpexDailyMarket(
  payload: unknown,
  requestedDate: string,
  sourceUrl: string,
): ParsedQuantMarketDay {
  const response = record(payload);
  if (!response) throw new Error("TPEx returned an invalid JSON response.");
  validateRequestedDate(response.date, requestedDate);
  const tables = Array.isArray(response.tables) ? response.tables : [];
  const quoteTable = record(tables[0]);
  if (!quoteTable || !Array.isArray(quoteTable.data)) {
    throw new Error("TPEx daily market table was not present in the response.");
  }

  const quotes = rows(quoteTable.data)
    .map((row) =>
      validQuote(
        row,
        {
          symbol: 0,
          name: 1,
          close: 2,
          open: 4,
          high: 5,
          low: 6,
          volume: 8,
          turnover: 9,
        },
        "tpex",
      ),
    )
    .filter((quote): quote is QuantMarketQuote => quote !== null);

  return {
    date: requestedDate,
    exchange: "tpex",
    quotes,
    benchmarkClose: null,
    source: "TPEx official daily market report",
    sourceUrl,
  };
}

export function isFundOrEtf(symbol: string): boolean {
  return symbol.trim().toUpperCase().startsWith("00");
}
