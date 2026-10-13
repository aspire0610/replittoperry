import { desc, eq, and } from "drizzle-orm";
import type { PaperTradeInput } from "@workspace/api-zod";
import {
  db,
  paperTradingAccountsTable,
  paperTradingPositionsTable,
  paperTradingTradesTable,
} from "@workspace/db";
import { getLatestOfficialMarketDays } from "./quant-market-data.js";
import { isFundOrEtf } from "./quant-market-parse.js";
import { calculatePaperTradeCosts } from "./paper-trading-math.js";

const PORTFOLIO_DISCLAIMER =
  "僅為帳面模擬，成交價由使用者輸入，持倉市值依最近官方原始收盤價估值，兩者皆不代表可成交價格。預估手續費按每邊 0.1425%，賣出證交稅按股票 0.3%、代碼 00 開頭基金／ETF 0.1%；不含除權息、股利、券商最低手續費、折扣與實際滑價，且不會送出真實委託。";

export type PaperTradingPortfolioJson = {
  initialized: boolean;
  startingCash: number | null;
  cash: number | null;
  marketValue: number | null;
  equity: number | null;
  returnPercent: number | null;
  asOf: string | null;
  positions: Array<{
    ticker: string;
    name: string;
    shares: number;
    averageCost: number;
    latestClose: number | null;
    marketValue: number | null;
    unrealizedPnl: number | null;
  }>;
  trades: Array<{
    id: number;
    ticker: string;
    name: string;
    side: "buy" | "sell";
    shares: number;
    price: number;
    grossAmount: number;
    commission: number;
    transactionTax: number;
    realizedPnl: number;
    tradingDate: string;
    createdAt: string;
  }>;
  disclaimer: string;
};

export class PaperTradingError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PaperTradingError";
  }
}

function asNumber(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new PaperTradingError("模擬帳戶的金額資料無效。", 503);
  }
  return parsed;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function amount(value: number): string {
  return roundMoney(value).toFixed(2);
}

function emptyPortfolio(): PaperTradingPortfolioJson {
  return {
    initialized: false,
    startingCash: null,
    cash: null,
    marketValue: null,
    equity: null,
    returnPercent: null,
    asOf: null,
    positions: [],
    trades: [],
    disclaimer: PORTFOLIO_DISCLAIMER,
  };
}

export async function createPaperTradingAccount(
  userId: string,
  startingCash: number,
): Promise<PaperTradingPortfolioJson> {
  const [account] = await db
    .insert(paperTradingAccountsTable)
    .values({
      userId,
      startingCash: amount(startingCash),
      cash: amount(startingCash),
    })
    .onConflictDoNothing({ target: paperTradingAccountsTable.userId })
    .returning({ userId: paperTradingAccountsTable.userId });

  if (!account) {
    throw new PaperTradingError("紙上交易帳戶已建立，起始本金不會被覆寫。", 409);
  }
  return getPaperTradingPortfolio(userId);
}

export async function resetPaperTradingAccount(
  userId: string,
): Promise<PaperTradingPortfolioJson> {
  await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(paperTradingAccountsTable)
      .where(eq(paperTradingAccountsTable.userId, userId))
      .for("update")
      .limit(1);
    if (!account) {
      throw new PaperTradingError("請先建立紙上交易帳戶。", 409);
    }

    await tx
      .delete(paperTradingPositionsTable)
      .where(eq(paperTradingPositionsTable.userId, userId));
    await tx
      .delete(paperTradingTradesTable)
      .where(eq(paperTradingTradesTable.userId, userId));
    await tx
      .update(paperTradingAccountsTable)
      .set({
        cash: account.startingCash,
        updatedAt: new Date(),
      })
      .where(eq(paperTradingAccountsTable.userId, userId));
  });
  return getPaperTradingPortfolio(userId);
}

export async function getPaperTradingPortfolio(
  userId: string,
): Promise<PaperTradingPortfolioJson> {
  const [account] = await db
    .select()
    .from(paperTradingAccountsTable)
    .where(eq(paperTradingAccountsTable.userId, userId))
    .limit(1);
  if (!account) return emptyPortfolio();

  const positions = await db
    .select()
    .from(paperTradingPositionsTable)
    .where(eq(paperTradingPositionsTable.userId, userId));
  const trades = await db
    .select()
    .from(paperTradingTradesTable)
    .where(eq(paperTradingTradesTable.userId, userId))
    .orderBy(desc(paperTradingTradesTable.createdAt))
    .limit(100);

  const latestDays =
    positions.length > 0 ? await getLatestOfficialMarketDays() : [];
  const quoteByTicker = new Map(
    latestDays.flatMap((day) =>
      day.quotes.map((quote) => [quote.ticker, quote] as const),
    ),
  );
  const serializedPositions = positions.map((position) => {
    const quote = quoteByTicker.get(position.ticker);
    const averageCost = asNumber(position.averageCost);
    const marketValue =
      quote === undefined
        ? null
        : roundMoney(position.shares * quote.close);
    return {
      ticker: position.ticker,
      name: quote?.name ?? position.name,
      shares: position.shares,
      averageCost,
      latestClose: quote?.close ?? null,
      marketValue,
      unrealizedPnl:
        marketValue === null
          ? null
          : roundMoney(marketValue - position.shares * averageCost),
    };
  });
  const hasUnpricedPosition = serializedPositions.some(
    (position) => position.marketValue === null,
  );
  const knownMarketValue = serializedPositions.reduce(
    (total, position) => total + (position.marketValue ?? 0),
    0,
  );
  const cash = asNumber(account.cash);
  const marketValue = hasUnpricedPosition ? null : roundMoney(knownMarketValue);
  const equity = marketValue === null ? null : roundMoney(cash + marketValue);
  const startingCash = asNumber(account.startingCash);
  const latestDate = latestDays
    .filter((day) =>
      positions.some((position) =>
        day.exchange === (position.ticker.endsWith(".TWO") ? "tpex" : "twse"),
      ),
    )
    .map((day) => day.date)
    .sort()
    [0];

  return {
    initialized: true,
    startingCash,
    cash,
    marketValue,
    equity,
    returnPercent:
      equity === null || startingCash <= 0
        ? null
        : ((equity / startingCash) - 1) * 100,
    asOf: latestDate ?? null,
    positions: serializedPositions,
    trades: trades.map((trade) => ({
      id: trade.id,
      ticker: trade.ticker,
      name: trade.name,
      side: trade.side as "buy" | "sell",
      shares: trade.shares,
      price: asNumber(trade.price),
      grossAmount: asNumber(trade.grossAmount),
      commission: asNumber(trade.commission),
      transactionTax: asNumber(trade.transactionTax),
      realizedPnl: asNumber(trade.realizedPnl),
      tradingDate: trade.tradingDate,
      createdAt: trade.createdAt.toISOString(),
    })),
    disclaimer: PORTFOLIO_DISCLAIMER,
  };
}

