import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { clerkClient, getAuth, type User } from "@clerk/express";
import type { AssistantChatReply } from "@workspace/api-zod";
import {
  DeleteAccountLineLinkResponse,
  DeleteAdminUserParams,
  GetAccountLineNotificationsResponse,
  GetAccountMeResponse,
  GetAccountPaperTradingResponse,
  GetAccountQuantResearchRunParams,
  GetAccountQuantResearchRunResponse,
  GetAccountQuantResearchRunsResponse,
  DeleteAccountQuantResearchRunsResponse,
  PostAdminWebSearchDiagnosticResponse,
  PostAccountQuantResearchRunSummaryParams,
  PostAccountQuantResearchRunSummaryResponse,
  GetAccountStockAiConversationQueryParams,
  GetAccountStockAiConversationResponse,
  GetAdminUsersQueryParams,
  GetAdminUsersResponse,
  DeleteAccountStockAiConversationQueryParams,
  DeleteAccountStockAiConversationResponse,
  PatchAdminUserBody,
  PatchAdminUserParams,
  PatchAdminUserResponse,
  PostAdminInvitationBody,
  PostAdminInvitationResponse,
  PostAccountPaperTradeBody,
  PostAccountPaperTradeResponse,
  PostAccountPaperTradingBody,
  PostAccountPaperTradingResponse,
  PostAccountPaperTradingResetResponse,
  PostAccountLineLinkCodeResponse,
  PostAccountQuantResearchBody,
  PostAccountQuantResearchInterpretBody,
  PostAccountQuantResearchStreamBody,
  PostAccountQuantResearchInterpretResponse as QuantResearchInterpretationSchema,
  PostAccountQuantResearchResponse,
  PutAccountStockAiConversationBody,
  PutAccountStockAiConversationResponse,
  PutAccountWatchlistBody,
  PutAccountWatchlistResponse,
  PutAccountLineNotificationsBody,
} from "@workspace/api-zod";
import { deleteAccountData } from "../lib/account-data.js";
import { getAdminUserDeleteBlockReason } from "../lib/admin-user-delete-policy.js";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  ConversationStorageUnavailableError,
  deleteStockAiConversation,
  getStockAiConversation,
  saveStockAiConversation,
} from "../lib/stock-ai-conversations.js";
import { askAssistantChat } from "../lib/assistant-chat.js";
import { diagnoseLineWebSearch } from "../lib/line-web-search.js";
import {
  clearLineAssistantHistory,
  getLineAssistantHistory,
  saveLineAssistantTurn,
} from "../lib/line-assistant-conversations.js";
import {
  createPaperTradingAccount,
  getPaperTradingPortfolio,
  PaperTradingError,
  recordPaperTrade,
  resetPaperTradingAccount,
} from "../lib/paper-trading.js";
import {
  QuantMarketDataError,
} from "../lib/quant-market-data.js";
import {
  interpretQuantResearchHypothesis,
  QuantResearchError,
  runQuantResearch,
} from "../lib/quant-research.js";
import { generateQuantResearchSummary } from "../lib/quant-research-summary.js";
import type {
  QuantResearchProgress,
} from "../lib/quant-research-progress.js";
import {
  getQuantResearchRun,
  deleteQuantResearchRuns,
  listQuantResearchRuns,
  saveQuantResearchRun,
  saveQuantResearchRunSummary,
} from "../lib/quant-research-runs.js";

const WATCHLIST_LIMIT = 100;
const APP_METADATA_KEY = "twStockDashboard";
const QUANT_RESEARCH_RATE_LIMIT = 6;
const QUANT_RESEARCH_RATE_WINDOW_MS = 60_000;
const quantResearchLimits = new Map<string, { count: number; resetAt: number }>();
const LINE_LINK_TTL_MS = 10 * 60 * 1000;
const LINE_ASSISTANT_LIMIT = 10;
const LINE_ASSISTANT_WINDOW_MS = 60_000;
const lineAssistantLimits = new Map<string, { count: number; resetAt: number }>();

type LineAlert = {
  id: string;
  symbol: string;
  name: string;
  condition: "above" | "below";
  targetPrice: number;
  enabled: boolean;
};
type LineSettings = {
  alerts: LineAlert[];
  openingNotice: boolean;
  closingSummary: boolean;
  premarketSummary: boolean;
  lineUserId?: string;
  pendingLinkHash?: string;
  pendingLinkExpiresAt?: number;
};

function getLineSettings(user: User): LineSettings {
  const appMetadata = user.privateMetadata[APP_METADATA_KEY];
  const candidate =
    appMetadata && typeof appMetadata === "object" && !Array.isArray(appMetadata)
      ? (appMetadata as Record<string, unknown>).lineNotifications
      : undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { alerts: [], openingNotice: false, closingSummary: false, premarketSummary: false };
  }
  const value = candidate as Partial<LineSettings>;
  const parsed = PutAccountLineNotificationsBody.safeParse({
    alerts: value.alerts ?? [],
    openingNotice: value.openingNotice ?? false,
    closingSummary: value.closingSummary ?? false,
    premarketSummary: value.premarketSummary ?? false,
  });
  return {
    ...(parsed.success ? parsed.data : { alerts: [], openingNotice: false, closingSummary: false, premarketSummary: false }),
    ...(typeof value.lineUserId === "string" ? { lineUserId: value.lineUserId } : {}),
    ...(typeof value.pendingLinkHash === "string" ? { pendingLinkHash: value.pendingLinkHash } : {}),
    ...(typeof value.pendingLinkExpiresAt === "number" ? { pendingLinkExpiresAt: value.pendingLinkExpiresAt } : {}),
  };
}

