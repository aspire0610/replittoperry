import { useCallback, useEffect, useRef, useState } from "react";

type Progress = {
  symbol: string;
  status: "collecting" | "qualified" | "not_qualified" | "insufficient_history";
  processedForecastCount: number;
  requiredForecastCount: number;
  directionSampleCount: number;
  directionCorrectCount: number;
  programBaselineSampleCount: number;
  programBaselineCorrectCount: number;
  programBaselineHitRatePercent: number | null;
  calibrationSampleCount: number;
  meanForecastProbabilityPercent: number | null;
  calibrationGapPercent: number | null;
  directionLowerBoundPercent: number | null;
  pricePlanSampleCount: number;
  pricePlanTargetFirstCount: number;
  pricePlanLowerBoundPercent: number | null;
  qualified: boolean;
  message: string;
};

type StreamEvent =
  | { type: "status" | "heartbeat"; message: string }
  | {
      type: "progress";
      phase?: "forecast_started" | "forecast_completed";
      forecastDate?: string;
      forecastIndex?: number;
      requiredForecastCount?: number;
      progress: Progress;
    }
  | { type: "done"; progress: Progress }
  | { type: "error"; message: string };

function hitRate(successes: number, sampleCount: number) {
  return sampleCount > 0
    ? `${((successes / sampleCount) * 100).toFixed(1)}%`
    : "尚無可判定樣本";
}

async function streamBatch(
  symbol: string,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<Progress> {
  const response = await fetch("/api/stocks/ai-historical-validation", {
    method: "POST",
    credentials: "include",
    signal,
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ symbol }),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message =
      payload && typeof payload === "object" && "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `回測服務回應錯誤（${response.status}）。`;
    throw new Error(message);
  }
  if (!response.body) throw new Error("瀏覽器無法讀取回測進度，請稍後重試。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: Progress | null = null;
  const handleFrame = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      throw new Error("回測進度格式錯誤，請重新執行。");
    }
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") result = event.progress;
    onEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) handleFrame(frame);
      if (done) {
        if (buffer.trim()) handleFrame(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error("回測連線中斷；已完成的樣本已保存，可稍後續跑。");
  return result;
}

export function StockAiHistoricalValidation({ symbol }: { symbol: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    setHasStarted(true);
    setRunning(true);
    setError(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      let next: Progress | null = null;
      while (
        !controller.signal.aborted &&
        next?.status !== "qualified" &&
        next?.status !== "not_qualified" &&
        next?.status !== "insufficient_history"
      ) {
        next = await streamBatch(symbol, controller.signal, (event) => {
          if (event.type === "status" || event.type === "heartbeat") {
            setActivity(event.message);
          } else if (event.type === "progress") {
            setProgress(event.progress);
            if (event.phase === "forecast_started" && event.forecastDate) {
              setActivity(
                `正在分析近期歷史區間 ${event.forecastIndex ?? "—"}/${event.requiredForecastCount ?? "—"}`,
              );
            } else if (event.phase === "forecast_completed") {
              setActivity("已完成一個歷史區間的 AI 判讀與驗證");
            }
          } else if (event.type === "done") {
            setProgress(event.progress);
          }
        });
        setProgress(next);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "歷史回測暫時無法執行。");
      }
    } finally {
      controllerRef.current = null;
      setRunning(false);
    }
  }, [symbol]);

  useEffect(() => {
    setProgress(null);
    setError(null);
    setActivity(null);
    return () => {
      controllerRef.current?.abort();
    };
  }, [symbol]);

  return (
    <section className="historical-backtest forward-direction-validation" data-testid="panel-ai-historical-validation">
      <div className="historical-backtest-heading">
        <div>
          <strong>近期 AI 歷史回測</strong>
          <small>最近 20 個不重疊區間；每期只用當時以前的 40 個交易日</small>
        </div>
        {running ? (
          <span role="status" aria-live="polite">AI 回測中</span>
        ) : (
          <button
            type="button"
            onClick={() => void run()}
            data-testid="button-run-historical-backtest"
          >
            {hasStarted ? "重新回測" : "開始近期 AI 歷史回測"}
          </button>
        )}
      </div>
      {running && progress ? (
        <>
          <progress
            max={Math.max(1, progress.requiredForecastCount)}
            value={progress.processedForecastCount}
            aria-label="近期 AI 歷史回測進度"
            style={{ width: "100%", accentColor: "#28a7a0" }}
          />
          <small aria-live="polite">
            {activity ?? `已完成 ${progress.processedForecastCount}/${progress.requiredForecastCount} 期`}
          </small>
        </>
      ) : progress ? (
        <>
          <div className="historical-backtest-results">
            <div>
              <small>固定程式：20 日動能命中率</small>
              <strong data-testid="text-program-baseline-hit-rate">
                {progress.programBaselineHitRatePercent === null
                  ? "尚無樣本"
                  : `${progress.programBaselineHitRatePercent.toFixed(1)}%`}
              </strong>
              <span>
                {progress.programBaselineCorrectCount}/{progress.programBaselineSampleCount} 期 · 與 AI 同區間，計算不使用 AI
              </span>
            </div>
            <div>
              <small>5 日實測方向命中率</small>
              <strong data-testid="text-historical-direction-hit-rate">
                {hitRate(progress.directionCorrectCount, progress.directionSampleCount)}
              </strong>
              <span>{progress.directionCorrectCount}/{progress.directionSampleCount} 期</span>
            </div>
            <div>
              <small>盲測平均預測機率</small>
              <strong>{progress.meanForecastProbabilityPercent === null
                ? "樣本不足"
                : `${progress.meanForecastProbabilityPercent.toFixed(1)}%`}</strong>
              <span>實測差 {progress.calibrationGapPercent === null
                ? "—"
                : `${progress.calibrationGapPercent > 0 ? "+" : ""}${progress.calibrationGapPercent.toFixed(1)} 個百分點`}</span>
              <span>{progress.calibrationSampleCount} 個盲測樣本</span>
            </div>
            <div>
              <small>價位方案目標先到</small>
              <strong data-testid="text-historical-price-plan-hit-rate">
                {hitRate(progress.pricePlanTargetFirstCount, progress.pricePlanSampleCount)}
              </strong>
              <span>{progress.pricePlanTargetFirstCount}/{progress.pricePlanSampleCount} 期</span>
            </div>
          </div>
          <p className="historical-backtest-result" data-testid="text-historical-backtest-summary">
            固定程式以當時收盤價相對 20 個交易日前的方向作判斷；AI 歷史盲測與程式基準分開統計。已處理 {progress.processedForecastCount}/{progress.requiredForecastCount} 個 AI 歷史區間。歷史命中不代表未來獲利保證。
          </p>
        </>
      ) : (
        <p className="historical-backtest-result" role="status" data-testid="status-historical-backtest-loading">
          回測尚未執行。需要時再開始；此回測會連續使用 AI 分析歷史區間，避免與即時個股問答同時佔用服務。
        </p>
      )}
      {error && (
        <div role="alert" className="historical-backtest-result">
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