export async function recordPaperTrade(
  userId: string,
  input: PaperTradeInput,
): Promise<PaperTradingPortfolioJson> {
  if (!Number.isFinite(input.price) || input.price < 0.01 || input.price > 1_000_000) {
    throw new PaperTradingError("請輸入介於 NT$0.01 至 NT$1,000,000 的模擬成交價。");
  }
  const ticker = input.ticker.trim().toUpperCase();
  const exchange = ticker.endsWith(".TWO") ? "tpex" : "twse";
  const latestDays = await getLatestOfficialMarketDays();
  const latestDay = latestDays.find((day) => day.exchange === exchange);
  const quote = latestDay?.quotes.find((item) => item.ticker === ticker);
  if (!quote) {
    throw new PaperTradingError(
      "最近官方收盤行情找不到這檔證券，無法記錄模擬交易。",
      404,
    );
  }

  const { price, grossAmount, commission, transactionTax } =
    calculatePaperTradeCosts({
      side: input.side,
      shares: input.shares,
      price: input.price,
      isFundOrEtf: isFundOrEtf(quote.symbol),
    });

  await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(paperTradingAccountsTable)
      .where(eq(paperTradingAccountsTable.userId, userId))
      .for("update")
      .limit(1);
    if (!account) {
      throw new PaperTradingError("請先設定紙上交易起始本金。", 409);
    }

    const [position] = await tx
      .select()
      .from(paperTradingPositionsTable)
      .where(
        and(
          eq(paperTradingPositionsTable.userId, userId),
          eq(paperTradingPositionsTable.ticker, ticker),
        ),
      )
      .for("update")
      .limit(1);

    const cash = asNumber(account.cash);
    let nextCash: number;
    let realizedPnl = 0;

    if (input.side === "buy") {
      const totalCost = roundMoney(grossAmount + commission);
      if (cash < totalCost) {
        throw new PaperTradingError("可用模擬現金不足，無法買進。", 400);
      }
      nextCash = roundMoney(cash - totalCost);
      const priorShares = position?.shares ?? 0;
      const nextShares = priorShares + input.shares;
      const priorCost =
        priorShares > 0 && position
          ? asNumber(position.averageCost) * priorShares
          : 0;
      const averageCost = (priorCost + totalCost) / nextShares;
      await tx
        .insert(paperTradingPositionsTable)
        .values({
          userId,
          ticker,
          symbol: quote.symbol,
          name: quote.name,
          shares: nextShares,
          averageCost: averageCost.toFixed(4),
        })
        .onConflictDoUpdate({
          target: [
            paperTradingPositionsTable.userId,
            paperTradingPositionsTable.ticker,
          ],
          set: {
            name: quote.name,
            shares: nextShares,
            averageCost: averageCost.toFixed(4),
            updatedAt: new Date(),
          },
        });
    } else {
      if (!position || position.shares < input.shares) {
        throw new PaperTradingError("可賣股數不足，沒有建立模擬賣出。", 400);
      }
      const netProceeds = roundMoney(
        grossAmount - commission - transactionTax,
      );
      nextCash = roundMoney(cash + netProceeds);
      realizedPnl = roundMoney(
        netProceeds - asNumber(position.averageCost) * input.shares,
      );
      const remainingShares = position.shares - input.shares;
      if (remainingShares === 0) {
        await tx
          .delete(paperTradingPositionsTable)
          .where(
            and(
              eq(paperTradingPositionsTable.userId, userId),
              eq(paperTradingPositionsTable.ticker, ticker),
            ),
          );
      } else {
        await tx
          .update(paperTradingPositionsTable)
          .set({ shares: remainingShares, updatedAt: new Date() })
          .where(
            and(
              eq(paperTradingPositionsTable.userId, userId),
              eq(paperTradingPositionsTable.ticker, ticker),
            ),
          );
      }
    }

    await tx
      .update(paperTradingAccountsTable)
      .set({ cash: amount(nextCash), updatedAt: new Date() })
      .where(eq(paperTradingAccountsTable.userId, userId));
    await tx.insert(paperTradingTradesTable).values({
      userId,
      ticker,
      name: quote.name,
      side: input.side,
      shares: input.shares,
      price: price.toFixed(4),
      grossAmount: amount(grossAmount),
      commission: amount(commission),
      transactionTax: amount(transactionTax),
      realizedPnl: amount(realizedPnl),
      tradingDate: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    });
  });

  return getPaperTradingPortfolio(userId);
}
