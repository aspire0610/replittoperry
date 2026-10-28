export type TwseMiIndexDailyCloseRow = {
  Date: string;
  Code: string;
  Name: string;
  ClosingPrice: string;
  Change: string;
  TradeVolume: string;
  TradeValue: string;
};

type MiIndexTable = {
  title?: unknown;
  fields?: unknown;
  data?: unknown;
};

type MiIndexPayload = {
  stat?: unknown;
  date?: unknown;
  tables?: unknown;
};

const MINIMUM_DAILY_CLOSE_ROWS = 1_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cell(row: unknown, index: number): string {
  if (!Array.isArray(row)) return "";
  const value = row[index];
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function directionText(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

export function parseTwseMiIndexDailyClose(
  input: unknown,
  expectedDate: string,
): TwseMiIndexDailyCloseRow[] {
  const payload = asRecord(input) as MiIndexPayload | null;
  const compactDate = expectedDate.replaceAll("-", "");
  if (
    !payload ||
    payload.stat !== "OK" ||
    payload.date !== compactDate ||
    !Array.isArray(payload.tables)
  ) {
    throw new Error("TWSE MI_INDEX 回應狀態或日期無法驗證");
  }

  const table = (payload.tables as unknown[])
    .map(asRecord)
    .find(
      (candidate) =>
        typeof candidate?.title === "string" &&
        candidate.title.includes("每日收盤行情"),
    ) as MiIndexTable | undefined;
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.data)) {
    throw new Error("TWSE MI_INDEX 缺少每日收盤行情表");
  }

  const fields = table.fields;
  const indexes = {
    symbol: fields.indexOf("證券代號"),
    name: fields.indexOf("證券名稱"),
    volume: fields.indexOf("成交股數"),
    tradedValue: fields.indexOf("成交金額"),
    close: fields.indexOf("收盤價"),
    direction: fields.indexOf("漲跌(+/-)"),
    changeAmount: fields.indexOf("漲跌價差"),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    throw new Error("TWSE MI_INDEX 收盤行情欄位不完整");
  }
  if (table.data.length < MINIMUM_DAILY_CLOSE_ROWS) {
    throw new Error("TWSE MI_INDEX 收盤行情筆數不足");
  }

  const [year, month, day] = [
    Number(compactDate.slice(0, 4)),
    compactDate.slice(4, 6),
    compactDate.slice(6, 8),
  ];
  const rocDate = `${year - 1911}${month}${day}`;

  const parsedRows = table.data.flatMap((sourceRow): TwseMiIndexDailyCloseRow[] => {
    const Code = cell(sourceRow, indexes.symbol);
    const Name = cell(sourceRow, indexes.name);
    const ClosingPrice = cell(sourceRow, indexes.close);
    if (!Code || !Name || !ClosingPrice || ClosingPrice === "--") return [];

    const rawAmount = cell(sourceRow, indexes.changeAmount);
    const amount = rawAmount.replaceAll(",", "");
    const direction = directionText(cell(sourceRow, indexes.direction));
    const Change =
      direction === "+"
        ? amount
        : direction === "-"
          ? `-${amount.replace(/^-/, "")}`
          : Number(amount) === 0
            ? "0"
            : "";

    return [{
      Date: rocDate,
      Code,
      Name,
      ClosingPrice,
      Change,
      TradeVolume: cell(sourceRow, indexes.volume),
      TradeValue: cell(sourceRow, indexes.tradedValue),
    }];
  });
  if (parsedRows.length < MINIMUM_DAILY_CLOSE_ROWS) {
    throw new Error("TWSE MI_INDEX 有效收盤行情筆數不足");
  }
  return parsedRows;
}
