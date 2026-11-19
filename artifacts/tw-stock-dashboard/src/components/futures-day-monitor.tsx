import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import {
  getGetMarketOverviewQueryKey,
  getFuturesAiDayStrategy,
  getGetFuturesDayIntradayQueryKey,
  useGetMarketOverview,
  useGetFuturesDayIntraday,
  type FuturesAiDayStrategy,
  type FuturesDayIntraday,
  type MarketQuote,
} from "@workspace/api-client-react";
import {
  calculateFuturesPhoneLine,
  type FuturesPhoneInputBar,
  type FuturesPhoneLinePoint,
  type FuturesPhoneTimeframe,
  type FuturesPhoneTrend,
} from "../lib/futures-phone-line";
import { calculateFuturesLiveSignal } from "../lib/futures-live-signal";
import { FuturesEntryPoints } from "./futures-entry-points";

const signalLabels: Record<FuturesDayIntraday["signal"], string> = {
  bullish_cross: "KD 黃金交叉",
  bearish_cross: "KD 死亡交叉",
  no_cross: "尚無交叉",
  insufficient: "訊號資料不足",
};

const actionLabels: Record<FuturesAiDayStrategy["action"], string> = {
  long: "現價可評估做多",
  short: "現價可評估做空",
  wait: "等待條件",
  insufficient: "資料不足",
};

function dateText(value: string) {
  if (/^\d{8}$/u.test(value)) return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value || "未提供"
    : parsed.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
}

function taipeiTime(value: string | null) {
  if (!value) return "未提供";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
}

function barTime(value: string) {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime()) && /T|Z/u.test(value)) {
    return parsed.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return value.length > 5 ? value.slice(-8, -3) : value;
}

