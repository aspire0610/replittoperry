import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";
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
  GetStockAiPicksResponse,
  GetStockAiPicksProgressResponse,
  GetStockAiPicksScanJobResponse,
  GetEtfMarketResponse,
  StartStockAiPicksScanJobResponse,
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
  RunStockAiHistoricalValidationBatchBody,
  RunStockAiHistoricalValidationBatchResponse,
} from "@workspace/api-zod";
import {
  getMarketWideAiPickScanJobForToday,
  getMarketWideAiPickScanJob,
  startMarketWideAiPickScanJob,
} from "../lib/market-wide-ai-pick-scan-jobs";
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
import { getEtfMarketData } from "../lib/etf-distribution-data.js";
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
import { getMarketChecklist } from "../lib/market-checklist.js";
import {
  getMarketWideAiPicks,
  getMarketWideAiPicksProgress,
} from "../lib/market-wide-ai-picks.js";
import {
  getStockAiHistoricalValidationProgress,
  runStockAiHistoricalValidationBatch,
} from "../lib/stock-ai-historical-validation.js";
import { createAiRequestRateLimiter } from "../lib/ai-request-rate-limit.js";
import {
  buildStockMarkdownReport,
  buildStockScorecard,
  buildStockScanTags,
  buildStockTradeScenarios,
} from "../lib/stock-scorecard.js";

const router: IRouter = Router();
const assistantChatAuthMiddleware = clerkMiddleware();
const aiRequestRateLimiter = createAiRequestRateLimiter({
  windowMs: 60_000,
  globalLimit: 60,
  operationLimit: 12,
});

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
  const clientKey = req.ip || req.socket.remoteAddress || "unknown";
  const symbol = typeof req.query.symbol === "string"
    ? req.query.symbol.trim().toUpperCase()
    : "";
  return aiRequestRateLimiter.isLimited({
    clientKey,
    operationKey: `${req.path}:${symbol}`,
  });
}