function lineSettingsResponse(user: User) {
  const settings = getLineSettings(user);
  return GetAccountLineNotificationsResponse.parse({
    linked: Boolean(settings.lineUserId),
    alerts: settings.alerts,
    openingNotice: settings.openingNotice,
    closingSummary: settings.closingSummary,
    premarketSummary: settings.premarketSummary,
  });
}

async function saveLineSettings(user: User, settings: LineSettings): Promise<User> {
  const current = user.privateMetadata[APP_METADATA_KEY];
  const appMetadata =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return clerkClient.users.updateUserMetadata(user.id, {
    privateMetadata: {
      [APP_METADATA_KEY]: {
        ...appMetadata,
        lineNotifications: settings,
      },
    },
  });
}

function verifyLineLinkToken(token: string): { userId: string; expiresAt: number } | null {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof decoded.userId !== "string" ||
      typeof decoded.expiresAt !== "number" ||
      decoded.expiresAt <= Date.now()
    ) return null;
    return { userId: decoded.userId, expiresAt: decoded.expiresAt };
  } catch {
    return null;
  }
}

async function replyToLine(replyToken: string, text: string): Promise<void> {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`LINE reply API returned HTTP ${response.status}`);
  }
}

function isLineAssistantRateLimited(lineUserId: string): boolean {
  const now = Date.now();
  for (const [key, value] of lineAssistantLimits) {
    if (value.resetAt <= now) lineAssistantLimits.delete(key);
  }
  const current = lineAssistantLimits.get(lineUserId);
  if (!current || current.resetAt <= now) {
    lineAssistantLimits.set(lineUserId, {
      count: 1,
      resetAt: now + LINE_ASSISTANT_WINDOW_MS,
    });
    return false;
  }
  if (current.count >= LINE_ASSISTANT_LIMIT) return true;
  current.count += 1;
  return false;
}

function formatLineAssistantReply(reply: AssistantChatReply): string {
  const answer = reply.answer.trim().slice(0, 4_000);
  if (!reply.sources.length) return answer;
  const sourceHeader = "\n\n參考來源：";
  let result = answer + sourceHeader;
  for (const source of reply.sources.slice(0, 5)) {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)) continue;
    const line = `\n• ${source.title.slice(0, 180)}\n${url.toString()}`;
    if (result.length + line.length > 4_900) break;
    result += line;
  }
  return result === answer + sourceHeader ? answer : result;
}

type AppMetadata = {
  access?: unknown;
  role?: unknown;
  [key: string]: unknown;
};

type AccountContext = {
  user: User;
  email: string;
  isAdmin: boolean;
};

type AccountLocals = {
  account?: AccountContext;
};

const router: IRouter = Router();
const SSE_PROXY_FLUSH_PADDING = `:${" ".repeat(4_096)}\n\n`;

