import { logger } from "./lib/logger";
import { runMarketWideAiPickScan, getMarketWideAiPicksProgress } from "./lib/market-wide-ai-picks";
import {
  askStockAiAssistant,
  getCachedStockAiAssessment,
} from "./lib/stock-ai-assessment";
import {
  buildStockResearchAgentFallbackAnswer,
  buildStockResearchAgentPartialAnswer,
} from "./lib/stock-research-agent-fallback";
import { isTaiwanMarketClosed } from "./lib/twse-holiday-calendar";
import {
  claimDueStockResearchAgent,
  saveStockResearchAgentReport,
} from "./lib/ai-stock-research-agents";
import {
  claimQueuedResearchJob,
  requeueStaleResearchJobs,
  updateResearchJob,
} from "./lib/ai-research-jobs";
import { processQueuedResearchJob } from "./lib/assistant-chat";
import {
  claimMarketWideAiPickScanJob,
  failStaleMarketWideAiPickScanJobs,
  updateMarketWideAiPickScanJob,
} from "./lib/market-wide-ai-pick-scan-jobs";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let stopped = false;

async function processJob(id: number): Promise<void> {
  await updateMarketWideAiPickScanJob(id, { status: "running", stage: "market_data", startedAt: new Date() });
  const scan = runMarketWideAiPickScan().then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  let finished = false;
  while (!finished) {
    const progress = getMarketWideAiPicksProgress();
    await updateMarketWideAiPickScanJob(id, {
      stage: progress.stage,
      progress: progress.percent,
      completedBatches: progress.completedBatches,
      failedBatches: progress.failedBatches,
      totalBatches: progress.totalBatches,
      scannedCount: progress.scannedCount,
      candidateCount: progress.candidateCount,
      completedCandidates: progress.completedCandidates,
    });
    const state = await Promise.race([scan, delay(1200).then(() => null)]);
    if (!state) continue;
    finished = true;
    const finalProgress = getMarketWideAiPicksProgress();
    const progressFields = {
      completedBatches: finalProgress.completedBatches,
      failedBatches: finalProgress.failedBatches,
      totalBatches: finalProgress.totalBatches,
      scannedCount: finalProgress.scannedCount,
      candidateCount: finalProgress.candidateCount,
      completedCandidates: finalProgress.completedCandidates,
    };
    if ("error" in state) {
      const message = state.error instanceof Error ? state.error.message : "Market scan failed";
      await updateMarketWideAiPickScanJob(id, {
        ...progressFields,
        status: "failed", stage: "error", errorMessage: message, finishedAt: new Date(),
      });
      logger.error({ err: state.error, jobId: id }, "Market-wide AI scan job failed");
    } else {
      await updateMarketWideAiPickScanJob(id, {
        ...progressFields,
        status: "completed",
        stage: "complete",
        progress: 100,
        result: state.result as unknown as Record<string, unknown>,
        finishedAt: new Date(),
      });
      logger.info({ jobId: id }, "Market-wide AI scan job completed");
    }
  }
}

