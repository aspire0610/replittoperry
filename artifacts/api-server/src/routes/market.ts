import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  AskAssistantChatBody,
  AskAssistantChatResponse,
  AskStockAiAssistantBody,
  AskStockAiAssistantResponse,
  EvaluateStockAiBuyPriceBody,
  EvaluateStockAiBuyPriceResponse,
  GetStockAiAssessmentQueryParams,
  GetStockAiAssessmentResponse,
  GetStockCatalogResponse,
  GetMarketHistoryQueryParams,
  GetMarketHistoryResponse,
  GetMarketIntradayResponse,
  GetMarketOverviewResponse,
  GetMarketSummaryResponse,
  GetMarketAiDailySummaryResponse,
  GetFuturesAiDayStrategyResponse,
  GetStockHistoryQueryParams,
  GetStockHistoryResponse,
  GetStockResearchDataQueryParams,
  GetStockResearchDataResponse,
} from "@workspace/api-zod";
import {
  getMarketOverviewQuotes,
  getStockQuote,
  getStockHistory,
  getStockCatalog,
  getTaiexHistory,
  getTaiexIntradayHistory,
  getTaiexSummary,
  type MarketQuoteData,
  type StockQuoteData,
  MarketDataError,
} from "../lib/market-data";
import { MAX_VERIFIED_STOCK_TRADE_AGE_MS } from "../lib/stock-ai-quote-policy.js";
import {
  askStockAiAssistant,
  evaluateStockAiBuyPrice,
  getStockAiAssessment,
} from "../lib/stock-ai-assessment.js";
import { askAssistantChat } from "../lib/assistant-chat.js";
import { getFuturesAiDayStrategy } from "../lib/futures-ai-day-strategy.js";
import { getStockResearchData } from "../lib/stock-research-data.js";
import { getMarketAiDailySummary } from "../lib/market-ai-daily-summary.js";

const router: IRouter = Router();
const aiAssessmentLimits = new Map<
  string,
  { resetAt: number; count: number }
>();
const AI_RATE_WINDOW_MS = 60_000;
const AI_RATE_LIMIT = 12;

function respondWithMarketError(
  req: Request,
  res: Response,
  error: unknown,
  message: string,
): void {
  const status = error instanceof MarketDataError ? error.status : 502;
  const errorMessage =
    error instanceof MarketDataError
      ? error.message
      : "行情來源暫時無法使用，請稍後再試";
  req.log.warn({ err: error, status }, message);
  res.status(status).json({ error: errorMessage });
}

function isAiAssessmentRateLimited(req: Request): boolean {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const current = aiAssessmentLimits.get(key);
  if (current && current.resetAt > now) {
    if (current.count >= AI_RATE_LIMIT) return true;
    current.count += 1;
  } else {
    aiAssessmentLimits.set(key, {
      resetAt: now + AI_RATE_WINDOW_MS,
      count: 1,
    });
  }

  if (aiAssessmentLimits.size > 2_000) {
    for (const [ip, limit] of aiAssessmentLimits) {
      if (limit.resetAt <= now) aiAssessmentLimits.delete(ip);
    }
  }
  return false;
}

router.get("/market/overview", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  try {
    const indices: MarketQuoteData[] = await getMarketOverviewQuotes();
    const asOf = indices
      .flatMap((quote) => (quote.asOf ? [quote.asOf] : []))
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
    const response = GetMarketOverviewResponse.parse({
      asOf,
      indices,
    });
    res.json(response);
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to load market overview");
  }
});

router.get("/market/summary", async (req, res): Promise<void> => {
  try {
    const summary = await getTaiexSummary();
    res.json(GetMarketSummaryResponse.parse(summary));
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to calculate market summary");
  }
});

router.get("/market/ai-daily-summary", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (isAiAssessmentRateLimited(req)) {
    res.status(429).json({
      error: "AI 每日總結請求過於頻繁，請稍後再試。",
    });
    return;
  }

  try {
    const marketData = await getTaiexSummary();
    const result = await getMarketAiDailySummary(marketData);
    res.json(GetMarketAiDailySummaryResponse.parse(result));
  } catch (error) {
    respondWithMarketError(
      req,
      res,
      error,
      "Unable to generate the AI daily market summary",
    );
  }
});

router.get("/futures/ai-day-strategy", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (isAiAssessmentRateLimited(req)) {
    res.status(429).json({
      error: "AI 期貨策略請求過於頻繁，請稍後再試。",
    });
    return;
  }

  try {
    const strategy = await getFuturesAiDayStrategy();
    res.json(GetFuturesAiDayStrategyResponse.parse(strategy));
  } catch (error) {
    respondWithMarketError(
      req,
      res,
      error,
      "Unable to generate Taiwan index futures day strategy",
    );
  }
});

router.get("/market/intraday", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  try {
    const intraday = await getTaiexIntradayHistory();
    res.json(GetMarketIntradayResponse.parse(intraday));
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to load TAIEX intraday history");
  }
});

router.get("/market/history", async (req, res): Promise<void> => {
  const parsed = GetMarketHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid market history query");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const history = await getTaiexHistory(parsed.data.range);
    res.json(GetMarketHistoryResponse.parse(history));
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to load market history");
  }
});