router.post(
  ["/line/webhook", "/account/line-webhook"],
  async (req: Request, res: Response): Promise<void> => {
  const secret = process.env.LINE_CHANNEL_SECRET;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const signature = req.get("x-line-signature");
  if (!secret || !rawBody || !signature) {
    res.status(401).json({ error: "LINE webhook signature is missing." });
    return;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "base64");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.status(401).json({ error: "Invalid LINE webhook signature." });
    return;
  }

  const body = req.body as { events?: unknown };
  const events = Array.isArray(body?.events) ? body.events : [];
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== "object") continue;
    const event = rawEvent as {
      type?: unknown;
      replyToken?: unknown;
      source?: { userId?: unknown };
      message?: { type?: unknown; text?: unknown };
    };
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const replyToken = typeof event.replyToken === "string" ? event.replyToken : null;
    const text = typeof event.message.text === "string" ? event.message.text.trim() : "";
    const lineUserId = typeof event.source?.userId === "string" ? event.source.userId : null;
    if (!replyToken || !lineUserId || !text) continue;

    const match = /^LINK\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(text);
    if (/^LINK\b/i.test(text) && !match) {
      try {
        await replyToLine(replyToken, "請從台股儀表板的「系統設定」產生連結碼，再傳送：LINK 連結碼");
      } catch (error) {
        req.log.warn({ err: error }, "Unable to reply to LINE message");
      }
      continue;
    }

    if (/^(?:清除對話|\/clear)$/i.test(text)) {
      try {
        await clearLineAssistantHistory(lineUserId);
        await replyToLine(replyToken, "已清除這個 LINE 帳號最近的 AI 對話紀錄。");
      } catch (error) {
        req.log.error({ err: error }, "Unable to clear LINE assistant history");
        try { await replyToLine(replyToken, "目前無法清除對話紀錄，請稍後再試。"); }
        catch (replyError) { req.log.warn({ err: replyError }, "Unable to reply to LINE message"); }
      }
      continue;
    }

    if (match) {
      const token = match[1];
      const tokenData = verifyLineLinkToken(token);
      if (!tokenData) {
        try { await replyToLine(replyToken, "連結碼無效或已過期，請回儀表板重新產生。"); }
        catch (error) { req.log.warn({ err: error }, "Unable to reply to LINE message"); }
        continue;
      }
      try {
        const user = await clerkClient.users.getUser(tokenData.userId);
        const settings = getLineSettings(user);
        const tokenHash = createHash("sha256").update(token).digest("hex");
        if (
          settings.pendingLinkHash !== tokenHash ||
          settings.pendingLinkExpiresAt !== tokenData.expiresAt ||
          settings.pendingLinkExpiresAt <= Date.now()
        ) {
          await replyToLine(replyToken, "連結碼已使用或已過期，請重新產生。");
          continue;
        }
        await saveLineSettings(user, {
          ...settings,
          lineUserId,
          pendingLinkHash: undefined,
          pendingLinkExpiresAt: undefined,
        });
        await replyToLine(replyToken, "LINE 已成功連結。你可以回到台股儀表板設定價格提醒，也可以直接在 LINE 詢問 AI 助手。");
      } catch (error) {
        req.log.error({ err: error }, "Unable to complete LINE account link");
        try { await replyToLine(replyToken, "連結暫時失敗，請稍後從儀表板重新產生連結碼。"); }
        catch (replyError) { req.log.warn({ err: replyError }, "Unable to reply to LINE message"); }
      }
      continue;
    }

    if (text.length > 1_000) {
      try { await replyToLine(replyToken, "問題最多 1,000 字，請縮短後再傳送。"); }
      catch (error) { req.log.warn({ err: error }, "Unable to reply to LINE message"); }
      continue;
    }
    if (isLineAssistantRateLimited(lineUserId)) {
      try { await replyToLine(replyToken, "訊息太密集了，請稍後再問。"); }
      catch (error) { req.log.warn({ err: error }, "Unable to reply to LINE message"); }
      continue;
    }

    try {
      const history = await getLineAssistantHistory(lineUserId);
      const requestId =
        typeof req.id === "string" || typeof req.id === "number"
          ? req.id
          : undefined;
      const reply = await askAssistantChat(text, undefined, history, requestId, {
        includeLineStockDetails: true,
      });
      await saveLineAssistantTurn(lineUserId, text, reply.answer);
      await replyToLine(replyToken, formatLineAssistantReply(reply));
    } catch (error) {
      req.log.error({ err: error }, "Unable to answer LINE assistant message");
      try {
        await replyToLine(
          replyToken,
          "AI 助手目前無法完成回答，請稍後再試；若問題持續，請聯絡台股儀表板管理員。",
        );
      } catch (replyError) {
        req.log.warn({ err: replyError }, "Unable to send LINE assistant error reply");
      }
    }
  }
  res.sendStatus(200);
  },
);

function isQuantResearchRateLimited(userId: string): boolean {
  const now = Date.now();
  for (const [key, limit] of quantResearchLimits) {
    if (limit.resetAt <= now) quantResearchLimits.delete(key);
  }
  const current = quantResearchLimits.get(userId);
  if (!current || current.resetAt <= now) {
    quantResearchLimits.set(userId, {
      count: 1,
      resetAt: now + QUANT_RESEARCH_RATE_WINDOW_MS,
    });
    return false;
  }
  if (current.count >= QUANT_RESEARCH_RATE_LIMIT) return true;
  current.count += 1;
  return false;
}

function sendQuantOperationError(
  req: Request,
  res: Response,
  error: unknown,
  fallbackMessage: string,
): void {
  const failure = getQuantOperationFailure(error, fallbackMessage);
  req.log.error({ err: error }, "Quantitative research or paper trading operation failed");
  res.status(failure.status).json({ error: failure.message });
}

function getQuantOperationFailure(
  error: unknown,
  fallbackMessage: string,
): { status: number; message: string } {
  const knownError =
    error instanceof QuantResearchError ||
    error instanceof QuantMarketDataError ||
    error instanceof PaperTradingError
      ? error
      : null;
  const originalStatus = knownError?.status ?? 503;
  const status =
    originalStatus === 422
      ? 400
      : [400, 404, 409, 429, 502, 503, 504].includes(originalStatus)
        ? originalStatus
        : 503;
  return { status, message: knownError?.message ?? fallbackMessage };
}

function getAppMetadata(user: User): AppMetadata {
  const metadata = user.publicMetadata[APP_METADATA_KEY];
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as AppMetadata)
    : {};
}

function getPrimaryEmail(user: User): string | null {
  const primary = user.emailAddresses.find(
    (emailAddress) => emailAddress.id === user.primaryEmailAddressId,
  );
  return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
}

function isBootstrapAdmin(user: User, email: string | null): boolean {
  const configuredEmail = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  return Boolean(configuredEmail && email?.toLowerCase() === configuredEmail);
}

function getWatchlist(user: User): Array<{ symbol: string; name: string }> {
  const appMetadata = user.privateMetadata[APP_METADATA_KEY];
  const candidate =
    appMetadata && typeof appMetadata === "object" && !Array.isArray(appMetadata)
      ? (appMetadata as Record<string, unknown>).watchlist
      : undefined;
  const parsed = PutAccountWatchlistBody.shape.watchlist.safeParse(candidate);
  return parsed.success ? parsed.data : [];
}

