import { Router, type IRouter, type Request, type Response } from "express";
import { clerkClient, type User } from "@clerk/express";
import { timingSafeEqual } from "node:crypto";
import {
  getStockHistory,
  getStockQuote,
} from "../lib/market-data.js";
import { MAX_VERIFIED_STOCK_TRADE_AGE_MS } from "../lib/stock-ai-quote-policy.js";
import {
  getInvestmentTrustBuyStreak,
  getOfficialHolderMarginScore,
  getStockInstitutionalData,
} from "../lib/stock-research-data.js";
import {
  buildStockMarkdownReport,
  buildStockScorecard,
  buildStockTradeScenarios,
  qualifiesForAutomatedQuantSignal,
} from "../lib/stock-scorecard.js";

const router: IRouter = Router();
const APP_METADATA_KEY = "twStockDashboard";
const TZ = "Asia/Taipei";

type Session = "intraday" | "closing";
type Settings = {
  lineUserId?: string;
  quantSignalAlerts?: boolean;
  quantSignalIntradayDate?: string;
  quantSignalIntradaySentSymbols?: string[];
  quantSignalClosingDate?: string;
  quantSignalClosingSentSymbols?: string[];
};
type Candidate = { report: string };

function taiwanDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function isWeekday(): boolean {
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date()),
  );
}

function metadata(user: User): Record<string, unknown> {
  const value = user.privateMetadata[APP_METADATA_KEY];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function settings(user: User): Settings {
  const value = metadata(user).lineNotifications;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Settings
    : {};
}

function authorized(header: string | undefined): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const left = Buffer.from(header.slice(7)), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function watchlist(user: User): Array<{ symbol: string; ticker?: string }> {
  const value = metadata(user).watchlist;
  if (!Array.isArray(value)) return [];
  const found = new Map<string, { symbol: string; ticker?: string }>();
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof (item as { symbol?: unknown }).symbol !== "string") continue;
    const row = item as { symbol: string; ticker?: unknown };
    const symbol = row.symbol.replace(/\.(TW|TWO)$/i, "").trim().toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(symbol)) continue;
    const ticker = typeof row.ticker === "string" && /\.(TW|TWO)$/i.test(row.ticker)
      ? row.ticker.toUpperCase()
      : undefined;
    found.set(symbol, { symbol, ...(ticker ? { ticker } : {}) });
  }
  return [...found.values()];
}

function quoteChange(current: number, previous: number | null): number | null {
  return previous && previous > 0 ? ((current / previous) - 1) * 100 : null;
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await operation(items[index]!);
    }
  }));
  return results;
}

async function scanStock(symbol: string, ticker: string | undefined, session: Session, today: string): Promise<Candidate | null> {
  const history = await getStockHistory(ticker ?? symbol, "1y");
  const bars = history.bars.filter((bar) => session === "intraday" ? bar.date < today : true);
  const latest = bars.at(-1);
  if (!latest || bars.length < 60) return null;
  if (session === "closing" && (latest.date !== today || !/TWSE|TPEx|官方/iu.test(history.source))) return null;

  let referencePrice = latest.close;
  let quoteName: string | null = null;
  let verifiedTime = `官方日線資料日 ${latest.date}`;
  let changePercent: number | null = quoteChange(latest.close, bars.at(-2)?.close ?? null);
  if (session === "intraday") {
    const quote = await getStockQuote(
      history.symbol,
      history.ticker.endsWith(".TWO") ? "otc" : "tse",
      { maxInSessionAgeMs: MAX_VERIFIED_STOCK_TRADE_AGE_MS },
    );
    if (
      !quote.available ||
      quote.price === null ||
      !quote.asOf ||
      new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(quote.asOf) !== today ||
      Date.now() - quote.asOf.getTime() > MAX_VERIFIED_STOCK_TRADE_AGE_MS
    ) return null;
    referencePrice = quote.price;
    quoteName = quote.name;
    changePercent = quote.changePercent;
    verifiedTime = `即時報價時間 ${new Intl.DateTimeFormat("zh-TW", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(quote.asOf)}；完整日線比較日 ${latest.date}`;
  }

  const exchange = history.ticker.endsWith(".TWO") ? "TWO" : "TW";
  const streakIncludeToday = session === "closing";
  const [institutional, streak, holderMargin] = await Promise.all([
    getStockInstitutionalData(history.symbol, history.ticker),
    getInvestmentTrustBuyStreak(history.symbol, history.ticker, { includeToday: streakIncludeToday }),
    getOfficialHolderMarginScore(history.symbol, bars.map((bar) => bar.date), exchange),
  ]);
  const scorecard = buildStockScorecard(bars, institutional, holderMargin);
  const scenarios = buildStockTradeScenarios(bars, referencePrice);
  const ma20 = bars.slice(-20).reduce((sum, bar) => sum + bar.close, 0) / 20;
  const volumeBase = bars.slice(-21, -1).map((bar) => bar.volume).filter((value): value is number => value !== null);
  const averageVolume = volumeBase.length === 20
    ? volumeBase.reduce((sum, value) => sum + value, 0) / 20
    : null;
  const volumeConfirmed = averageVolume !== null && averageVolume > 0 &&
    latest.volume !== null && latest.volume >= averageVolume * 1.5 &&
    latest.close > ma20;
  if (!qualifiesForAutomatedQuantSignal({
    score: scorecard.earnedPoints,
    rewardToRisk: scenarios.directEntry.rewardToRisk,
    trustBuyDays: streak.count,
    volumeBreakoutAboveMonthlyAverage: volumeConfirmed,
  })) return null;

  const report = buildStockMarkdownReport({
    symbol: history.symbol,
    ticker: history.ticker,
    name: quoteName,
    currentPrice: referencePrice,
    changePercent,
    biasLevel: "strong_bullish",
    summary: `${verifiedTime}。量化分數高於 80 分，且投信連續買超、量增突破月線與風險報酬條件均通過。`,
    actionText: "僅在本次掃描條件仍成立時依計畫分批執行；盤中價格變動後需重新核對。",
    template: "automated_quant",
    action: "buy",
    scanTags: [
      `🔥 投信已連續買超 ${streak.count} 個交易日（${streak.observedDates.slice(0, streak.count).join("、")}）`,
      "🚀 完整日線量達 20 日均量 1.5 倍以上且站上月線",
    ],
    historicalWinRatePercent: null,
    scorecard,
    scenarios,
  });
  return { report };
}