async function buildRateLimitedStockReport(symbol: string): Promise<string | null> {
  try {
    const history = await getStockHistory(symbol, "6mo");
    const latest = history.bars.at(-1);
    if (!latest) return null;
    const previous = history.bars.at(-2);
    const research = await getStockResearchData(history.symbol, history.ticker)
      .catch(() => null);
    const scorecardWithInstitutional = buildStockScorecard(history.bars, research?.institutional ?? {
      status: "unavailable",
      foreignNetShares: null,
      investmentTrustNetShares: null,
    });
    const scenarios = buildStockTradeScenarios(history.bars, latest.close);
    return buildStockMarkdownReport({
      symbol: history.symbol,
      ticker: history.ticker,
      name: null,
      currentPrice: latest.close,
      changePercent: previous && previous.close > 0
        ? ((latest.close / previous.close) - 1) * 100
        : null,
      biasLevel: "insufficient",
      summary: "AI 判讀目前受限，無法提供方向訊號。",
      actionText: "暫不提供 AI 買賣建議；請稍後重新分析。",
      template: "automated_quant",
      decisionSignal: "🔴 資料不足，暫不交易",
      scanTags: buildStockScanTags(scorecardWithInstitutional),
      positionSizingNote: "未提供單筆風險預算，不估算資金或股數。",
      scorecard: scorecardWithInstitutional,
      scenarios,
    });
  } catch {
    return null;
  }
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
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  try {
    const summary = await getTaiexSummary();
    const checklist = await getMarketChecklist(
      new Date(summary.dailyCloseDate).toISOString().slice(0, 10),
      summary.currentPrice,
      summary.ma20,
      summary.ma60,
      summary.support20 ?? null,
      summary.resistance20 ?? null,
    );
    res.json(GetMarketSummaryResponse.parse({ ...summary, checklist }));
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
    const mode = req.query.mode === "closing" ? "closing" : "premarket";
    if (mode === "closing") {
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      if (marketData.dailyCloseDate !== today) {
        res.status(503).json({
          error: "今日官方收盤資料尚未更新，盤後摘要暫不可用。",
        });
        return;
      }
    }
    const result = await getMarketAiDailySummary(marketData, mode);
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
      const latest = history.bars.at(-1);
      const previous = history.bars.at(-2);
      quote = {
        name: null,
        price: latest?.close ?? null,
        previousClose: previous?.close ?? null,
        change:
          latest && previous ? latest.close - previous.close : null,
        changePercent:
          latest && previous && previous.close !== 0
            ? ((latest.close - previous.close) / previous.close) * 100
            : null,
        source: `${history.source} · 官方最近收盤`,
        asOf: latest ? new Date(`${latest.date}T13:30:00+08:00`) : null,
        available: Boolean(latest),
        error: latest
          ? `${message}；暫顯示 ${latest.date} 官方收盤價，非即時行情。`
          : message,
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

router.get("/etfs/market", async (req, res): Promise<void> => {
  res.setHeader(
    "Cache-Control",
    "public, max-age=300, s-maxage=900, stale-while-revalidate=1800",
  );
  try {
    res.json(GetEtfMarketResponse.parse(await getEtfMarketData()));
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to load official ETF market data");
  }
});

router.get("/stocks/ai-picks/progress", (_req, res): void => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.json(GetStockAiPicksProgressResponse.parse(getMarketWideAiPicksProgress()));
});

router.post("/stocks/ai-picks/scan-jobs", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  try {
    const body: unknown = req.body ?? {};
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "force") ||
      ("force" in body && typeof body.force !== "boolean")
    ) {
      res.status(400).json({ error: "Invalid scan request" });
      return;
    }
    const force = "force" in body && body.force === true;
    if (!force) {
      const todayJob = await getMarketWideAiPickScanJobForToday();
      if (todayJob) {
        res.status(202).json(StartStockAiPicksScanJobResponse.parse({
          id: todayJob.id,
          status: todayJob.status,
          stage: todayJob.stage,
          percent: todayJob.progress,
          completedBatches: todayJob.completedBatches,
          failedBatches: todayJob.failedBatches,
          totalBatches: todayJob.totalBatches,
          scannedCount: todayJob.scannedCount,
          candidateCount: todayJob.candidateCount,
          completedCandidates: todayJob.completedCandidates,
          result: todayJob.result ?? null,
          errorMessage: todayJob.errorMessage ?? null,
          createdAt: todayJob.createdAt.toISOString(),
          updatedAt: todayJob.updatedAt.toISOString(),
        }));
        return;
      }
    }
    if (isAiAssessmentRateLimited(req)) {
      res.status(429).json({ error: "AI 選股請求過於頻繁，請稍後再試。" });
      return;
    }
    const job = await startMarketWideAiPickScanJob(new Date(), { force });
    res.status(202).json(StartStockAiPicksScanJobResponse.parse({
      id: job.id,
      status: job.status,
      stage: job.stage,
      percent: job.progress,
      completedBatches: job.completedBatches,
      failedBatches: job.failedBatches,
      totalBatches: job.totalBatches,
      scannedCount: job.scannedCount,
      candidateCount: job.candidateCount,
      completedCandidates: job.completedCandidates,
      result: job.result ?? null,
      errorMessage: job.errorMessage ?? null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    }));
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to start market-wide AI scan");
  }
});

router.get("/stocks/ai-picks/scan-jobs/:jobId", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  const jobId = Number(req.params.jobId);
  if (!Number.isSafeInteger(jobId) || jobId < 1) {
    res.status(400).json({ error: "Invalid scan job id" });
    return;
  }
  try {
    const job = await getMarketWideAiPickScanJob(jobId);
    if (!job) {
      res.status(404).json({ error: "Scan job not found" });
      return;
    }
    res.json(GetStockAiPicksScanJobResponse.parse({
      id: job.id,
      status: job.status,
      stage: job.stage,
      percent: job.progress,
      completedBatches: job.completedBatches,
      failedBatches: job.failedBatches,
      totalBatches: job.totalBatches,
      scannedCount: job.scannedCount,
      candidateCount: job.candidateCount,
      completedCandidates: job.completedCandidates,
      result: job.result ?? null,
      errorMessage: job.errorMessage ?? null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    }));
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to load market-wide AI scan status");
  }
});

router.get("/stocks/ai-picks", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  try {
    const todayJob = await getMarketWideAiPickScanJobForToday();
    if (!todayJob && isAiAssessmentRateLimited(req)) {
      res.status(429).json({ error: "AI 選股請求過於頻繁，請稍後再試。" });
      return;
    }
    const picks = await getMarketWideAiPicks();
    res.json(GetStockAiPicksResponse.parse(picks));
  } catch (error) {
    respondWithMarketError(req, res, error, "Unable to scan market for AI stock picks");
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
    const reportMarkdown = await buildRateLimitedStockReport(parsed.data.symbol);
    res.status(429).json({
      error: "AI 判讀請求過於頻繁，請稍後再試。",
      ...(reportMarkdown ? { reportMarkdown } : {}),
    });
    return;
  }

  try {
    const assessment = await getStockAiAssessment(parsed.data.symbol);
    res.json(GetStockAiAssessmentResponse.parse(assessment));
  } catch (error) {
    if (error instanceof MarketDataError && error.status === 429) {
      const reportMarkdown = await buildRateLimitedStockReport(parsed.data.symbol);
      res.status(429).json({
        error: error.message,
        ...(reportMarkdown ? { reportMarkdown } : {}),
      });
      return;
    }
    respondWithMarketError(
      req,
      res,
      error,
      "Unable to generate Taiwan stock AI assessment",
    );
  }
});

