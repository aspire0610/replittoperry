import type { ParsedQuantMarketDay } from "./quant-market-parse.js";

export class QuantTickerFilterError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 422,
  ) {
    super(message);
    this.name = "QuantTickerFilterError";
  }
}

export function normalizeQuantTickerFilter(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const match = /^([0-9]{4,6})(?:\.(TW|TWO))?$/i.exec(trimmed);
  if (!match) {
    throw new QuantTickerFilterError(
      "股票代碼格式不正確，請輸入 4 至 6 位數字，可加上 .TW 或 .TWO。",
      400,
    );
  }

  const symbol = match[1]!;
  const exchange = match[2]?.toUpperCase();
  return exchange ? `${symbol}.${exchange}` : symbol;
}

export function resolveQuantTickerFilter(
  filter: string | null,
  snapshots: ParsedQuantMarketDay[],
  requestedStartDate: string,
): string | null {
  if (!filter) return null;

  const match = /^([0-9]{4,6})(?:\.(TW|TWO))?$/.exec(filter);
  if (!match) {
    throw new QuantTickerFilterError(
      "股票代碼格式不正確，請輸入 4 至 6 位數字，可加上 .TW 或 .TWO。",
      400,
    );
  }

  const symbol = match[1]!;
  const expectedTicker = match[2] ? `${symbol}.${match[2]}` : null;
  const matches = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshot.date < requestedStartDate) continue;
    for (const quote of snapshot.quotes) {
      if (
        quote.symbol === symbol &&
        (!expectedTicker || quote.ticker === expectedTicker)
      ) {
        matches.add(quote.ticker);
      }
    }
  }

  if (matches.size === 0) {
    throw new QuantTickerFilterError(
      `所選股票 ${filter} 在這段回測期間沒有官方日行情，請確認代碼或延長期間。`,
      422,
    );
  }
  if (matches.size > 1) {
    throw new QuantTickerFilterError(
      `代碼 ${symbol} 同時出現在上市與上櫃，請加上 .TW 或 .TWO 指定市場。`,
      422,
    );
  }

  return matches.values().next().value ?? null;
}