router.get("/stocks/history", async (req, res): Promise<void> => {
  const parsed = GetStockHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid stock history query");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const history = await getStockHistory(
      parsed.data.symbol,
      parsed.data.range,
    );
    let quote: StockQuoteData;
    try {
      quote = await getStockQuote(
        history.symbol,
        history.ticker.endsWith(".TWO") ? "otc" : "tse",
        { maxInSessionAgeMs: MAX_VERIFIED_STOCK_TRADE_AGE_MS },
      );
    } catch (error) {
      const message =
        error instanceof MarketDataError
          ? error.message
          : "個股最新成交報價暫時無法取得";
      req.log.warn(
        { err: error, symbol: history.symbol },
        "Unable to load the latest Taiwan stock quote",
      );
      quote = {
        name: null,
        price: null,
        previousClose: null,
        change: null,
        changePercent: null,
        source: "TWSE MIS",
        asOf: null,
        available: false,
        error: message,
      };
    }
    res.json(GetStockHistoryResponse.parse({ ...history, quote }));
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to load stock history");
  }
});

router.get("/stocks/catalog", async (req, res): Promise<void> => {
  res.setHeader(
    "Cache-Control",
    "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400",
  );
  try {
    const catalog = await getStockCatalog();
    res.json(GetStockCatalogResponse.parse(catalog));
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to load the official stock catalog");
  }
});

router.get("/stocks/research-data", async (req, res): Promise<void> => {
  const parsed = GetStockResearchDataQueryParams.safeParse(req.query);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid stock research data query");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const data = await getStockResearchData(parsed.data.symbol, parsed.data.ticker);
    res.json(GetStockResearchDataResponse.parse(data));
  } catch (error) {
    req.log.warn({ err: error, symbol: parsed.data.symbol }, "Unable to load official stock research data");
    res.status(502).json({ error: "官方財報或投資機構買賣資料暫時無法取得" });
  }
});

router.get("/stocks/ai-assessment", async (req, res): Promise<void> => {
  const parsed = GetStockAiAssessmentQueryParams.safeParse(req.query);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid AI assessment query");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (isAiAssessmentRateLimited(req)) {
    res.status(429).json({
      error: "AI 判讀請求過於頻繁，請稍後再試。",
    });
    return;
  }

  try {
    const assessment = await getStockAiAssessment(parsed.data.symbol);
    res.json(GetStockAiAssessmentResponse.parse(assessment));
  } catch (error) {
    respondWithMarketError(
      req,
      res,
      error,
      "Unable to generate Taiwan stock AI assessment",
    );
  }
});

router.post("/stocks/ai-buy-verdict", async (req, res): Promise<void> => {
  const parsed = EvaluateStockAiBuyPriceBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      { errors: parsed.error.message },
      "Invalid AI buy-price verdict request",
    );
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (isAiAssessmentRateLimited(req)) {
    res.status(429).json({
      error: "AI 買進價判讀請求過於頻繁，請稍後再試。",
    });
    return;
  }

  try {
    const verdict = await evaluateStockAiBuyPrice(
      parsed.data.symbol,
      parsed.data.plannedBuyPrice,
    );
    res.json(EvaluateStockAiBuyPriceResponse.parse(verdict));
  } catch (error) {
    respondWithMarketError(
      req,
      res,
      error,
      "Unable to evaluate Taiwan stock AI buy price",
    );
  }
});

router.post("/stocks/ai-assistant", async (req, res): Promise<void> => {
  const parsed = AskStockAiAssistantBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      { errors: parsed.error.message },
      "Invalid AI assistant question",
    );
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const question = parsed.data.question.trim();
  if (!question) {
    res.status(400).json({ error: "請先輸入問題。" });
    return;
  }
  if (isAiAssessmentRateLimited(req)) {
    res.status(429).json({
      error: "AI 問答請求過於頻繁，請稍後再試。",
    });
    return;
  }

  try {
    const requestId =
      typeof req.id === "string" || typeof req.id === "number"
        ? req.id
        : undefined;
    const reply = await askStockAiAssistant(
      parsed.data.symbol,
      question,
      requestId,
      parsed.data.history ?? [],
    );
    res.json(AskStockAiAssistantResponse.parse(reply));
  } catch (error) {
    respondWithMarketError(
      req,
      res,
      error,
      "Unable to answer Taiwan stock AI assistant question",
    );
  }
});

router.post("/assistant/chat", async (req, res): Promise<void> => {
  const parsed = AskAssistantChatBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      { errors: parsed.error.message },
      "Invalid general AI chat request",
    );
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (isAiAssessmentRateLimited(req)) {
    res.status(429).json({
      error: "AI 問答請求過於頻繁，請稍後再試。",
    });
    return;
  }

  try {
    const requestId =
      typeof req.id === "string" || typeof req.id === "number"
        ? req.id
        : undefined;
    const reply = await askAssistantChat(
      parsed.data.question,
      parsed.data.symbol,
      parsed.data.history ?? [],
      requestId,
    );
    res.json(AskAssistantChatResponse.parse(reply));
  } catch (error) {
    respondWithMarketError(
      req,
      res,
      error,
      "Unable to answer general AI chat question",
    );
  }
});

export default router;