function getInvitationRedirectUrl(req: Request): string {
  const referer = req.get("referer");
  if (!referer) return "/accept-invitation";

  try {
    const url = new URL(referer);
    const adminRouteIndex = url.pathname.lastIndexOf("/admin/users");
    if (adminRouteIndex >= 0) {
      const appBasePath = url.pathname.slice(0, adminRouteIndex).replace(/\/$/, "");
      url.pathname = `${appBasePath}/accept-invitation`;
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // Fall back to the app root if the browser did not send a usable referrer.
  }

  return "/accept-invitation";
}

function isDuplicateClerkRecord(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const clerkError = error as { errors?: unknown; aggregateErrors?: unknown };
  return [clerkError.errors, clerkError.aggregateErrors].some(
    (entries) =>
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          "code" in entry &&
          entry.code === "duplicate_record",
      ),
  );
}

function serializeAdminUser(user: User) {
  const email = getPrimaryEmail(user);
  const metadata = getAppMetadata(user);
  const appAccess =
    isBootstrapAdmin(user, email) || metadata.access === "active" ? "active" : "not_invited";
  const createdAt = new Date(user.createdAt).toISOString();
  const lastSignInAt =
    user.lastSignInAt === null ? null : new Date(user.lastSignInAt).toISOString();

  return {
    id: user.id,
    email,
    fullName: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
    role: appAccess === "active" && metadata.role === "admin" ? "admin" : "member",
    appAccess,
    banned: user.banned,
    createdAt,
    lastSignInAt,
  };
}

function sendProviderError(
  req: Request,
  res: Response,
  error: unknown,
  message = "帳號服務暫時無法使用，請稍後再試。",
): void {
  const duplicateRecord = isDuplicateClerkRecord(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  const responseStatusCode =
    status === 404
      ? 404
      : duplicateRecord || status === 409 || status === 422
        ? 409
        : 503;
  req.log.error({ err: error }, "Clerk account operation failed");
  res.status(responseStatusCode).json({
    error: duplicateRecord
      ? "此電子郵件已有帳戶或待處理邀請，Clerk 未能建立新邀請。"
      : status === 404
        ? "找不到使用者。"
        : status === 409 || status === 422
          ? "此電子郵件已存在或已受邀。"
          : message,
  });
}

function sendConversationStorageError(
  req: Request,
  res: Response,
  error: unknown,
): void {
  req.log.error({ err: error }, "Account conversation storage operation failed");
  res.status(503).json({
    error:
      error instanceof ConversationStorageUnavailableError
        ? "此環境尚未設定對話資料庫，對話目前無法同步。"
        : "對話同步暫時失敗；目前頁面的對話尚未保存，請稍後重試。",
  });
}

async function requireAccountAccess(
  req: Request,
  res: Response<unknown, AccountLocals>,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = getAuth(req).userId;
    if (!userId) {
      if (
        req.method === "GET" &&
        req.originalUrl?.split("?")[0] === "/api/account/me"
      ) {
        const cookieHeader = req.get("cookie") ?? "";
        req.log.warn(
          {
            phase: "account_auth_session_missing",
            cookieHeaderPresent: cookieHeader.length > 0,
            clerkSessionCookiePresent: /(?:^|;\s*)__session=/.test(cookieHeader),
            authorizationHeaderPresent: Boolean(req.get("authorization")),
          },
          "Account profile request rejected without Clerk session",
        );
      }
      res.status(401).json({ error: "請先登入。" });
      return;
    }

    let user = await clerkClient.users.getUser(userId);
    const email = getPrimaryEmail(user);
    const bootstrapAdmin = isBootstrapAdmin(user, email);
    let metadata = getAppMetadata(user);

    if (bootstrapAdmin && (metadata.access !== "active" || metadata.role !== "admin")) {
      user = await clerkClient.users.updateUserMetadata(user.id, {
        publicMetadata: {
          [APP_METADATA_KEY]: { access: "active", role: "admin" },
        },
      });
      metadata = getAppMetadata(user);
    }

    if (user.banned) {
      res.status(403).json({ error: "此帳號目前已停用。" });
      return;
    }
    if (!email || (!bootstrapAdmin && metadata.access !== "active")) {
      res.status(403).json({ error: "此帳號尚未獲邀使用台股儀表板。" });
      return;
    }

    res.locals.account = {
      user,
      email,
      isAdmin: bootstrapAdmin || metadata.role === "admin",
    };
    next();
  } catch (error) {
    sendProviderError(req, res, error);
  }
}

function requireAdmin(
  _req: Request,
  res: Response<unknown, AccountLocals>,
  next: NextFunction,
): void {
  if (!res.locals.account?.isAdmin) {
    res.status(403).json({ error: "此操作需要管理員權限。" });
    return;
  }
  next();
}

router.use(requireAccountAccess);

router.post(
  "/admin/web-search-diagnostic",
  requireAdmin,
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const diagnostic = await diagnoseLineWebSearch();
    const safeDiagnostic = PostAdminWebSearchDiagnosticResponse.parse(diagnostic);
    req.log.info(
      {
        operation: "admin_web_search_diagnostic",
        provider: safeDiagnostic.provider,
        outcome: safeDiagnostic.outcome,
        resultCount: safeDiagnostic.resultCount,
        failureKind: safeDiagnostic.failureKind,
        httpStatus: safeDiagnostic.httpStatus,
      },
      "Admin web search diagnostic completed",
    );
    res.json(safeDiagnostic);
  },
);

