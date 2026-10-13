import { Router, type IRouter } from "express";
import { clerkClient, type User } from "@clerk/express";
import { timingSafeEqual } from "node:crypto";
import { getOfficialDailyCloseData } from "../lib/market-data.js";

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
  return `${symbol} ${quote.name}　${quote.close.toLocaleString("zh-TW", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}　${changeText}`;
}

function buildSummaryMessages(date: string, lines: string[]): string[] {
  const heading = `台股收盤每日總結（${date}）\n`;
  const footer = "\n資料來源：TWSE／TPEx 官方收盤資料。";
  const messages: string[] = [];
  let current = heading;
  for (const line of lines) {
    const candidate = `${current}${current === heading ? "" : "\n"}${line}`;
    if (`${candidate}${footer}`.length > 4900 && current !== heading) {
      messages.push(`${current}${footer}`);
      current = `${heading}${line}`;
    } else {
      current = candidate;
    }
  }
  if (current !== heading) messages.push(`${current}${footer}`);
  return messages;
}

async function sendLineMessage(userId: string, messages: string[]): Promise<void> {
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
      messages: messages.slice(0, 5).map((text) => ({ type: "text", text })),
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

  try {
    const marketData = await getOfficialDailyCloseData();
    if (marketData.asOf !== today) {
      res.json({
        skipped: true,
        reason: "no-current-day-official-close",
        date: today,
        availableDate: marketData.asOf,
      });
      return;
    }
    const quoteBySymbol = new Map(marketData.quotes.map((quote) => [quote.symbol, quote]));
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let offset = 0;
    const pageSize = 500;

    while (offset < 5000) {
      const page = await clerkClient.users.getUserList({ limit: pageSize, offset });
      for (const user of page.data) {
        const settings = lineSettings(user);
        if (
          settings.closingSummary !== true ||
          typeof settings.lineUserId !== "string" ||
          !settings.lineUserId.trim() ||
          settings.lastClosingSummaryDate === today
        ) {
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
        if (!lines.length) {
          skipped += 1;
          continue;
        }

        try {
          await sendLineMessage(settings.lineUserId, buildSummaryMessages(today, lines));
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

    req.log.info({ date: today, sent, skipped, failed }, "LINE closing summary run completed");
    res.status(failed ? 502 : 200).json({ date: today, sent, skipped, failed });
  } catch (error) {
    req.log.error({ err: error }, "LINE closing summary run failed");
    res.status(502).json({ error: "Unable to prepare official closing summaries" });
  }
});

export default router;