function quoteNumber(value: number | null, digits = 2) {
  return value == null ? "—" : value.toLocaleString("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

type FuturesPriceDirection = "up" | "down" | "flat" | "unavailable";

function futuresPriceDirection(change: number | null | undefined): FuturesPriceDirection {
  if (change == null) return "unavailable";
  if (change > 0) return "up";
  if (change < 0) return "down";
  return "flat";
}

const futuresPriceDirectionLabels: Record<FuturesPriceDirection, string> = {
  up: "上漲",
  down: "下跌",
  flat: "持平",
  unavailable: "尚無訊號",
};

function FuturesCandles({
  bars,
  linePoints,
}: {
  bars: FuturesPhoneInputBar[];
  linePoints: FuturesPhoneLinePoint[];
}) {
  if (!bars.length) {
    return <div className="futures-chart-empty" data-testid="status-futures-chart-empty">目前沒有可用的本盤別分鐘 K 棒。</div>;
  }
  const lineValues = linePoints.flatMap((point) => point.value === null ? [] : [point.value]);
  const min = Math.min(...bars.map((bar) => bar.low), ...lineValues);
  const max = Math.max(...bars.map((bar) => bar.high), ...lineValues);
  const span = max - min || Math.max(max * 0.001, 1);
  const x = (index: number) => 18 + index / Math.max(bars.length - 1, 1) * 684;
  const y = (price: number) => 190 - ((price - min) / span) * 160;
  const candleWidth = Math.max(2.5, Math.min(9, 600 / bars.length));
  const segments: Array<{ trend: Exclude<FuturesPhoneTrend, "neutral">; points: string[] }> = [];
  let activeTrend: Exclude<FuturesPhoneTrend, "neutral"> | null = null;
  let activePoints: string[] = [];
  const flushSegment = () => {
    if (activeTrend && activePoints.length > 1) {
      segments.push({ trend: activeTrend, points: activePoints });
    }
    activeTrend = null;
    activePoints = [];
  };
  linePoints.forEach((point, index) => {
    if (point.value === null || point.trend === "neutral") {
      flushSegment();
      return;
    }
    if (activeTrend !== point.trend) flushSegment();
    activeTrend = point.trend;
    activePoints.push(`${x(index)},${y(point.value)}`);
  });
  flushSegment();
  return (
    <svg className="futures-candle-chart" viewBox="0 0 720 220" role="img" aria-label="臺指期目前盤別 OHLC K 棒與多空電話線近似版" data-testid="chart-futures-intraday">
      {[30, 80, 130, 190].map((gridY) => <line key={gridY} x1="10" x2="710" y1={gridY} y2={gridY} className="futures-chart-grid" />)}
      {bars.map((bar, index) => {
        const center = x(index);
        const openY = y(bar.open);
        const closeY = y(bar.close);
        const rising = bar.close >= bar.open;
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(Math.abs(closeY - openY), 1.4);
        return (
          <g key={`${bar.time}-${index}`} className={rising ? "futures-candle rising" : "futures-candle falling"}>
            <line x1={center} x2={center} y1={y(bar.high)} y2={y(bar.low)} />
            <rect x={center - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} rx="1" />
          </g>
        );
      })}
      {segments.map((segment, index) => (
        <polyline
          key={`${segment.trend}-${index}`}
          points={segment.points.join(" ")}
          className={`futures-phone-line futures-phone-line-${segment.trend}`}
          data-testid={`line-futures-phone-${segment.trend}-${index}`}
        />
      ))}
      <text x="12" y="212" className="futures-chart-axis">{barTime(bars[0].time)}</text>
      <text x="708" y="212" textAnchor="end" className="futures-chart-axis">{barTime(bars[bars.length - 1].time)}</text>
    </svg>
  );
}

function StrategyResult({ result }: { result: FuturesAiDayStrategy }) {
  const hasEntryPlan = result.entryPlanStatus === "available";
  const isCurrentPlan = result.entryPlanMode === "current";
  const directionLabel = result.planDirection === "long"
    ? "做多"
    : result.planDirection === "short"
      ? "做空"
      : "方向待確認";
  return (
    <section className="futures-ai-result" aria-label="臺指期 AI 判讀結果" data-testid="result-futures-ai">
      <div className="futures-ai-result-head">
        <span className={`futures-ai-action${isCurrentPlan ? " is-actionable" : " is-waiting"}`}>{actionLabels[result.action]}</span>
        <small>{result.aiProvider ? `分析來源 ${result.aiProvider}` : "分析來源未提供"} · {taipeiTime(result.analyzedAt)}</small>
      </div>
      <p className="futures-ai-summary">{result.summary}</p>
      <section
        className={`futures-ai-entry-plan${hasEntryPlan ? " is-available" : " is-unavailable"}${hasEntryPlan && !isCurrentPlan ? " is-conditional" : ""}`}
        aria-label={hasEntryPlan ? isCurrentPlan ? "單一現價方案" : "單一條件式方案" : "單一方案判讀"}
        data-testid="result-futures-ai-entry-plan"
      >
        <div className="futures-ai-entry-plan-heading">
          <div>
            <strong>{hasEntryPlan ? isCurrentPlan ? "單一現價方案" : "單一條件式方案" : "單一方案判讀"}</strong>
            <small>{hasEntryPlan ? `AI 主觀單一方向 · ${directionLabel} · 僅供日盤參考` : "AI 主觀判斷 · 僅供日盤參考"}</small>
          </div>
          <span>
            {hasEntryPlan
              ? isCurrentPlan
                ? "可評估現價進場"
                : `等待${directionLabel}條件`
              : result.status === "waiting_for_day_session" || !result.dayQuote.available
                ? "等待有效即時行情"
                : "方案驗證未通過"}
          </span>
        </div>
        <p>{result.entryPlanMessage}</p>
        {hasEntryPlan && (
          <>
            <div className="futures-ai-price-levels">
              <div className="is-entry">
                <small>{isCurrentPlan ? "現價進場" : "條件式進場"}</small>
                <strong>{quoteNumber(result.entryPrice, 0)} 點</strong>
                <span>{result.entryReason}</span>
              </div>
              <div>
                <small>停損</small>
                <strong>{quoteNumber(result.stopLossPrice, 0)} 點</strong>
                <span>{result.stopLossReason}</span>
              </div>
              <div>
                <small>停利目標（150 點參考門檻）</small>
                <strong>{quoteNumber(result.targetPrice, 0)} 點</strong>
                <span>{result.targetReason}</span>
              </div>
            </div>
            <small className="futures-ai-quote-source">
              現價來源：{result.dayQuote.source ?? "未提供"} · 報價時間 {taipeiTime(result.dayQuote.asOf)}
            </small>
          </>
        )}
      </section>
      <div className="futures-ai-conditions">
        <div><small>觀察條件</small><p>{result.entryCondition}</p></div>
        <div><small>失效條件</small><p>{result.invalidationCondition}</p></div>
        <div><small>風險註記</small><p>{result.riskNote}</p></div>
      </div>
      <p className="futures-ai-disclaimer">{result.disclaimer}</p>
    </section>
  );
}

function LiveFuturesSignal({
  result,
}: {
  result: ReturnType<typeof calculateFuturesLiveSignal>;
}) {
  const labels = {
    long: "5分趨勢偏多 · 條件成立",
    short: "5分趨勢偏空 · 條件成立",
    wait: "等待5分趨勢進場",
    unavailable: "資料不足 · 暫停判斷",
  } as const;
  const candidate = result.candidate;
  const isActionable = result.action === "long" || result.action === "short";
  const signalState = candidate?.direction ?? result.action;
  const actionLabel = candidate
    ? candidate.direction === "long"
      ? "5分偏多候選 · 等EMA5站回"
      : "5分偏空候選 · 等EMA5跌回"
    : labels[result.action];
  return (
    <section
      className={`futures-live-signal glass-panel is-${result.action}${candidate ? ` is-candidate-${candidate.direction}` : ""}`}
      aria-label="臺指期即時進場判斷"
      data-testid="panel-futures-live-signal"
    >
      <div className="futures-live-signal-head">
        <div>
          <p className="fep-eyebrow">LIVE ENTRY / AUTO-UPDATED</p>
          <h3>即時進場判斷</h3>
        </div>
        <strong className={`futures-live-signal-badge is-${signalState}`} data-testid="status-futures-live-action">
          <span className={`futures-signal-light is-${signalState}`} aria-hidden="true" />
          <span>{actionLabel}</span>
        </strong>
      </div>
      <p className="futures-live-signal-reason" data-testid="text-futures-live-reason">{result.reason}</p>
      <div className="futures-live-signal-levels">
        <div>
          <small>{candidate ? "EMA5 條件進場價" : isActionable ? "現價進場參考" : "最新取得期貨價"}</small>
          <strong>
            {candidate
              ? `${quoteNumber(candidate.triggerPrice, 0)} 點`
              : result.currentPrice == null
                ? "—"
                : `${quoteNumber(result.currentPrice, 0)} 點`}
          </strong>
          <span>
            {candidate
              ? `目前 ${quoteNumber(result.currentPrice, 0)} 點 · 報價 ${taipeiTime(result.futuresAsOf)}`
              : result.futuresAsOf ? `報價 ${taipeiTime(result.futuresAsOf)}` : "等待有效報價"}
          </span>
        </div>
        <div>
          <small>{candidate ? "候選失效價" : "停損參考"}</small>
          <strong>
            {candidate
              ? `${quoteNumber(candidate.invalidationPrice, 0)} 點`
              : isActionable && result.stopPrice != null ? `${quoteNumber(result.stopPrice, 0)} 點` : "—"}
          </strong>
          <span>
            {candidate
              ? candidate.invalidationCondition
              : isActionable ? "觸價位反向失效參考" : "尚無合格現價訊號"}
          </span>
        </div>
        <div>
          <small>停利目標參考</small>
          <strong>
            {candidate
              ? `${quoteNumber(candidate.targetPrice, 0)} 點`
              : isActionable && result.targetPrice != null ? `${quoteNumber(result.targetPrice, 0)} 點` : "—"}
          </strong>
          <span>
            {candidate
              ? `候選參考 · 至少 150 點且 ${candidate.rewardRisk.toFixed(1)}R`
              : isActionable && result.rewardRisk != null ? `至少 150 點且 ${result.rewardRisk.toFixed(1)}R` : "尚無合格現價訊號"}
          </span>
        </div>
      </div>
      <p className="futures-live-signal-source">
        期貨：{result.futuresSource} ·{" "}
        {result.confirmationMode === "five_min_trend"
          ? `方向依最近 13 根完整 5 分 K 的 EMA5／EMA13；漲跌幅與加權指數不決定多空 · 加權指數：${result.taiexSource ?? "未提供"} · 報價 ${result.taiexAsOf ? taipeiTime(result.taiexAsOf) : "未提供"}`
          : "目前沒有可用的 5 分 K 趨勢規則"}
      </p>
      <p className="futures-live-signal-disclaimer">
        方向以至少 13 根完整 Yuanta SPARK 5 分 K 的 EMA5／EMA13 判斷；趨勢偏多時等現價站回 EMA5 附近，偏空時等現價跌回 EMA5 附近，並列出條件進場、停損與停利參考。停損風險仍受 SPARK 1 分 ATR14 上限約束；報價、連續 K 線或風險檢查不合格時會暫停出點。
        行情輪詢設定為 5 秒，實際更新仍受來源與連線延遲影響。停利點不保證成交或獲利；本功能不會下單。
      </p>
    </section>
  );
}

export function FuturesDayMonitor() {
  const intraday = useGetFuturesDayIntraday({
    query: {
      queryKey: getGetFuturesDayIntradayQueryKey(),
      staleTime: 0,
      refetchInterval: 5000,
      refetchOnWindowFocus: false,
    },
  });
  const overview = useGetMarketOverview({
    query: {
      queryKey: getGetMarketOverviewQueryKey(),
      staleTime: 0,
      refetchInterval: 5000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  });
  const [phoneTimeframe, setPhoneTimeframe] = useState<FuturesPhoneTimeframe>(5);
  const [phoneLookback, setPhoneLookback] = useState(3);
  const [signalClock, setSignalClock] = useState(() => Date.now());
  const [aiResult, setAiResult] = useState<FuturesAiDayStrategy | null>(null);
  const [aiError, setAiError] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const data = intraday.data;
  const taiexQuote: MarketQuote | undefined = overview.data?.indices.find(quote => quote.key === "taiex");
  const isNight = data?.symbol === "TXF8";
  const sessionLabel = isNight ? "夜盤" : "日盤";
  useEffect(() => {
    setAiResult(null);
    setAiError("");
  }, [data?.symbol, data?.date]);
  useEffect(() => {
    const timer = window.setInterval(() => setSignalClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const liveSignal = useMemo(
    () => calculateFuturesLiveSignal(data, taiexQuote, signalClock),
    [data, taiexQuote, signalClock],
  );
  const phoneLine = useMemo(
    () => calculateFuturesPhoneLine(data?.bars ?? [], phoneTimeframe, phoneLookback),
    [data?.bars, phoneTimeframe, phoneLookback],
  );
  const hasSparkBars = data?.source.includes("分 K：Yuanta SPARK") ?? false;
  const hasTaifexObservedBars = data?.source.includes("TAIFEX MIS") ?? false;
  const priceDirection = futuresPriceDirection(data?.change);
  const priceReferenceDescription = data?.change == null
    ? "尚未取得來源參考價"
    : data.change > 0
      ? `高於來源參考價 ${quoteNumber(data.change, 0)} 點`
      : data.change < 0
        ? `低於來源參考價 ${quoteNumber(Math.abs(data.change), 0)} 點`
        : "與來源參考價持平";
  const pricePercentDescription = data?.changePercent == null
    ? ""
    : ` · ${data.changePercent > 0 ? "+" : ""}${data.changePercent.toFixed(2)}%`;
  const canRequestAi = !isNight && data?.status === "live" && data.k !== null && data.k !== undefined && data.d !== null && data.d !== undefined;
  const statusLabel = data?.status === "live"
    ? `${sessionLabel}即時觀測`
    : data?.status === "warming_up"
      ? "暖機中"
      : data?.status === "closed"
        ? `${sessionLabel}休市／待開盤`
        : "行情暫不可用";
  const phoneLineState = phoneLine.linePrice === null
    ? {
      direction: "neutral" as const,
      title: "資料暖機中",
      detail: `需要至少 ${phoneLookback * 2} 根 ${phoneTimeframe} 分 K，才會顯示近似電話線。`,
    }
    : phoneLine.trend === "bullish"
      ? phoneLine.broken
        ? { direction: "bullish" as const, title: "跌破紫線 · 觀望／停利提醒", detail: "收盤價低於上升線；僅作為風險提醒，不是自動出場指令。" }
        : { direction: "bullish" as const, title: "紫線偏多 · 持多觀察", detail: "短期低點抬高且價格仍守在線上；紫線作為近似移動停利參考。" }
      : phoneLine.broken
        ? { direction: "bearish" as const, title: "突破綠線 · 觀望／停利提醒", detail: "收盤價高於下降線；僅作為風險提醒，不是自動出場指令。" }
        : { direction: "bearish" as const, title: "綠線偏空 · 空方觀察", detail: "短期高點降低且價格仍在線下；綠線作為近似移動停利參考。" };
  const requestJudgment = async () => {
    if (!canRequestAi) return;
    setAiLoading(true);
    setAiError("");
    try {
      const result = await getFuturesAiDayStrategy();
      setAiResult(result);
    } catch {
      setAiError("AI 判讀目前無法取得，盤中觀測資料仍可查看。請稍後重試。");
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <section className="futures-day-panel glass-panel" aria-labelledby="futures-day-heading" data-testid="panel-futures-day">
      <header className="futures-day-heading">
        <div>
          <p className="aipick-eyebrow"><Activity size={13} /> INDEX FUTURES / OBSERVED SESSION DATA</p>
          <h2 id="futures-day-heading">臺指期{sessionLabel} <span>即時觀測</span></h2>
          <p>日盤 TXF1，收盤後自動切換夜盤 TXF8；只呈現來源實際提供的本盤別成交分 K，不是完整歷史序列。</p>
        </div>
        <div className="futures-day-actions">
          <span className={`futures-status futures-status-${data?.status ?? (intraday.isError ? "unavailable" : "warming_up")}`} role="status" data-testid="status-futures-session">{intraday.isLoading ? "讀取中" : statusLabel}</span>
          <button type="button" className="futures-refresh" onClick={() => void intraday.refetch()} disabled={intraday.isFetching} aria-label={`重新讀取臺指期${sessionLabel}資料`} data-testid="button-refresh-futures">
            <RefreshCw size={14} className={intraday.isFetching ? "is-spinning" : ""} /> 更新
          </button>
        </div>
      </header>

      {intraday.isLoading && (
        <div className="futures-loading" role="status" data-testid="status-futures-loading">
          <span /><span /><span /><span />
          <p>正在讀取期貨來源與分鐘觀測資料…</p>
        </div>
      )}
      {intraday.isError && (
        <div className="futures-error" role="alert" data-testid="status-futures-error">
          <AlertTriangle size={17} />
          <div><strong>期貨資料暫不可用</strong><p>目前無法連線至觀測資料。未以估算或歷史資料替代。</p></div>
          <button type="button" onClick={() => void intraday.refetch()} disabled={intraday.isFetching} data-testid="button-retry-futures">重試</button>
        </div>
      )}
      {data && (
        <>
          <div className="futures-provenance" data-testid="text-futures-provenance">
            <span><small>盤別起始日</small><strong>{dateText(data.date)}</strong></span>
            <span><small>商品</small><strong>{data.symbol ?? "未提供"}</strong></span>
            <span><small>來源</small><strong>{data.source || "未提供"}</strong></span>
            <span><small>資料截至</small><strong>{taipeiTime(data.asOf)}</strong></span>
          </div>

          {data.status === "warming_up" && <p className="futures-notice" data-testid="status-futures-warming">{sessionLabel} K 線資料暖機中。至少 9 根一分 K 才能計算 K、D；交叉判斷至少需要 11 根。</p>}
          {data.status === "closed" && <p className="futures-notice" data-testid="status-futures-closed">{sessionLabel}休市或尚未開盤。日盤 08:45–13:45、夜盤 15:00–翌日 05:00（台北時間，交易日適用）；不混用不同盤別或舊場次資料。</p>}
          {data.status === "unavailable" && <p className="futures-notice is-error" data-testid="status-futures-unavailable">資料來源未提供可用{sessionLabel}觀測，圖表與 AI 判讀暫停。</p>}

          <div className="futures-data-layout">
            <div className="futures-chart-wrap">
              <div className="futures-chart-title">
                <strong>{sessionLabel} {phoneTimeframe} 分鐘 OHLC</strong>
                <span>{phoneLine.bars.length} 根 K</span>
              </div>
              <div className="futures-phone-controls" aria-label="電話線近似版設定">
                <label>
                  <span>週期</span>
                  <select
                    value={phoneTimeframe}
                    onChange={(event) => setPhoneTimeframe(Number(event.target.value) as FuturesPhoneTimeframe)}
                    data-testid="select-futures-phone-timeframe"
                  >
                    <option value={1}>1 分</option>
                    <option value={5}>5 分</option>
                    <option value={15}>15 分</option>
                  </select>
                </label>
                <label>
                  <span>回看根數</span>
                  <select
                    value={phoneLookback}
                    onChange={(event) => setPhoneLookback(Number(event.target.value))}
                    data-testid="select-futures-phone-lookback"
                  >
                    {[2, 3, 5, 8, 10].map((count) => <option key={count} value={count}>{count} 根</option>)}
                  </select>
                </label>
              </div>
              <div className={`futures-last-quote${data.change == null ? "" : data.change >= 0 ? " is-up" : " is-down"}`} data-testid="text-futures-last-quote">
                <strong>{quoteNumber(data.price, 0)}</strong>
                <span>{data.change == null ? "漲跌 —" : `${data.change > 0 ? "+" : ""}${quoteNumber(data.change, 0)} 點`}</span>
                <span>{data.changePercent == null ? "—" : `${data.changePercent > 0 ? "+" : ""}${data.changePercent.toFixed(2)}%`}</span>
              </div>
              <FuturesCandles bars={phoneLine.bars} linePoints={phoneLine.points} />
              <div className="futures-phone-legend" aria-label="電話線顏色說明">
                <span><i className="is-bullish" />紫線：上升低點</span>
                <span><i className="is-bearish" />綠線：下降高點</span>
              </div>
              <p className="futures-chart-caveat">
                {hasSparkBars
                  ? `分鐘 K 與 KD 使用 Yuanta SPARK ${data.symbol} ${sessionLabel}一分 K；最新報價來源另列於上方。`
                  : hasTaifexObservedBars
                    ? "TAIFEX 分鐘 K 僅涵蓋伺服器連線後觀測到的成交，缺少前段不代表無成交。"
                    : "目前沒有可用的一分 K，KD 會在資料到達後顯示，不以估算值補齊。"}
              </p>
            </div>
            <aside className="futures-signal-box" aria-label="期貨漲跌與 KD 訊號">
              <div className={`futures-phone-state is-${phoneLineState.direction}`} data-testid="status-futures-phone-line">
                <small>多空電話線近似版</small>
                <strong>{phoneLineState.title}</strong>
                <span>{phoneLine.linePrice === null ? "線位 —" : `線位 ${quoteNumber(phoneLine.linePrice, 0)}`}</span>
                <p>{phoneLineState.detail}</p>
              </div>
              <div className={`futures-price-signal is-${priceDirection}`} data-testid="status-futures-price-signal">
                <small>期貨漲跌訊號</small>
                <strong>{futuresPriceDirectionLabels[priceDirection]}</strong>
                <span>{priceReferenceDescription}{pricePercentDescription}</span>
              </div>
              <div className="futures-kd-values">
                <div><small>K 值</small><strong data-testid="value-futures-k">{data.k == null ? "—" : data.k.toFixed(2)}</strong></div>
                <div><small>D 值</small><strong data-testid="value-futures-d">{data.d == null ? "—" : data.d.toFixed(2)}</strong></div>
              </div>
              <div className={`futures-signal signal-${data.signal}`} data-testid="status-futures-signal">
                <small>KD 訊號</small><strong>{signalLabels[data.signal]}</strong>
              </div>
              <p>近似線以連續兩個回看區間比較低點／高點；不是 WINSMART 原版指標。漲跌與 KD 僅供觀察，不構成買賣指令。</p>
            </aside>
          </div>
        </>
      )}

      <LiveFuturesSignal result={liveSignal} />
      {!intraday.isLoading && <FuturesEntryPoints data={data} requestFailed={intraday.isError} />}

      <div className="futures-ai-control">
        <div><strong>臺指期 AI 補充判讀</strong><small>即時方向已由上方規則卡重算；此 AI 補充分析僅在你點擊後請求。</small></div>
        <button type="button" onClick={() => void requestJudgment()} disabled={!canRequestAi || aiLoading} data-testid="button-futures-ai-judgment">
          <Sparkles size={14} />{aiLoading ? "判讀中…" : aiResult ? "重新取得補充" : "取得 AI 補充"}
        </button>
      </div>
      {!canRequestAi && data && !intraday.isError && <p className="futures-ai-disabled-note" data-testid="status-futures-ai-disabled">{isNight ? "夜盤報價、K 線與 KD 可查看；目前 AI 策略僅支援日盤，夜盤不沿用日盤判讀。" : "需有即時日盤資料與有效 K、D 值，才可請求 AI 判讀。"}</p>}
      {aiLoading && <p className="futures-ai-state" role="status" data-testid="status-futures-ai-loading">正在依目前期貨資料產生判讀…</p>}
      {aiError && <div className="futures-ai-error" role="alert" data-testid="status-futures-ai-error"><span>{aiError}</span><button type="button" onClick={() => void requestJudgment()} disabled={!canRequestAi || aiLoading} data-testid="button-retry-futures-ai">重試</button></div>}
      {aiResult && !isNight && !aiLoading && <StrategyResult result={aiResult} />}
    </section>
  );
}