router.get(
  "/account/line-notifications",
  (_req: Request, res: Response<unknown, AccountLocals>): void => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    res.json(lineSettingsResponse(account.user));
  },
);

router.put(
  "/account/line-notifications",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    const parsed = PutAccountLineNotificationsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "LINE 通知設定格式錯誤。" });
      return;
    }
    const existing = getLineSettings(account.user);
    try {
      const updated = await saveLineSettings(account.user, {
        ...existing,
        ...parsed.data,
      });
      res.json(lineSettingsResponse(updated));
    } catch (error) {
      sendProviderError(req, res, error);
    }
  },
);

router.post(
  [
    "/account/line-notifications/link-code",
    "/account/line-notifications-link-code",
  ],
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    const secret = process.env.LINE_CHANNEL_SECRET;
    if (!secret) {
      res.status(503).json({ error: "LINE 通知尚未完成伺服器設定。" });
      return;
    }
    const expiresAt = Date.now() + LINE_LINK_TTL_MS;
    const payload = Buffer.from(JSON.stringify({
      userId: account.user.id,
      expiresAt,
      nonce: randomBytes(16).toString("base64url"),
    })).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    const code = `${payload}.${signature}`;
    try {
      const settings = getLineSettings(account.user);
      await saveLineSettings(account.user, {
        ...settings,
        pendingLinkHash: createHash("sha256").update(code).digest("hex"),
        pendingLinkExpiresAt: expiresAt,
      });
      res.json(PostAccountLineLinkCodeResponse.parse({
        code,
        expiresAt: new Date(expiresAt).toISOString(),
      }));
    } catch (error) {
      sendProviderError(req, res, error);
    }
  },
);

router.delete(
  "/account/line-notifications/link",
  async (_req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    try {
      const settings = getLineSettings(account.user);
      const updated = await saveLineSettings(account.user, {
        ...settings,
        lineUserId: undefined,
        pendingLinkHash: undefined,
        pendingLinkExpiresAt: undefined,
      });
      res.json(DeleteAccountLineLinkResponse.parse(lineSettingsResponse(updated)));
    } catch (error) {
      sendProviderError(_req, res, error);
    }
  },
);

router.get(
  "/account/me",
  (_req: Request, res: Response<unknown, AccountLocals>): void => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }

    const response = GetAccountMeResponse.parse({
      userId: account.user.id,
      email: account.email,
      isAdmin: account.isAdmin,
      watchlist: getWatchlist(account.user),
      maxWatchlistItems: WATCHLIST_LIMIT,
    });
    res.json(response);
  },
);

router.put(
  "/account/watchlist",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }

    const parsed = PutAccountWatchlistBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "自選清單格式錯誤，最多可保存 100 檔。" });
      return;
    }

    const normalized = parsed.data.watchlist.map((entry) => ({
      symbol: entry.symbol.trim().toUpperCase(),
      name: entry.name.trim(),
    }));
    const canonicalSymbols = normalized.map((entry) =>
      entry.symbol.replace(/\.(TW|TWO)$/i, ""),
    );
    if (new Set(canonicalSymbols).size !== canonicalSymbols.length) {
      res.status(400).json({ error: "自選清單不可重複加入同一檔股票。" });
      return;
    }

    try {
      const currentAppMetadata = account.user.privateMetadata[APP_METADATA_KEY];
      const appMetadata =
        currentAppMetadata && typeof currentAppMetadata === "object" && !Array.isArray(currentAppMetadata)
          ? (currentAppMetadata as Record<string, unknown>)
          : {};
      const updatedUser = await clerkClient.users.updateUserMetadata(account.user.id, {
        privateMetadata: {
          [APP_METADATA_KEY]: { ...appMetadata, watchlist: normalized },
        },
      });
      res.json(
        PutAccountWatchlistResponse.parse({
          userId: updatedUser.id,
          email: account.email,
          isAdmin: account.isAdmin,
          watchlist: getWatchlist(updatedUser),
          maxWatchlistItems: WATCHLIST_LIMIT,
        }),
      );
    } catch (error) {
      sendProviderError(req, res, error);
    }
  },
);

router.get(
  "/account/stock-ai-conversation",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }

    const params = GetAccountStockAiConversationQueryParams.safeParse(req.query);
    if (!params.success) {
      res.status(400).json({ error: "股票代碼格式錯誤。" });
      return;
    }

    const symbol = params.data.symbol.trim().toUpperCase();
    try {
      const conversation = await getStockAiConversation(account.user.id, symbol);
      res.json(GetAccountStockAiConversationResponse.parse(conversation));
    } catch (error) {
      sendConversationStorageError(req, res, error);
    }
  },
);

router.put(
  "/account/stock-ai-conversation",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }

    const parsed = PutAccountStockAiConversationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "對話格式錯誤，最多可保存最近 50 則訊息。" });
      return;
    }

    try {
      const conversation = await saveStockAiConversation(
        account.user.id,
        parsed.data,
      );
      res.json(PutAccountStockAiConversationResponse.parse(conversation));
    } catch (error) {
      sendConversationStorageError(req, res, error);
    }
  },
);