async function sendReport(userId: string, report: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  const messages = report.split(/(?=^## )/mu).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const part of messages) {
    if (part.length > 4900) throw new Error("Quant report exceeds LINE message limit");
    if (current && current.length + part.length + 2 > 4900) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${part}` : part;
  }
  if (current) chunks.push(current);
  for (let index = 0; index < chunks.length; index += 5) {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: userId,
        messages: chunks.slice(index, index + 5).map((text) => ({ type: "text", text })),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`LINE push API returned HTTP ${response.status}`);
  }
}

async function saveSentSymbol(
  user: User,
  session: Session,
  date: string,
  symbol: string,
): Promise<void> {
  const freshUser = await clerkClient.users.getUser(user.id);
  const current = settings(freshUser);
  const dateKey = session === "intraday" ? "quantSignalIntradayDate" : "quantSignalClosingDate";
  const symbolsKey = session === "intraday" ? "quantSignalIntradaySentSymbols" : "quantSignalClosingSentSymbols";
  const priorDate = current[dateKey];
  const priorSymbols = priorDate === date ? current[symbolsKey] ?? [] : [];
  const lineNotifications = {
    ...current,
    [dateKey]: date,
    [symbolsKey]: [...new Set([...priorSymbols, symbol])],
  };
  const currentMetadata = metadata(freshUser);
  await clerkClient.users.updateUserMetadata(user.id, {
    privateMetadata: { [APP_METADATA_KEY]: { ...currentMetadata, lineNotifications } },
  });
}

router.get("/market/line-quant-signals", async (req: Request, res: Response): Promise<void> => {
  if (!authorized(req.header("authorization"))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const session = req.query.session;
  if (session !== "intraday" && session !== "closing") {
    res.status(400).json({ error: "session must be intraday or closing" });
    return;
  }
  if (!isWeekday()) {
    res.json({ date: taiwanDate(), sent: 0, skipped: 0, reason: "non-trading weekday check" });
    return;
  }
  const today = taiwanDate();
  let sent = 0, skipped = 0, failed = 0, offset = 0;
  const cache = new Map<string, Promise<Candidate | null>>();
  try {
    while (offset < 5000) {
      const page = await clerkClient.users.getUserList({ limit: 500, offset });
      for (const user of page.data) {
        const prefs = settings(user);
        if (prefs.quantSignalAlerts !== true || !prefs.lineUserId?.trim()) {
          skipped += 1;
          continue;
        }
        const priorDate = session === "intraday" ? prefs.quantSignalIntradayDate : prefs.quantSignalClosingDate;
        const sentSymbols = new Set(
          priorDate === today
            ? (session === "intraday" ? prefs.quantSignalIntradaySentSymbols : prefs.quantSignalClosingSentSymbols) ?? []
            : [],
        );
        const pendingItems = watchlist(user).filter((item) => !sentSymbols.has(item.symbol));
        const candidates = await mapConcurrent(pendingItems, 4, async (item) => {
          const key = `${item.symbol}:${item.ticker ?? ""}:${session}:${today}`;
          if (!cache.has(key)) {
            cache.set(key, scanStock(item.symbol, item.ticker, session, today).catch((error) => {
              req.log.warn({ err: error, symbol: item.symbol }, "LINE quant signal data unavailable");
              return null;
            }));
          }
          return { item, candidate: await cache.get(key) };
        });
        for (const { item, candidate } of candidates) {
          if (!candidate) continue;
          try {
            await sendReport(prefs.lineUserId, candidate.report);
            await saveSentSymbol(user, session, today, item.symbol);
            sentSymbols.add(item.symbol);
            if (session === "intraday") {
              prefs.quantSignalIntradayDate = today;
              prefs.quantSignalIntradaySentSymbols = [...sentSymbols];
            } else {
              prefs.quantSignalClosingDate = today;
              prefs.quantSignalClosingSentSymbols = [...sentSymbols];
            }
            sent += 1;
          } catch (error) {
            failed += 1;
            req.log.error({ err: error, symbol: item.symbol }, "LINE quant signal delivery failed");
          }
        }
      }
      if (page.data.length < 500) break;
      offset += page.data.length;
    }
    res.status(failed ? 502 : 200).json({ date: today, session, sent, skipped, failed });
  } catch (error) {
    req.log.error({ err: error, session }, "LINE quant signal scan failed");
    res.status(502).json({ error: "Unable to prepare quant signal notifications" });
  }
});

export default router;
