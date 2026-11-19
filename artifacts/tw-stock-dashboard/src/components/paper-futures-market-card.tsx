import { useEffect, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  getFuturesAiDayStrategy,
  getGetFuturesDayIntradayQueryKey,
  useGetFuturesDayIntraday,
  type FuturesAiDayStrategy,
  type FuturesDayIntraday,
} from "@workspace/api-client-react";

type PriceDirection = "up" | "down" | "flat" | "unavailable";

const aiActionLabels: Record<FuturesAiDayStrategy["action"], string> = {
  long: "偏多觀察",
  short: "偏空觀察",
  wait: "等待條件",
  insufficient: "資料不足",
};

function points(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

function taipeiTime(value: string | null | undefined) {
  if (!value) return "未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-TW", {
        timeZone: "Asia/Taipei",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
}

function priceDirection(change: number | null | undefined): PriceDirection {
  if (change == null) return "unavailable";
  if (change > 0) return "up";
  if (change < 0) return "down";
  return "flat";
}

function quoteStatus(data: FuturesDayIntraday | undefined, isError: boolean) {
  if (!data) return isError ? "行情暫不可用" : "讀取期貨行情中";
  if (data.status === "live") return data.symbol === "TXF8" ? "夜盤即時" : "日盤即時";
  if (data.status === "warming_up") return "行情已取得 · K 線暖機";
  if (data.status === "closed") return "休市／收盤";
  return "行情暫不可用";
}

function aiSignalTitle(result: FuturesAiDayStrategy) {
  if (result.entryPlanStatus === "available" && result.entryPlanMode === "current") {
    if (result.action === "long") return "現價可評估做多";
    if (result.action === "short") return "現價可評估做空";
  }
  return aiActionLabels[result.action];
}

export function PaperFuturesMarketCard() {
  const intraday = useGetFuturesDayIntraday({
    query: {
      queryKey: getGetFuturesDayIntradayQueryKey(),
      staleTime: 0,
      refetchInterval: (query) => query.state.data?.status === "closed" ? 30_000 : 5_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  });
  const data = intraday.data;
  const [aiResult, setAiResult] = useState<FuturesAiDayStrategy | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const direction = priceDirection(data?.change);
  const canRequestAi = Boolean(
    data?.status === "live" &&
    data.symbol === "TXF1" &&
    data.k !== null &&
    data.d !== null,
  );

  useEffect(() => {
    setAiResult(null);
    setAiError("");
  }, [data?.symbol, data?.date]);

  const requestAiSignal = async () => {
    if (!canRequestAi || aiLoading) return;
    setAiLoading(true);
    setAiError("");
    try {
      setAiResult(await getFuturesAiDayStrategy());
    } catch {
      setAiError("AI 判斷暫時無法取得，行情仍會持續更新；請稍後再試。");
    } finally {
      setAiLoading(false);
    }
  };

  const quoteLabel = data?.status === "closed" ? "最近收盤報價" : "臺指期最新報價";
  const changeLabel = direction === "up"
    ? "上漲"
    : direction === "down"
      ? "下跌"
      : direction === "flat"
        ? "平盤"
        : "漲跌未提供";
  const quoteValueTime = data?.asOf ? `資料時間 ${taipeiTime(data.asOf)}` : "尚無報價時間";
  const hasAiPlan = aiResult?.entryPlanStatus === "available" &&
    aiResult.entryPrice !== null &&
    aiResult.stopLossPrice !== null &&
    aiResult.targetPrice !== null;

  return (
    <section className="pa-panel pa-futures-market" aria-labelledby="pa-futures-market-title" data-testid="panel-paper-futures-market">
      <header className="pa-panel-head pa-futures-market-head">
        <div className="pa-panel-icon is-teal"><Activity size={16} aria-hidden="true" /></div>
        <div><span className="pa-overline">FUTURES LIVE QUOTE</span><h2 id="pa-futures-market-title">臺指期即時報價與漲跌訊號</h2></div>
        <span className={`pa-market-status is-${data?.status ?? (intraday.isError ? "unavailable" : "loading")}`} role="status" data-testid="status-paper-futures-quote">
          <i aria-hidden="true" />{quoteStatus(data, intraday.isError)}
        </span>
        <button
          type="button"
          className="pa-market-refresh"
          onClick={() => void intraday.refetch()}
          disabled={intraday.isFetching}
          aria-label="重新讀取臺指期行情"
          data-testid="button-refresh-paper-futures-quote"
        >
          <RefreshCw size={14} className={intraday.isFetching ? "pa-spin" : ""} />更新
        </button>
      </header>

      <div className="pa-futures-market-grid">
        <section className="pa-market-quote" aria-label="期貨最新報價與漲跌">
          <div className="pa-market-quote-heading">
            <div><span>{quoteLabel} · {data?.symbol ?? "TX 連續行情"}</span><small>{quoteValueTime}</small></div>
            <span className={`pa-market-direction is-${direction}`} data-testid="status-paper-futures-direction">
              {direction === "up"
                ? <ArrowUpRight size={17} aria-hidden="true" />
                : direction === "down"
                  ? <ArrowDownRight size={17} aria-hidden="true" />
                  : direction === "flat"
                    ? <Minus size={17} aria-hidden="true" />
                    : <Activity size={16} aria-hidden="true" />}
              {changeLabel}
            </span>
          </div>
          <strong className="pa-market-last-price" data-testid="value-paper-futures-price">
            {points(data?.price)}<small>點</small>
          </strong>
          <div className="pa-market-changes">
            <div><span>漲跌點數</span><strong className={`is-${direction}`}>
              {data?.change == null ? "—" : `${data.change > 0 ? "+" : ""}${points(data.change)} 點`}
            </strong></div>
            <div><span>漲跌幅</span><strong className={`is-${direction}`}>
              {data?.changePercent == null ? "—" : `${data.changePercent > 0 ? "+" : ""}${data.changePercent.toFixed(2)}%`}
            </strong></div>
          </div>
          {intraday.isError && (
            <p className="pa-market-error" role="alert" data-testid="status-paper-futures-quote-error">
              行情更新失敗{data?.price != null ? "，保留最近一次報價" : "，目前沒有可用報價"}。
            </p>
          )}
          <p className="pa-market-source">{data?.source ?? "尚未取得資料來源"}</p>
          <p className="pa-market-note">漲跌方向依來源參考價計算，只反映報價變化，不等同 AI 多空建議。</p>
        </section>

        <section className="pa-market-ai" aria-label="期貨 AI 多空判斷">
          <div className="pa-market-ai-heading">
            <div><span className="pa-overline">ON-DEMAND AI</span><strong>AI 多空判斷</strong></div>
            <button
              type="button"
              className="pa-button pa-button-secondary"
              onClick={() => void requestAiSignal()}
              disabled={!canRequestAi || aiLoading}
              data-testid="button-paper-futures-ai-signal"
            >
              <Sparkles size={14} aria-hidden="true" />{aiLoading ? "分析中…" : aiResult ? "重新分析" : "取得 AI 判斷"}
            </button>
          </div>
          <p className="pa-market-ai-note">僅在按下按鈕後呼叫 AI；結果是當下的研究判斷，不會自動進場。</p>
          {!canRequestAi && (
            <p className="pa-market-ai-disabled" data-testid="status-paper-futures-ai-disabled">
              {data?.symbol === "TXF8"
                ? "夜盤可查看報價；AI 判斷目前僅支援日盤。"
                : "取得 AI 判斷需有有效的日盤即時行情與指標資料。"}
            </p>
          )}
          {aiLoading && <p className="pa-market-ai-state" role="status" data-testid="status-paper-futures-ai-loading">正在依最新日盤資料分析方向…</p>}
          {aiError && <p className="pa-market-error" role="alert" data-testid="status-paper-futures-ai-error">{aiError}</p>}
          {aiResult && !aiLoading && (
            <div className="pa-market-ai-result" data-testid="result-paper-futures-ai-signal">
              <div className={`pa-market-ai-action is-${aiResult.action}`}>
                <strong>{aiSignalTitle(aiResult)}</strong>
                <small>{aiResult.aiProvider ?? "AI 來源未提供"} · 分析 {taipeiTime(aiResult.analyzedAt)}</small>
              </div>
              <p>{aiResult.summary}</p>
              <p className="pa-market-ai-plan">{aiResult.entryPlanMessage}</p>
              {hasAiPlan && (
                <div className="pa-market-ai-levels">
                  <span>參考進場<strong>{points(aiResult.entryPrice)} 點</strong></span>
                  <span>停損<strong>{points(aiResult.stopLossPrice)} 點</strong></span>
                  <span>目標<strong>{points(aiResult.targetPrice)} 點</strong></span>
                </div>
              )}
              <small className="pa-market-ai-anchor">
                判斷依據 {aiResult.dayQuote.price == null ? "無有效期貨價" : `${points(aiResult.dayQuote.price)} 點`}
                {aiResult.dayQuote.asOf ? ` · 報價 ${taipeiTime(aiResult.dayQuote.asOf)}` : ""}
              </small>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