router.delete(
  "/account/stock-ai-conversation",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }

    const params = DeleteAccountStockAiConversationQueryParams.safeParse(req.query);
    if (!params.success) {
      res.status(400).json({ error: "股票代碼格式錯誤。" });
      return;
    }

    try {
      await deleteStockAiConversation(
        account.user.id,
        params.data.symbol.trim().toUpperCase(),
      );
      DeleteAccountStockAiConversationResponse.parse(undefined);
      res.status(204).end();
    } catch (error) {
      sendConversationStorageError(req, res, error);
    }
  },
);

router.post(
  "/account/quant-research/interpret",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    const parsed = PostAccountQuantResearchInterpretBody.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues.map((issue) => issue.path) }, "Invalid quantitative research interpretation input");
      res.status(400).json({ error: "研究條件格式錯誤，請確認假說、本金與回測設定。" });
      return;
    }
    if (isQuantResearchRateLimited(account.user.id)) {
      res.status(429).json({ error: "研究請求過於頻繁，請稍後再試。" });
      return;
    }
    try {
      const interpretation = QuantResearchInterpretationSchema.parse(
        await interpretQuantResearchHypothesis(parsed.data),
      );
      res.json(interpretation);
    } catch (error) {
      sendQuantOperationError(req, res, error, "AI 暫時無法判讀研究假設，請稍後重試。");
    }
  },
);

router.post(
  "/account/quant-research/stream",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    const parsed = PostAccountQuantResearchStreamBody.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues.map((issue) => issue.path) }, "Invalid quantitative research execution input");
      res.status(400).json({ error: "研究條件格式錯誤，請確認假說、本金與回測設定。" });
      return;
    }
    if (isQuantResearchRateLimited(account.user.id)) {
      res.status(429).json({ error: "研究請求過於頻繁，請稍後再試。" });
      return;
    }

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let streamOpen = true;
    let currentStage: QuantResearchProgress["stage"] = "strategy";
    const writeEvent = (
      event:
        | QuantResearchProgress
        | { type: "result"; result: unknown }
        | { type: "error"; message: string },
      flushProxyBuffer = false,
    ) => {
      if (!streamOpen || res.writableEnded) return;
      try {
        res.write(
          `data: ${JSON.stringify(event)}\n\n${flushProxyBuffer ? SSE_PROXY_FLUSH_PADDING : ""}`,
        );
        (res as Response & { flush?: () => void }).flush?.();
      } catch {
        streamOpen = false;
      }
    };
    writeEvent(
      {
        type: "progress",
        stage: "strategy",
        message: "研究服務已連線，正在初始化 AI 備援服務。",
      },
      true,
    );
    const heartbeat = setInterval(() => {
      writeEvent({
        type: "progress",
        stage: currentStage,
        message: "仍在處理中，連線正常；已保存的官方行情會保留。",
      }, true);
    }, 12_000);
    heartbeat.unref?.();
    res.once("close", () => {
      streamOpen = false;
      clearInterval(heartbeat);
    });

    try {
      const { interpretation, ...researchInput } = parsed.data;
      const draft = await runQuantResearch(researchInput, (event) => {
        currentStage = event.stage;
        writeEvent(event);
      }, interpretation);
      writeEvent({
        type: "progress",
        stage: "saving",
        message: "回測已完成，正在儲存研究紀錄。",
      });
      const result = PostAccountQuantResearchResponse.parse(
        await saveQuantResearchRun(account.user.id, draft),
      );
      writeEvent({
        type: "progress",
        stage: "saving",
        message: "研究結果已儲存。",
      });
      writeEvent({ type: "result", result });
    } catch (error) {
      const failure = getQuantOperationFailure(
        error,
        "研究執行失敗，請稍後重試。",
      );
      req.log.error(
        { err: error },
        "Streaming quantitative research operation failed",
      );
      writeEvent({ type: "error", message: failure.message });
    } finally {
      clearInterval(heartbeat);
      if (streamOpen && !res.writableEnded) res.end();
    }
  },
);

router.post(
  "/account/quant-research",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    const parsed = PostAccountQuantResearchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "研究條件格式錯誤，請確認假說、本金與回測設定。" });
      return;
    }
    if (isQuantResearchRateLimited(account.user.id)) {
      res.status(429).json({ error: "研究請求過於頻繁，請稍後再試。" });
      return;
    }

    try {
      const { interpretation, ...researchInput } = parsed.data;
      const draft = await runQuantResearch(
        researchInput,
        undefined,
        interpretation,
      );
      const result = await saveQuantResearchRun(account.user.id, draft);
      res.json(PostAccountQuantResearchResponse.parse(result));
    } catch (error) {
      sendQuantOperationError(
        req,
        res,
        error,
        "量化研究暫時無法完成，請稍後再試。",
      );
    }
  },
);

router.get(
  "/account/quant-research-runs",
  async (_req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    try {
      const runs = await listQuantResearchRuns(account.user.id);
      res.json(GetAccountQuantResearchRunsResponse.parse({ runs }));
    } catch (error) {
      sendQuantOperationError(
        _req,
        res,
        error,
        "研究紀錄暫時無法讀取。",
      );
    }
  },
);

