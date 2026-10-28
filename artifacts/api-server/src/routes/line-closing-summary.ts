import { Router, type IRouter } from "express";
import { clerkClient, type User } from "@clerk/express";
import { timingSafeEqual } from "node:crypto";
import { getOfficialDailyCloseData, getTaiexSummary } from "../lib/market-data.js";
import { getMarketAiDailySummary } from "../lib/market-ai-daily-summary.js";
import { formatLineAssistantReply, type LineAssistantMessage } from "../lib/line-assistant-format.js";

const router: IRouter = Router();
const APP_METADATA_KEY = "twStockDashboard";
const MARKET_ZONE = "Asia/Taipei";

type LineNotificationSettings = {
  lineUserId?: string;
  closingSummary?: boolean;
  lastClosingSummaryDate?: string;
};

function taiwanDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isWeekday(date = new Date()): boolean {
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(
    new Intl.DateTimeFormat("en-US", {
      timeZone: MARKET_ZONE,
      weekday: "short",
    }).format(date),
  );
}

function appMetadata(user: User): Record<string, unknown> {
  const value = user.privateMetadata[APP_METADATA_KEY];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function lineSettings(user: User): LineNotificationSettings {
  const candidate = appMetadata(user).lineNotifications;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as LineNotificationSettings)
    : {};
}

function cronAuthorized(authorization: string | undefined): boolean {
  const expectedSecret = process.env.CRON_SECRET?.trim();
  if (!expectedSecret || !authorization?.startsWith("Bearer ")) return false;
  const received = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(expectedSecret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function formatSummaryLine(
  symbol: string,
  quote: { name: string; close: number; change: number | null },
): string {
  const change = quote.change;
  const changeText =
    change === null
      ? "漲跌資料缺少"
      : `${change > 0 ? "+" : ""}${change.toLocaleString("zh-TW", {
          maximumFractionDigits: 2,
        })} (${change === 0 || quote.close - change <= 0
          ? "0.00"
          : ((change / (quote.close - change)) * 100).toFixed(2)}%)`;
  return `• ${symbol} ${quote.name}｜${quote.close.toLocaleString("zh-TW", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}｜${changeText}`;
}

function buildSummaryMessages(
  date: string,
  aiSummary: string,
  indexDataSource: string,
  newsSources: Array<{ title: string; url: string }>,
  lines: string[],
  officialQuotesAvailable: boolean,
): Array<string | LineAssistantMessage> {
  const indexSourceUrl = indexDataSource.includes("TWSE")
    ? "https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?response=html"
    : "https://www.fugle.tw/market-data";
  const sources = [
    { title: `加權指數日線（${date}；${indexDataSource}）`, url: indexSourceUrl },
    ...(officialQuotesAvailable
      ? [
          { title: "上市個股收盤｜臺灣證券交易所", url: "https://www.twse.com.tw/" },
          { title: "上櫃個股收盤｜證券櫃檯買賣中心", url: "https://www.tpex.org.tw/" },
        ]
      : []),
    ...newsSources.slice(0, 2),
  ];
  const heading = `台股 AI 盤後摘要（${date}）\n\n${aiSummary}`;
  if (!lines.length) {
    const detail = officialQuotesAvailable
      ? "目前沒有可附上的自選股收盤資料。"
      : "官方個股收盤資料尚未更新。";
    return [formatLineAssistantReply({
      answer: `${heading}\n\n自選股收盤：${detail}${newsSources.length ? "\n\n新聞僅為搜尋線索，尚未核實。" : ""}`,
      sources,
      searchStatus: newsSources.length ? "searched" : "not_needed",
      aiProvider: "rule_based",
      answeredAt: new Date(),
    })];
  }
  const messages: Array<string | LineAssistantMessage> = [formatLineAssistantReply({
    answer: `${heading}\n\n自選股收盤行情已附在下一則訊息。${newsSources.length ? "\n\n新聞僅為搜尋線索，尚未核實。" : ""}`,
    sources,
    searchStatus: newsSources.length ? "searched" : "not_needed",
    aiProvider: "rule_based",
    answeredAt: new Date(),
  })];
  let current = `自選股收盤（${date}）`;
  for (const line of lines) {
    const candidate = `${current}\n${line}`;
    if (candidate.length > 4900 && current !== `自選股收盤（${date}）`) {
      messages.push(current);
      current = `台股收盤行情續（${date}）\n${line}`;
    } else {
      current = candidate;
    }
  }
  if (current !== `自選股收盤（${date}）`) messages.push(current);
  return messages;
}

async function sendLineMessage(userId: string, messages: Array<string | LineAssistantMessage>): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: userId,
      messages: messages.slice(0, 5).map((message) =>
        typeof message === "string" ? { type: "text", text: message.slice(0, 4900) } : message,
      ),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`LINE push API returned HTTP ${response.status}`);
  }
}

async function saveLastSentDate(user: User, settings: LineNotificationSettings, date: string): Promise<void> {
  const metadata = appMetadata(user);
  await clerkClient.users.updateUserMetadata(user.id, {
    privateMetadata: {
      [APP_METADATA_KEY]: {
        ...metadata,
        lineNotifications: { ...settings, lastClosingSummaryDate: date },
      },
    },
  });
}