router.post("/stocks/ai-historical-validation", async (req, res): Promise<void> => {
  const parsed = RunStockAiHistoricalValidationBatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (isAiAssessmentRateLimited(req)) {
    res.status(429).json({ error: "歷史 AI 回測請求過於頻繁，請稍後再試。" });
    return;
  }
  if (req.get("accept")?.includes("text/event-stream")) {
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const controller = new AbortController();
    let streamOpen = true;
    const writeEvent = (event: unknown, pad = false) => {
      if (!streamOpen || res.writableEnded) return;
      try {
        res.write(
          `data: ${JSON.stringify(event)}\n\n${pad ? `:${" ".repeat(4_096)}\n\n` : ""}`,
        );
        (res as Response & { flush?: () => void }).flush?.();
      } catch {
        streamOpen = false;
        controller.abort();
      }
    };
    const heartbeat = setInterval(() => {
      writeEvent({ type: "heartbeat", message: "仍在處理官方行情或 AI 判讀。" }, true);
    }, 10_000);
    heartbeat.unref?.();
    res.once("close", () => {
      streamOpen = false;
      clearInterval(heartbeat);
      controller.abort();
    });

    try {
      writeEvent({ type: "status", message: "正在讀取官方歷史日線。" }, true);
      const history = await getStockHistory(parsed.data.symbol, "5y");
      const initialProgress = await getStockAiHistoricalValidationProgress(
        history.symbol,
        history.bars,
      );
      writeEvent({ type: "progress", progress: initialProgress }, true);
      const progress = await runStockAiHistoricalValidationBatch(
        history.symbol,
        history.bars,
        {
          signal: controller.signal,
          onProgress: (event) => {
            req.log.info(
              {
                symbol: history.symbol,
                phase: event.phase,
                forecastDate: event.forecastDate,
                forecastIndex: event.forecastIndex,
                requiredForecastCount: event.requiredForecastCount,
                processedForecastCount: event.progress.processedForecastCount,
              },
              "AI historical stock backtest progress",
            );
            writeEvent(event, true);
          },
        },
      );
      writeEvent({ type: "done", progress }, true);
      res.end();
    } catch (error) {
      if (streamOpen) {
        req.log.warn(
          { err: error, symbol: parsed.data.symbol },
          "Unable to stream historical AI stock validation progress",
        );
        writeEvent({
          type: "error",
          message:
            error instanceof MarketDataError
              ? error.message
              : "AI 或官方行情暫時無法連線；已保存完成的樣本，可稍後續跑。",
        });
        res.end();
      }
    } finally {
      clearInterval(heartbeat);
    }
    return;
  }
  try {
    const history = await getStockHistory(parsed.data.symbol, "5y");
    const progress = await runStockAiHistoricalValidationBatch(
      history.symbol,
      history.bars,
      {
        onProgress: (event) => {
          req.log.info(
            {
              symbol: history.symbol,
              phase: event.phase,
              forecastDate: event.forecastDate,
              forecastIndex: event.forecastIndex,
              requiredForecastCount: event.requiredForecastCount,
              processedForecastCount: event.progress.processedForecastCount,
            },
            "AI historical stock backtest progress",
          );
        },
      },
    );
    res.json(RunStockAiHistoricalValidationBatchResponse.parse(progress));
  } catch (error) {
    req.log.warn(
      { err: error, symbol: parsed.data.symbol },
      "Unable to run historical AI stock validation batch",
    );
    respondWithMarketError(
      req,
      res,
      error,
      "Unable to run historical AI stock validation batch",
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

router.post("/assistant/chat", assistantChatAuthMiddleware, async (req, res): Promise<void> => {
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
    const userId = getAuth(req).userId;
    const reply = await askAssistantChat(
      parsed.data.question,
      parsed.data.symbol,
      parsed.data.history ?? [],
      requestId,
      {
        researchOwner: userId ? { userId, channel: "web" } : undefined,
      },
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