router.delete(
  "/account/quant-research-runs",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    try {
      await deleteQuantResearchRuns(account.user.id);
      DeleteAccountQuantResearchRunsResponse.parse(undefined);
      res.status(204).end();
    } catch (error) {
      sendQuantOperationError(
        req,
        res,
        error,
        "研究紀錄暫時無法清空。",
      );
    }
  },
);

router.get(
  "/account/quant-research-runs/:runId",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    const params = GetAccountQuantResearchRunParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "研究紀錄編號無效。" });
      return;
    }
    try {
      const result = await getQuantResearchRun(
        account.user.id,
        params.data.runId,
      );
      if (!result) {
        res.status(404).json({ error: "找不到這筆研究紀錄。" });
        return;
      }
      res.json(GetAccountQuantResearchRunResponse.parse(result));
    } catch (error) {
      sendQuantOperationError(
        req,
        res,
        error,
        "研究紀錄暫時無法讀取。",
      );
    }
  },
);

router.post(
  "/account/quant-research-runs/:runId/summary",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    const params = PostAccountQuantResearchRunSummaryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "研究紀錄編號無效。" });
      return;
    }
    try {
      const result = await getQuantResearchRun(
        account.user.id,
        params.data.runId,
      );
      if (!result) {
        res.status(404).json({ error: "找不到這筆研究紀錄。" });
        return;
      }
      if (result.aiSummary) {
        res.json(
          PostAccountQuantResearchRunSummaryResponse.parse({
            aiSummary: result.aiSummary,
          }),
        );
        return;
      }

      const aiSummary = await generateQuantResearchSummary(result);
      if (!aiSummary) {
        res.status(503).json({
          error: "AI 摘要暫時無法生成，請稍後重試；回測結果仍可查看。",
        });
        return;
      }
      const updatedResult = await saveQuantResearchRunSummary(
        account.user.id,
        params.data.runId,
        aiSummary,
      );
      if (!updatedResult?.aiSummary) {
        res.status(404).json({ error: "找不到這筆研究紀錄。" });
        return;
      }
      res.json(
        PostAccountQuantResearchRunSummaryResponse.parse({
          aiSummary: updatedResult.aiSummary,
        }),
      );
    } catch (error) {
      sendQuantOperationError(
        req,
        res,
        error,
        "AI 摘要暫時無法生成，請稍後重試。",
      );
    }
  },
);

router.get(
  "/account/paper-trading",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    try {
      const portfolio = await getPaperTradingPortfolio(account.user.id);
      res.json(GetAccountPaperTradingResponse.parse(portfolio));
    } catch (error) {
      sendQuantOperationError(
        req,
        res,
        error,
        "紙上交易帳戶暫時無法讀取。",
      );
    }
  },
);

router.post(
  "/account/paper-trading",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    const parsed = PostAccountPaperTradingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "起始本金必須介於 100,000 至 100,000,000 元。" });
      return;
    }
    try {
      const portfolio = await createPaperTradingAccount(
        account.user.id,
        parsed.data.startingCash,
      );
      res
        .status(201)
        .json(PostAccountPaperTradingResponse.parse(portfolio));
    } catch (error) {
      sendQuantOperationError(
        req,
        res,
        error,
        "紙上交易帳戶暫時無法建立。",
      );
    }
  },
);

router.post(
  "/account/paper-trading/reset",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    try {
      const portfolio = await resetPaperTradingAccount(account.user.id);
      res.json(PostAccountPaperTradingResetResponse.parse(portfolio));
    } catch (error) {
      sendQuantOperationError(
        req,
        res,
        error,
        "紙上交易帳戶重設失敗。",
      );
    }
  },
);

router.post(
  "/account/paper-trading/trades",
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const account = res.locals.account;
    if (!account) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }
    const parsed = PostAccountPaperTradeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "模擬交易格式錯誤，請確認股票代碼、方向、股數與成交價格。" });
      return;
    }
    try {
      const portfolio = await recordPaperTrade(account.user.id, parsed.data);
      res.status(201).json(PostAccountPaperTradeResponse.parse(portfolio));
    } catch (error) {
      sendQuantOperationError(
        req,
        res,
        error,
        "模擬交易暫時無法記錄。",
      );
    }
  },
);

router.get(
  "/admin/users",
  requireAdmin,
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const parsed = GetAdminUsersQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "搜尋條件格式錯誤。" });
      return;
    }

    try {
      const providerUsers: User[] = [];
      let providerOffset = 0;
      let providerTotalCount = 0;
      do {
        const result = await clerkClient.users.getUserList({
          limit: 500,
          offset: providerOffset,
          ...(parsed.data.query ? { query: parsed.data.query } : {}),
        });
        providerUsers.push(...result.data);
        providerTotalCount = result.totalCount;
        if (result.data.length === 0) break;
        providerOffset += result.data.length;
      } while (providerOffset < providerTotalCount);

      const usersWithAccess = providerUsers.map(serializeAdminUser);

      const users = usersWithAccess.slice(
        parsed.data.offset,
        parsed.data.offset + parsed.data.limit,
      );
      res.json(GetAdminUsersResponse.parse({ users, totalCount: usersWithAccess.length }));
    } catch (error) {
      sendProviderError(req, res, error);
    }
  },
);