async function processStockResearchAgent(agent: NonNullable<Awaited<ReturnType<typeof claimDueStockResearchAgent>>>) {
  const closed = await isTaiwanMarketClosed(new Date());
  if (closed === true) {
    logger.info({ agentId: agent.id, symbol: agent.symbol }, "Skipped stock research agent on market holiday");
    return;
  }
  try {
    const result = await askStockAiAssistant(
      agent.symbol,
      `執行每日研究任務：「${agent.mission}」。請明確回答「目前怎麼操作」，並分析近期實際漲跌：列出最新交易日、單日及近 5／20／60 個交易日漲跌幅，說明個股與大盤方向是否一致。操作部分要分清「現在可做什麼」與「還要等什麼條件」；只使用已驗證的動作與價位方案，沒有有效進場／停損／目標價或重新評估條件時，清楚說明不提供，不可自行編價。引用主要依據、反方風險與資料時間；缺少任何期間資料就標明缺漏，不要猜測。`,
      `stock-research-agent:${agent.id}`,
    );
    const context = result.context as unknown as Record<string, unknown> | undefined;
    const quoteAsOf = typeof context?.quoteAsOf === "string" ? context.quoteAsOf : null;
    const marketDateParts = quoteAsOf
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Taipei",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date(quoteAsOf))
      : [];
    const marketDateValues = Object.fromEntries(
      marketDateParts.map(({ type, value }) => [type, value]),
    );
    const marketDate =
      marketDateValues.year && marketDateValues.month && marketDateValues.day
        ? `${marketDateValues.year}-${marketDateValues.month}-${marketDateValues.day}`
        : null;
    if (result.assessmentAiProvider === "rule_based") {
      const cachedAssessment = await getCachedStockAiAssessment(agent.symbol);
      const assistantProvider = result.aiProvider ?? "AI";
      await saveStockResearchAgentReport(agent.id, {
        status: "failed",
        marketDate,
        asOf: result.answeredAt.toISOString(),
        answer: buildStockResearchAgentPartialAnswer(
          cachedAssessment,
          assistantProvider,
          result.answer,
        ),
        assessment: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
        error: `AI 個股判讀階段未完成，使用規則備援；${assistantProvider} 僅補充說明。`,
      });
      logger.warn(
        { agentId: agent.id, symbol: agent.symbol, assistantProvider },
        "Saved partial research after rule-based stock assessment fallback",
      );
      return;
    }
    await saveStockResearchAgentReport(agent.id, {
      status: "completed",
      marketDate,
      asOf: result.answeredAt.toISOString(),
      answer: result.answer,
      assessment: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "研究服務暫時無法使用";
    const cachedAssessment = await getCachedStockAiAssessment(agent.symbol);
    if (cachedAssessment) {
      const quoteAsOf = cachedAssessment.quoteAsOf;
      const marketDateParts = quoteAsOf
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Taipei",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).formatToParts(quoteAsOf)
        : [];
      const marketDateValues = Object.fromEntries(
        marketDateParts.map(({ type, value }) => [type, value]),
      );
      const marketDate =
        marketDateValues.year && marketDateValues.month && marketDateValues.day
          ? `${marketDateValues.year}-${marketDateValues.month}-${marketDateValues.day}`
          : null;
      await saveStockResearchAgentReport(agent.id, {
        status: "failed",
        marketDate,
        asOf: new Date().toISOString(),
        answer: buildStockResearchAgentFallbackAnswer(cachedAssessment),
        assessment: JSON.parse(JSON.stringify(cachedAssessment)) as Record<
          string,
          unknown
        >,
        error: message.slice(0, 400),
      });
      logger.warn(
        { agentId: agent.id, symbol: agent.symbol },
        "Saved available stock assessment with explicit AI assistant failure",
      );
      return;
    }
    await saveStockResearchAgentReport(agent.id, {
      status: "failed",
      marketDate: null,
      asOf: new Date().toISOString(),
      answer: "本次研究未能完成，將於下一個排程時段重試。",
      error: message.slice(0, 400),
    });
    logger.error({ err: error, agentId: agent.id, symbol: agent.symbol }, "Stock research agent run failed");
  }
}

async function run(): Promise<void> {
  logger.info("Market-wide AI scan worker started");
  let lastStaleJobSweepAt = 0;
  while (!stopped) {
    try {
      if (Date.now() - lastStaleJobSweepAt >= 15_000) {
        const requeuedResearchJobs = await requeueStaleResearchJobs();
        if (requeuedResearchJobs) {
          logger.warn(
            { count: requeuedResearchJobs },
            "Requeued stalled CEO research jobs",
          );
        }
        const failedJobs = await failStaleMarketWideAiPickScanJobs();
        if (failedJobs.length) {
          logger.warn(
            { jobIds: failedJobs.map(({ id }) => id) },
            "Marked interrupted market-wide scans failed instead of rescanning symbols",
          );
        }
        lastStaleJobSweepAt = Date.now();
      }
      const researchJob = await claimQueuedResearchJob();
      if (researchJob) {
        try {
          await processQueuedResearchJob(researchJob);
        } catch (error) {
          logger.error({ err: error, jobId: researchJob.id }, "CEO research job failed");
          await updateResearchJob(researchJob.id, {
            status: "failed",
            answer: "研究任務執行中斷，請稍後重新提問。",
          });
        }
        continue;
      }
      const job = await claimMarketWideAiPickScanJob();
      if (job) {
        await processJob(job.id);
        continue;
      }
      const stockAgent = await claimDueStockResearchAgent();
      if (stockAgent) {
        await processStockResearchAgent(stockAgent);
        continue;
      }
      await delay(1500);
    } catch (error) {
      logger.error({ err: error }, "Market-wide AI scan worker cycle failed");
      await delay(3000);
    }
  }
}

process.once("SIGINT", () => { stopped = true; });
process.once("SIGTERM", () => { stopped = true; });
void run().catch((error) => {
  logger.fatal({ err: error }, "Market-wide AI scan worker stopped");
  process.exitCode = 1;
});