router.get("/market/line-closing-summary", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  if (!cronAuthorized(req.get("authorization"))) {
    res.status(process.env.CRON_SECRET ? 401 : 503).json({
      error: process.env.CRON_SECRET ? "Unauthorized" : "CRON_SECRET is not configured",
    });
    return;
  }

  const today = taiwanDate();
  if (!isWeekday()) {
    res.json({ skipped: true, reason: "weekend", date: today });
    return;
  }

  let failureStage = "market-index";
  try {
    const indexData = await getTaiexSummary();
    if (indexData.dailyCloseDate !== today) {
      res.json({
        skipped: true,
        reason: "no-current-day-official-index-close",
        date: today,
        availableDate: indexData.dailyCloseDate,
      });
      return;
    }
    let officialCloseQuotes: Awaited<ReturnType<typeof getOfficialDailyCloseData>>["quotes"] = [];
    let officialQuotesAvailable = false;
    failureStage = "official-close";
    try {
      const marketData = await getOfficialDailyCloseData();
      if (marketData.asOf === today) {
        officialCloseQuotes = marketData.quotes;
        officialQuotesAvailable = true;
      } else {
        req.log.warn(
          { date: today, availableDate: marketData.asOf },
          "Official stock close data is not current; sending index summary without stock quotes",
        );
      }
    } catch (error) {
      req.log.warn(
        { err: error, date: today },
        "Official stock close data is unavailable; sending index summary without stock quotes",
      );
    }
    failureStage = "ai-summary";
    const aiSummary = await getMarketAiDailySummary(indexData, "closing");
    if (aiSummary.status !== "available" || !aiSummary.summary) {
      req.log.error(
        { date: today, error: aiSummary.error },
        "LINE closing AI market summary unavailable",
      );
      res.status(502).json({
        error: aiSummary.error ?? "AI closing market summary unavailable",
        date: today,
      });
      return;
    }
    const quoteBySymbol = new Map(officialCloseQuotes.map((quote) => [quote.symbol, quote]));
    let sent = 0;
    let skipped = 0;
    let skippedDisabled = 0;
    let skippedUnlinked = 0;
    let skippedAlreadySent = 0;
    let failed = 0;
    let offset = 0;
    const pageSize = 500;

    failureStage = "line-recipients";
    while (offset < 5000) {
      const page = await clerkClient.users.getUserList({ limit: pageSize, offset });
      for (const user of page.data) {
        const settings = lineSettings(user);
        if (settings.closingSummary !== true) {
          skippedDisabled += 1;
          skipped += 1;
          continue;
        }
        if (typeof settings.lineUserId !== "string" || !settings.lineUserId.trim()) {
          skippedUnlinked += 1;
          skipped += 1;
          continue;
        }
        if (settings.lastClosingSummaryDate === today) {
          skippedAlreadySent += 1;
          skipped += 1;
          continue;
        }

        const watchlist = appMetadata(user).watchlist;
        const symbols = Array.isArray(watchlist)
          ? [...new Set(
              watchlist.flatMap((item) => {
                if (!item || typeof item !== "object" || typeof (item as { symbol?: unknown }).symbol !== "string") {
                  return [];
                }
                const symbol = (item as { symbol: string }).symbol
                  .replace(/\.(TW|TWO)$/i, "")
                  .trim()
                  .toUpperCase();
                return /^[A-Z0-9]{2,6}$/.test(symbol) ? [symbol] : [];
              }),
            )]
          : [];
        const lines = symbols.flatMap((symbol) => {
          const quote = quoteBySymbol.get(symbol);
          return quote ? [formatSummaryLine(symbol, quote)] : [];
        });
        try {
          await sendLineMessage(
            settings.lineUserId,
            buildSummaryMessages(
              today,
              aiSummary.summary,
              indexData.dailyCloseSource,
              aiSummary.newsSources,
              lines,
              officialQuotesAvailable,
            ),
          );
          await saveLastSentDate(user, settings, today);
          sent += 1;
        } catch (error) {
          failed += 1;
          req.log.error({ err: error }, "Unable to send a LINE closing summary");
        }
      }
      if (page.data.length < pageSize) break;
      offset += page.data.length;
    }

    const result = {
      date: today,
      sent,
      skipped,
      skippedDisabled,
      skippedUnlinked,
      skippedAlreadySent,
      failed,
    };
    req.log.info(result, "LINE closing summary run completed");
    res.status(failed ? 502 : 200).json(result);
  } catch (error) {
    req.log.error({ err: error }, "LINE closing summary run failed");
    const diagnostic =
      failureStage === "official-close" && error instanceof Error
        ? error.message.replace(/https?:\/\/[^\s]+/gu, "[external URL]").slice(0, 180)
        : undefined;
    res.status(502).json({
      error: "Unable to prepare official closing summaries",
      stage: failureStage,
      ...(diagnostic ? { diagnostic } : {}),
    });
  }
});

export default router;