router.post(
  "/admin/invitations",
  requireAdmin,
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const parsed = PostAdminInvitationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "請輸入有效的電子郵件地址。" });
      return;
    }

    try {
      const emailAddress = parsed.data.email.trim().toLowerCase();
      const invitationParams = {
        emailAddress,
        notify: true,
        redirectUrl: getInvitationRedirectUrl(req),
        publicMetadata: {
          [APP_METADATA_KEY]: { access: "active", role: "member" },
        },
      };
      let invitation;
      try {
        invitation = await clerkClient.invitations.createInvitation(invitationParams);
      } catch (error) {
        if (!isDuplicateClerkRecord(error)) throw error;
        const pendingInvitations = await clerkClient.invitations.getInvitationList({
          query: emailAddress,
          status: "pending",
          limit: 100,
        });
        const hasMatchingPendingInvitation = pendingInvitations.data.some(
          (item) =>
            item.status === "pending" &&
            item.emailAddress.toLowerCase() === emailAddress,
        );
        if (!hasMatchingPendingInvitation) throw error;

        // A retry creates a fresh invitation email and link without invalidating the old link.
        invitation = await clerkClient.invitations.createInvitation({
          ...invitationParams,
          ignoreExisting: true,
        });
      }
      res.status(201).json(
        PostAdminInvitationResponse.parse({
          id: invitation.id,
          email: invitation.emailAddress,
          status: invitation.status,
          createdAt: new Date(invitation.createdAt).toISOString(),
          invitationUrl: invitation.url ?? null,
        }),
      );
    } catch (error) {
      sendProviderError(req, res, error);
    }
  },
);

router.patch(
  "/admin/users/:userId",
  requireAdmin,
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const params = PatchAdminUserParams.safeParse(req.params);
    const parsed = PatchAdminUserBody.safeParse(req.body);
    if (!params.success || !parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      res.status(400).json({ error: "請提供有效的角色或帳號狀態。" });
      return;
    }

    const actor = res.locals.account;
    if (!actor) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }

    try {
      let user = await clerkClient.users.getUser(params.data.userId);
      const targetEmail = getPrimaryEmail(user);
      const targetIsBootstrapAdmin = isBootstrapAdmin(user, targetEmail);
      const targetIsManagedAccount =
        targetIsBootstrapAdmin || getAppMetadata(user).access === "active";
      if (parsed.data.role !== undefined && !targetIsManagedAccount) {
        res.status(403).json({ error: "未獲邀帳號不可變更應用程式角色。" });
        return;
      }
      if (
        (targetIsBootstrapAdmin && (parsed.data.role === "member" || parsed.data.banned === true)) ||
        (user.id === actor.user.id &&
          (parsed.data.role === "member" || parsed.data.banned === true))
      ) {
        res.status(400).json({ error: "不可停用自己或移除初始管理員的管理員權限。" });
        return;
      }

      if (parsed.data.role) {
        user = await clerkClient.users.updateUserMetadata(user.id, {
          publicMetadata: {
            [APP_METADATA_KEY]: {
              ...getAppMetadata(user),
              role: parsed.data.role,
            },
          },
        });
      }
      if (parsed.data.banned === true && !user.banned) {
        user = await clerkClient.users.banUser(user.id);
      } else if (parsed.data.banned === false && user.banned) {
        user = await clerkClient.users.unbanUser(user.id);
      }

      const serialized = serializeAdminUser(user);
      res.json(PatchAdminUserResponse.parse(serialized));
    } catch (error) {
      sendProviderError(req, res, error);
    }
  },
);

router.delete(
  "/admin/users/:userId",
  requireAdmin,
  async (req: Request, res: Response<unknown, AccountLocals>): Promise<void> => {
    const params = DeleteAdminUserParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "使用者識別資料格式錯誤。" });
      return;
    }

    const actor = res.locals.account;
    if (!actor) {
      res.status(401).json({ error: "請先登入。" });
      return;
    }

    try {
      let user: User;
      try {
        user = await clerkClient.users.getUser(params.data.userId);
      } catch (error) {
        const status =
          error && typeof error === "object" && "status" in error
            ? Number((error as { status?: unknown }).status)
            : undefined;
        if (status === 404) {
          // A prior deletion may have succeeded while application-data cleanup failed.
          await deleteAccountData(params.data.userId);
          res.status(204).end();
          return;
        }
        throw error;
      }

      const targetEmail = getPrimaryEmail(user);
      const blockReason = getAdminUserDeleteBlockReason({
        actorId: actor.user.id,
        targetId: user.id,
        targetIsBootstrapAdmin: isBootstrapAdmin(user, targetEmail),
        targetRole: getAppMetadata(user).role,
      });
      if (blockReason) {
        res.status(400).json({ error: blockReason });
        return;
      }

      await clerkClient.users.deleteUser(user.id);
      await deleteAccountData(user.id);
      res.status(204).end();
    } catch (error) {
      sendProviderError(
        req,
        res,
        error,
        "帳戶刪除或相關資料清理暫時失敗；請確認名冊後再試。",
      );
    }
  },
);

router.use(
  (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    sendProviderError(req, res, error);
  },
);

export default router;