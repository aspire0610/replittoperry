import { Router, type IRouter } from "express";
import { clerkClient, type User } from "@clerk/express";
import { timingSafeEqual } from "node:crypto";
import { getTaiexSummary } from "../lib/market-data.js";
import { getMarketAiDailySummary } from "../lib/market-ai-daily-summary.js";

const router: IRouter = Router();
const APP_METADATA_KEY = "twStockDashboard";
const MARKET_ZONE = "Asia/Taipei";

type LineNotificationSettings = {
  lineUserId?: string;
  premarketSummary?: boolean;
  lastPremarketSummaryDate?: string;
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

async function pushText(userId: string, text: string): Promise<void> {
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
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`LINE push API returned HTTP ${response.status}`);
}

async function saveLastSentDate(
  user: User,
  settings: LineNotificationSettings,
  date: string,
): Promise<void> {
  const metadata = appMetadata(user);
  await clerkClient.users.updateUserMetadata(user.id, {
    privateMetadata: {
      [APP_METADATA_KEY]: {
        ...metadata,
        lineNotifications: { ...settings, lastPremarketSummaryDate: date },
      },
    },
  });
}

router.get("/market/line-premarket-summary", async (req, res): Promise<void> => {
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
    const marketData = await getTaiexSummary();
    const summary = await getMarketAiDailySummary(marketData);
    if (summary.status !== "available" || !summary.summary) {
      req.log.error({ date: today, error: summary.error }, "LINE pre-market summary unavailable");
      res.status(502).json({ error: summary.error ?? "AI pre-market summary unavailable", date: today });
      return;
    }

    const quoteTime = summary.quoteAsOf
      ? new Intl.DateTimeFormat("zh-TW", {
          timeZone: MARKET_ZONE,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(summary.quoteAsOf)
      : "無";
    const sourceLines = summary.newsSources.slice(0, 2)
      .map((source) => `${source.title} ${source.url}`);
    const message = [
      `台股 AI 盤前摘要（${today}）`,
      summary.summary,
      `技術資料日：${summary.marketDate}；最新行情時間：${quoteTime}（台北時間）。`,
      ...(sourceLines.length
        ? [`消息線索（搜尋摘要未核實）：\n${sourceLines.join("\n")}`]
        : ["目前沒有可提供的消息來源連結。"]),
    ].join("\n\n");

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
          settings.premarketSummary !== true ||
          typeof settings.lineUserId !== "string" ||
          !settings.lineUserId.trim() ||
          settings.lastPremarketSummaryDate === today
        ) {
          skipped += 1;
          continue;
        }

        try {
          await pushText(settings.lineUserId, message);
          await saveLastSentDate(user, settings, today);
          sent += 1;
        } catch (error) {
          failed += 1;
          req.log.error({ err: error, userId: user.id }, "Unable to send a LINE pre-market summary");
        }
      }
      if (page.data.length < pageSize) break;
      offset += page.data.length;
    }

    req.log.info({ date: today, sent, skipped, failed }, "LINE pre-market summary run completed");
    res.status(failed ? 502 : 200).json({ date: today, sent, skipped, failed });
  } catch (error) {
    req.log.error({ err: error }, "LINE pre-market summary run failed");
    res.status(502).json({ error: "Unable to prepare AI pre-market summary" });
  }
});

export default router;
