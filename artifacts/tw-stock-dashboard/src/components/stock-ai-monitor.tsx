import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Activity, RefreshCw } from "lucide-react";
import {
  getGetStockAiAssessmentQueryKey,
  getGetStockCatalogQueryKey,
  getGetStockAiMonitorQueryKey,
  getGetStockHistoryQueryKey,
  getGetStockIntradayQueryKey,
  getGetStockAiPicksScanJobQueryKey,
  useGetStockAiPicksScanJob,
  useStartStockAiPicksScanJob,
  useGetStockAiAssessment,
  useGetStockCatalog,
  useGetStockAiMonitor,
  useGetStockHistory,
  useGetStockIntraday,
  type StockAiAssessment,
  type StockCatalogInstrument,
  type StockAiMonitorResponse,
  type StockHistory,
} from "@workspace/api-client-react";
import { calculateStockForce } from "../lib/stock-force";
import { calculateVolumePressure } from "../lib/volume-pressure";
import {
  calculateBudgetLotEstimate,
  isCurrentVerifiedEntryCandidate,
  isTaiwanStockBudgetEntryWindow,
} from "../lib/budget-sizing";

type MonitorItem = StockAiMonitorResponse["categories"][number]["items"][number];
type SelectedMonitorItem = {
  symbol: string;
  ticker: string;
  name: string;
  exchange: string;
  price: number | null;
  changePercent: number | null;
  force: number | null;
  status: string;
  asOf: string;
  source: string;
  forceDefinition: string;
};

const biasLabels: Record<StockAiAssessment["biasLevel"], string> = {
  strong_bearish: "強烈偏空",
  bearish: "偏空",
  neutral: "中性",
  bullish: "偏多",
  strong_bullish: "強烈偏多",
  insufficient: "資料不足",
};
const confidenceLabels: Record<StockAiAssessment["confidence"], string> = {
  high: "高",
  medium: "中",
  low: "低",
  not_applicable: "不適用",
};

const statusFor = (force: number | null) =>
  force === null ? "資料不足" : force >= 35 ? "多方轉強" : force >= 10 ? "偏多" : force > -10 ? "多空拉鋸" : force > -35 ? "偏空" : "空方轉強";

const percent = (value: number | null) => value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const timeText = (value?: string) => value
  ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })
  : "未提供";

function MinuteChart({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="monitor-chart-empty">目前沒有足夠的一分鐘 K 線可繪製。</div>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max * 0.002, 0.01);
  const points = values.map((value, index) => {
    const x = 8 + index / (values.length - 1) * 584;
    const y = 92 - (value - min) / span * 78;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg className="monitor-minute-chart" viewBox="0 0 600 112" role="img" aria-label="個股一分鐘收盤價走勢">
      {[20, 56, 92].map((y) => <line key={y} x1="8" x2="592" y1={y} y2={y} className="monitor-chart-grid" />)}
      <polyline points={points} className="monitor-chart-line" />
      <circle cx="592" cy={92 - (values.at(-1)! - min) / span * 78} r="3.5" className="monitor-chart-dot" />
    </svg>
  );
}

function MonitorCard({ item, selected, onClick }: { item: MonitorItem; selected: boolean; onClick: () => void }) {
  const priceDirection = item.changePercent === null
    ? "unavailable"
    : item.changePercent > 0
      ? "up"
      : item.changePercent < 0
        ? "down"
        : "flat";
  const priceDirectionLabel = priceDirection === "up"
    ? "價格上漲"
    : priceDirection === "down"
      ? "價格下跌"
      : priceDirection === "flat"
        ? "價格持平"
        : "漲跌資料不足";
  return (
    <button type="button" className={`monitor-stock glass-panel${selected ? " is-selected" : ""}`} onClick={onClick} data-testid={`monitor-stock-${item.symbol}`}>
      <span className="monitor-stock-name"><strong>{item.name}</strong><small>{item.ticker}</small></span>
      <span className="monitor-stock-quote"><b>{item.price.toLocaleString("zh-TW")}</b><small>{percent(item.changePercent)}</small></span>
      <span className={`monitor-force ${item.force == null ? "unavailable" : item.force > 0 ? "positive" : item.force < 0 ? "negative" : "neutral"}`}>
        <b>{item.force == null ? "—" : `${item.force > 0 ? "+" : ""}${item.force}`}</b>
        <small className="monitor-row-direction">
          <i className={`monitor-direction-light is-${priceDirection}`} aria-hidden="true" />
          {priceDirectionLabel}
        </small>
        <small>{item.status} · 日線力道</small>
      </span>
    </button>
  );
}

export function StockAiMonitor() {
  const query = useGetStockAiMonitor({ query: { queryKey: getGetStockAiMonitorQueryKey(), staleTime: 30_000, refetchOnWindowFocus: false } });
  const catalog = useGetStockCatalog({ query: { queryKey: getGetStockCatalogQueryKey(), staleTime: 6 * 60 * 60_000, retry: 1 } });
  const [categoryId, setCategoryId] = useState<string>("yesterday_strength");
  const [symbol, setSymbol] = useState<string | null>(null);
  const [mode, setMode] = useState<"live" | "after_market">("live");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInstrument, setSearchInstrument] = useState<StockCatalogInstrument | null>(null);
  const [aiRequested, setAiRequested] = useState(false);
  const [budgetInput, setBudgetInput] = useState("50000");
  const [scanJobId, setScanJobId] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const startBudgetScan = useStartStockAiPicksScanJob({
    mutation: {
      onSuccess: (job) => setScanJobId(job.id),
    },
  });
  const budgetScan = useGetStockAiPicksScanJob(scanJobId ?? 0, {
    query: {
      queryKey: getGetStockAiPicksScanJobQueryKey(scanJobId ?? 0),
      enabled: scanJobId !== null,
      staleTime: 0,
      refetchInterval: (scanQuery) => {
        const status = scanQuery.state.data?.status;
        return status === "queued" || status === "running" ? 1_500 : false;
      },
      refetchOnWindowFocus: false,
      retry: false,
    },
  });
  const category = query.data?.categories.find((item) => item.id === categoryId) ?? query.data?.categories[0];
  const items = category?.items ?? [];
  const monitorItems = useMemo(() => new Map(
    (query.data?.categories ?? []).flatMap((item) => item.items).map((item) => [item.symbol, item]),
  ), [query.data?.categories]);
  const selectedFromCategory = symbol ? monitorItems.get(symbol) : undefined;
  const selected: SelectedMonitorItem | undefined = searchInstrument && searchInstrument.symbol === symbol
    ? {
      ...selectedFromCategory,
      symbol: searchInstrument.symbol,
      ticker: searchInstrument.ticker,
      name: searchInstrument.name,
      exchange: searchInstrument.exchange,
      price: selectedFromCategory?.price ?? null,
      changePercent: selectedFromCategory?.changePercent ?? null,
      force: selectedFromCategory?.force ?? null,
      status: selectedFromCategory?.status ?? "資料不足",
      asOf: selectedFromCategory?.asOf ?? query.data?.marketDate ?? catalog.data?.asOf ?? "",
      source: selectedFromCategory?.source ?? "官方上市櫃清單",
      forceDefinition: selectedFromCategory?.forceDefinition ?? "此標的未列入目前技術分類，尚無日線多空力道。",
    }
    : selectedFromCategory ?? items[0];
  useEffect(() => {
    if (!searchInstrument && !symbol && items[0]) {
      setSymbol(items[0].symbol);
      setAiRequested(false);
    }
  }, [categoryId, query.data, searchInstrument, symbol]);
  const searchMatches = useMemo(() => {
    const search = searchTerm.trim().toLocaleLowerCase();
    if (!search) return [];
    return (catalog.data?.instruments ?? []).filter((instrument) =>
      [instrument.symbol, instrument.ticker, instrument.name].some((value) =>
        value.toLocaleLowerCase().includes(search),
      ),
    ).slice(0, 8);
  }, [catalog.data?.instruments, searchTerm]);
  const intraday = useGetStockIntraday(
    { symbol: selected?.symbol ?? "" },
    { query: { queryKey: getGetStockIntradayQueryKey({ symbol: selected?.symbol ?? "" }), enabled: Boolean(selected), staleTime: 20_000, refetchInterval: 60_000, refetchIntervalInBackground: false, retry: 1 } },
  );
  const history = useGetStockHistory(
    { symbol: selected?.symbol ?? "", range: "1mo" },
    {
      query: {
        queryKey: getGetStockHistoryQueryKey({ symbol: selected?.symbol ?? "", range: "1mo" }),
        enabled: Boolean(mode === "after_market" && selected),
        staleTime: 6 * 60 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  );
  const assessment = useGetStockAiAssessment(
    { symbol: selected?.symbol ?? "", entryMode: "current_price" },
    {
      query: {
        queryKey: getGetStockAiAssessmentQueryKey({
          symbol: selected?.symbol ?? "",
          entryMode: "current_price",
        }),
        enabled: Boolean(selected && aiRequested),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const assessmentResult = assessment.data;
  const hasShortTermEntryPlan = Boolean(
    assessmentResult &&
    assessmentResult.action === "buy" &&
    assessmentResult.direction === "bullish" &&
    assessmentResult.pricePlanStatus === "available" &&
    assessmentResult.entryPrice !== null &&
    assessmentResult.stopLossPrice !== null &&
    assessmentResult.takeProfitPrice !== null &&
    assessmentResult.entryReason &&
    assessmentResult.stopLossReason &&
    assessmentResult.takeProfitReason &&
    assessmentResult.stopLossPrice < assessmentResult.entryPrice &&
    assessmentResult.entryPrice < assessmentResult.takeProfitPrice,
  );
  const bars = intraday.data?.bars ?? [];
  const isLiveData = intraday.data?.sessionType === "live";
  const liveForce = isLiveData ? calculateStockForce(bars) : null;
  const historyForce = calculateStockForce(history.data?.bars ?? []);
  const afterMarketForce = selected?.force ?? historyForce;
  const force = mode === "live" ? liveForce : afterMarketForce;
  const status = mode === "live"
    ? isLiveData ? statusFor(liveForce) : intraday.isError ? "即時資料暫不可用" : "等待盤中行情"
    : selected?.force != null
      ? selected.status
      : history.isFetching
        ? "讀取日線資料"
        : history.isError
          ? "日線資料暫不可用"
          : statusFor(historyForce);
  const forceWidth = `${Math.min(Math.abs(force ?? 0), 100) / 2}%`;
  const path = query.data?.source ?? "資料來源待載入";
  const forceDescription = mode === "live"
    ? isLiveData ? "盤中近 5 根一分鐘 K 成交量加權" : "非盤中時段不以歷史分時代替即時力道"
    : "近 5 根日 K 成交量加權";
  const volumeSource = mode === "live"
    ? isLiveData && intraday.data
      ? { bars: intraday.data.bars, label: `盤中即時分 K · ${intraday.data.date} · ${intraday.data.source}` }
      : null
    : intraday.data?.sessionType === "historical"
      ? { bars: intraday.data.bars, label: `歷史分 K · ${intraday.data.date} · ${intraday.data.source}` }
      : history.data
        ? { bars: history.data.bars, label: `歷史日 K · ${history.data.bars.at(-1)?.date ?? "日期未提供"} · ${history.data.source}` }
        : null;
  const volumePressure = volumeSource ? calculateVolumePressure(volumeSource.bars) : null;
  const budget = Number(budgetInput);
  const hasValidBudget = Number.isFinite(budget) && budget > 0;
  const taiwanMarketEntryWindow = isTaiwanStockBudgetEntryWindow(nowMs);
  const canRestartBudgetScan =
    budgetScan.data?.status === "completed" || budgetScan.data?.status === "failed";
  const budgetCandidates = useMemo(() => {
    if (!hasValidBudget || !taiwanMarketEntryWindow) return [];

    return (budgetScan.data?.result?.picks ?? []).flatMap((pick) => {
      if (!isCurrentVerifiedEntryCandidate(pick, nowMs)) return [];
      const lotEstimate = calculateBudgetLotEstimate(budget, pick.referencePrice);
      if (!lotEstimate || lotEstimate.lots < 1) return [];
      return [{ pick, lotEstimate }];
    });
  }, [budget, budgetScan.data?.result?.picks, hasValidBudget, nowMs, taiwanMarketEntryWindow]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const chooseInstrument = (instrument: StockCatalogInstrument) => {
    setSearchInstrument(instrument);
    setSymbol(instrument.symbol);
    setSearchTerm(`${instrument.symbol} ${instrument.name}`);
    setSearchOpen(false);
    setAiRequested(false);
  };

  return (
    <section className="stock-ai-monitor" aria-labelledby="monitor-heading" data-testid="panel-stock-monitor">
      <header className="monitor-heading glass-panel">
        <div><p className="aipick-eyebrow"><Activity size={13} /> CATEGORY MONITOR / VERIFIED MARKET DATA</p><h2 id="monitor-heading">分類盯盤</h2></div>
        <div className="monitor-heading-actions">
          <div className="monitor-mode-switch" role="group" aria-label="選擇盯盤模式">
            <button type="button" className={mode === "live" ? "active" : ""} aria-pressed={mode === "live"} onClick={() => setMode("live")}>即時訊號</button>
            <button type="button" className={mode === "after_market" ? "active" : ""} aria-pressed={mode === "after_market"} onClick={() => setMode("after_market")}>盤後模式</button>
          </div>
          <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching} aria-label="更新分類盯盤資料" data-testid="button-refresh-monitor"><RefreshCw size={15} className={query.isFetching ? "is-spinning" : ""} /></button>
        </div>
      </header>
      {query.isLoading && <p className="monitor-state" role="status">載入官方市場資料與分類訊號…</p>}
      {query.isError && <p className="monitor-state error" role="alert"><AlertTriangle size={16} />分類盯盤資料暫時無法取得；未以模擬資料補齊。</p>}
      <div className="monitor-controls glass-panel">
        <div className="monitor-search">
          <label htmlFor="monitor-stock-search">搜尋個股</label>
          <input
            id="monitor-stock-search"
            type="search"
            value={searchTerm}
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => { setSearchTerm(event.target.value); setSearchOpen(true); }}
            placeholder={catalog.isLoading ? "載入官方清單…" : "輸入代號或名稱"}
            autoComplete="off"
            aria-controls="monitor-search-results"
            aria-expanded={searchOpen && Boolean(searchTerm.trim())}
          />
          {searchOpen && searchTerm.trim() && (
            <div className="monitor-search-results" id="monitor-search-results" role="listbox" aria-label="個股搜尋結果">
              {searchMatches.map((instrument) => (
                <button key={instrument.symbol} type="button" role="option" aria-selected={instrument.symbol === selected?.symbol} onClick={() => chooseInstrument(instrument)}>
                  <strong>{instrument.symbol}</strong><span>{instrument.name}</span><small>{instrument.exchangeName}</small>
                </button>
              ))}
              {!catalog.isLoading && !searchMatches.length && <p>{catalog.isError ? "官方清單暫不可用。" : "找不到符合的上市櫃標的。"}</p>}
            </div>
          )}
        </div>
        <span className="monitor-mode-note">{mode === "live" ? "盤中只顯示新鮮一分鐘力道；非盤中不以歷史值冒充即時。" : "以最近完整交易日的日線力道與分時資料作盤後觀察。"}</span>
      </div>
      <section className="monitor-budget-selector glass-panel" aria-labelledby="monitor-budget-heading" data-testid="panel-monitor-budget-selector">
        <div className="monitor-budget-header">
          <div className="monitor-budget-intro">
            <small>AI CANDIDATES · BUDGET SIZING</small>
            <h3 id="monitor-budget-heading">預算選股</h3>
            <p>查詢今日市場 AI 候選，只列三分鐘內已驗證成交、仍在進場區間且買得起整張的標的。</p>
          </div>
          <div className="monitor-budget-controls">
            <label htmlFor="monitor-budget-input">每檔試算預算</label>
            <div className="monitor-budget-input-wrap">
              <span>NT$</span>
              <input
                id="monitor-budget-input"
                type="number"
                min="1"
                step="1"
                value={budgetInput}
                onChange={(event) => setBudgetInput(event.target.value)}
                aria-label="每檔試算預算"
                data-testid="input-monitor-budget"
              />
            </div>
          </div>
          <button
            className="monitor-budget-scan-button"
            type="button"
            onClick={() => startBudgetScan.mutate({ data: canRestartBudgetScan ? { force: true } : {} })}
            disabled={startBudgetScan.isPending || budgetScan.data?.status === "queued" || budgetScan.data?.status === "running"}
            data-testid="button-monitor-budget-scan"
          >
            {startBudgetScan.isPending || budgetScan.data?.status === "queued" || budgetScan.data?.status === "running"
              ? "市場掃描中…"
              : canRestartBudgetScan
                ? "重新掃描今日名單"
                : "查詢今日可買名單"}
          </button>
        </div>
        <p className="monitor-budget-policy">
          每檔都獨立以整筆預算計算上限；若同時買多檔，總額可能超出預算。張數按 1,000 股計，成本含估算買進手續費，不含折扣、最低手續費與滑價。若今日已有結果，查詢會沿用；按「重新掃描」會再次執行全市場 AI 分析，可能使用供應商額度。
        </p>
        {!hasValidBudget && <p className="monitor-budget-state is-error" role="alert" data-testid="status-monitor-budget-invalid">請輸入大於 0 的預算。</p>}
        {startBudgetScan.isError && <p className="monitor-budget-state is-error" role="alert" data-testid="status-monitor-budget-scan-error">今日市場掃描未能啟動，請稍後再試。</p>}
        {budgetScan.isError && <p className="monitor-budget-state is-error" role="alert" data-testid="status-monitor-budget-result-error">無法讀取掃描結果，請重新查詢。</p>}
        {scanJobId !== null && budgetScan.isLoading && <p className="monitor-budget-state" role="status">正在載入市場掃描狀態…</p>}
        {(budgetScan.data?.status === "queued" || budgetScan.data?.status === "running") && (
          <div className="monitor-budget-progress" role="status" data-testid="status-monitor-budget-progress">
            <span>{budgetScan.data.stage === "complete" ? "整理結果中" : "正在分析市場候選"}</span>
            <b>{budgetScan.data.percent}%</b>
            <small>已掃描 {budgetScan.data.scannedCount} 檔 · 合格候選 {budgetScan.data.candidateCount} 檔</small>
          </div>
        )}
        {budgetScan.data?.status === "failed" && (
          <p className="monitor-budget-state is-error" role="alert" data-testid="status-monitor-budget-failed">
            {budgetScan.data.errorMessage ?? "今日市場 AI 掃描失敗，請稍後再試。"}
          </p>
        )}
        {budgetScan.data?.status === "completed" && budgetScan.data.result && (
          <div className="monitor-budget-results" data-testid="list-monitor-budget-candidates">
            <p className="monitor-budget-summary">
              今日掃描 {budgetScan.data.scannedCount.toLocaleString("zh-TW")} 檔 · AI 候選 {budgetScan.data.result.picks.length} 檔 · 結果時間 {timeText(budgetScan.data.result.analyzedAt)}
            </p>
            {!taiwanMarketEntryWindow && (
              <p className="monitor-budget-state" role="status" data-testid="status-monitor-budget-outside-window">
                目前不在 10:00–12:30 進場篩選時段；盤後價格只作觀察，不列為目前可買。
              </p>
            )}
            {taiwanMarketEntryWindow && hasValidBudget && budgetScan.data.result.picks.length === 0 && (
              <>
                <p className="monitor-budget-state" role="status" data-testid="status-monitor-budget-empty">
                  本次掃描沒有產生 AI 候選，因此目前沒有標的可做預算試算；這不是 NT$ {budget.toLocaleString("zh-TW")} 預算不足造成。可稍後重新掃描，或先瀏覽下方分類觀察名單。
                </p>
                {budgetScan.data.result.marketContextNote && (
                  <details className="monitor-methods monitor-budget-diagnostics">
                    <summary>查看本次掃描與篩選原因</summary>
                    <p>{budgetScan.data.result.marketContextNote}</p>
                  </details>
                )}
              </>
            )}
            {taiwanMarketEntryWindow && hasValidBudget && budgetScan.data.result.picks.length > 0 && !budgetCandidates.length && (
              <p className="monitor-budget-state" role="status" data-testid="status-monitor-budget-empty">
                有 AI 候選，但目前沒有同時符合三分鐘內新鮮成交、有效進場區間與整張預算的標的。資料過期時可按上方按鈕重新掃描。
              </p>
            )}
            {budgetCandidates.map(({ pick, lotEstimate }) => (
              <article className="monitor-budget-candidate" key={pick.symbol} data-testid={`card-monitor-budget-${pick.symbol}`}>
                <div className="monitor-budget-candidate-heading">
                  <div>
                    <strong>{pick.name}</strong>
                    <span>{pick.ticker}</span>
                  </div>
                  <b className="monitor-budget-action">符合條件，可評估進場</b>
                </div>
                <div className="monitor-budget-candidate-grid">
                  <div><small>最新成交</small><strong>NT$ {pick.referencePrice.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}</strong></div>
                  <div><small>每檔最多</small><strong>{lotEstimate.lots} 張 · {lotEstimate.shares.toLocaleString("zh-TW")} 股</strong></div>
                  <div><small>估算占用</small><strong>NT$ {lotEstimate.estimatedBuyCost.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}</strong></div>
                  <div><small>進場參考</small><strong>NT$ {pick.operationPlan.entryPrice!.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}</strong></div>
                  <div><small>停損參考</small><strong>NT$ {pick.operationPlan.stopPrice!.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}</strong></div>
                  <div><small>目標參考</small><strong>NT$ {pick.operationPlan.targetPrice!.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}</strong></div>
                </div>
                <small className="monitor-budget-quote-time">成交時間 {timeText(pick.referenceAsOf ?? undefined)} · {pick.referenceSource}</small>
              </article>
            ))}
            <p className="monitor-budget-disclaimer">AI 條件與預算估算僅供參考，不會下單或保證成交；進場前請再次確認即時行情與風險。</p>
          </div>
        )}
        {budgetScan.data?.status === "completed" && !budgetScan.data.result && (
          <p className="monitor-budget-state is-error" role="alert" data-testid="status-monitor-budget-no-result">
            今日掃描已結束，但沒有可用結果；請稍後重新查詢。
          </p>
        )}
      </section>
      {query.data && (
        <>
          <div className="monitor-source-line">
            <span>資料日 {query.data.marketDate}</span><span>{path}</span>
            <b>{query.data.coverage.partial ? `部分覆蓋 · ${query.data.coverage.withHistory}/${query.data.coverage.universe} 檔有完整日線` : `日線完整 ${query.data.coverage.withHistory} 檔`}</b>
          </div>
          <details className="monitor-methods">
            <summary>查看分類條件與覆蓋範圍</summary>
            <p>普通股技術分類依成交值前 120 檔並只納入資料日期一致、具至少 11 根日 K 的標的；如果覆蓋不足會標示「部分覆蓋」，不代表全市場排行。主動式 ETF 依官方名稱含「主動」或 Active 辨識。</p>
            <ul>
              <li>昨日強勢 ≥ +3%；近 5 日 ≥ +3%；近 10 日 ≥ +5%；急漲為單日 ≥ +5%。</li>
              <li>趨勢：收盤 &gt; MA5 &gt; MA20 &gt; MA60。布林：收盤突破 20 日均線 + 2 倍標準差。</li>
              <li>均線糾結：MA5/20/60 最大與最小值差距 ≤ 收盤的 1.5%，且收盤高於三條均線；突破 5 日線為前一日收盤在 MA5 下方、當日收盤站上 MA5。</li>
              <li>K 棒型態目前列出多方吞噬或收盤接近日高；分類與多空力道皆為可重算的技術條件，不是投資建議。</li>
            </ul>
          </details>
          <div className="monitor-layout">
            <nav className="monitor-categories glass-panel" aria-label="盯盤分類">
              {query.data.categories.map((item) => (
                <button key={item.id} type="button" className={item.id === category?.id ? "active" : ""} onClick={() => { setSearchInstrument(null); setSearchTerm(""); setSearchOpen(false); setAiRequested(false); setSymbol(item.items[0]?.symbol ?? null); setCategoryId(item.id); }} data-testid={`monitor-category-${item.id}`}>
                  <span>{item.label}</span><b>{item.count}</b>
                </button>
              ))}
            </nav>
            <div className="monitor-results">
              <div className="monitor-result-heading"><strong>{category?.label ?? "分類結果"}</strong><span>{category?.count ?? 0} 檔 · 點選個股查看分時</span></div>
              {items.length || searchInstrument ? (
                <div className="monitor-results-grid">
                  {items.length > 0 && <div className="monitor-stock-list">
                    {items.map((item) => <MonitorCard key={item.symbol} item={item} selected={selected?.symbol === item.symbol} onClick={() => { setSearchInstrument(null); setSearchTerm(""); setSearchOpen(false); setSymbol(item.symbol); setAiRequested(false); }} />)}
                  </div>}
                  {selected && (
                    <div className="monitor-detail-stack" data-testid="panel-monitor-intraday">
                    <article className="monitor-chart-panel glass-panel">
                      <div className="monitor-selected-title"><div><small>{selected.ticker} · {selected.exchange.toUpperCase()}</small><h3>{selected.name} <span>{selected.symbol}</span></h3></div><div className={`monitor-force-score ${force == null ? "muted" : force > 0 ? "positive" : force < 0 ? "negative" : "neutral"}`}><span className={`monitor-direction-light is-${force == null ? "unavailable" : force > 0 ? "up" : force < 0 ? "down" : "flat"}`} role="img" aria-label={`力道訊號：${statusFor(force)}`} /><b>{force == null ? "—" : `${force > 0 ? "+" : ""}${force}`}</b><small>{mode === "live" ? "即時力道" : "日線力道"}</small></div></div>
                      <div className="monitor-status-row"><span className={`monitor-status-pill ${mode === "live" && !isLiveData ? "is-waiting" : ""}`}>{status}</span><span>{mode === "live" && !isLiveData ? "等待盤中行情" : mode === "live" ? "盤中即時" : "盤後模式"}</span><span>{intraday.data?.date ?? selected.asOf}</span><span>分時末筆 {bars.at(-1)?.close.toLocaleString("zh-TW") ?? "—"}</span></div>
                      {mode === "live" && !isLiveData && <p className="monitor-live-notice">目前沒有新鮮的盤中一分鐘行情；圖表僅供最近交易日參考，即時多空力道暫不顯示。</p>}
                      <div className="monitor-force-meter" role="img" aria-label={`多空力道 ${force ?? "資料不足"}`}>
                        {force != null && <span className={force >= 0 ? "long" : "short"} style={{ width: forceWidth }} />}
                      </div>
                      <div className="monitor-force-meter-labels"><span>空方 −100</span><span>0</span><span>多方 +100</span></div>
                      <small className="monitor-force-definition">{forceDescription}</small>
                      {intraday.isLoading && <p className="monitor-chart-empty">讀取個股一分鐘行情…</p>}
                      {intraday.isError && <p className="monitor-chart-empty">分時行情暫不可用；保留已驗證的日線資料，不以日線代替分時圖。</p>}
                      {!intraday.isError && !intraday.isLoading && <MinuteChart values={bars.map((bar) => bar.close)} />}
                      <div className="monitor-chart-scale"><span>{bars[0]?.time ? timeText(bars[0].time) : "—"}</span><span>更新 {timeText(intraday.data?.asOf)}</span><span>{bars.at(-1)?.close.toLocaleString("zh-TW") ?? "—"}</span></div>
                       {mode === "after_market" && selected.force == null && history.isFetching && <p className="monitor-live-notice">正在讀取近一個月日線，計算盤後多空力道…</p>}
                       {mode === "after_market" && selected.force == null && history.isError && !history.isFetching && <p className="monitor-live-notice">個股日線暫時無法取得，盤後力道未計算。<button type="button" className="monitor-history-retry" onClick={() => void history.refetch()} disabled={history.isFetching}>重試</button></p>}
                       {mode === "after_market" && selected.force == null && history.isSuccess && historyForce == null && <p className="monitor-live-notice">可用日 K 不足 3 根或成交量資料不完整，暫時無法計算盤後力道。</p>}
                        <details className="monitor-formula"><summary>多空力道公式與資料限制</summary><p>{mode === "live" ? "即時力道：近 5 根一分鐘 K 的成交量加權多空實體。" : "盤後力道：近 5 根日 K 的成交量加權多空實體。"} 計算為 (收−開)/(高−低)×成交量，再除以總量，×100；至少需要 3 根有效 K 線。高低價相同的持平 K 棒仍計入成交量，方向貢獻為 0，避免把有成交的持平資料誤判為缺漏。力道 ≥35 多方轉強、10–34 偏多、−9–9 多空拉鋸、−34–−10 偏空、≤−35 空方轉強。此數值是可重算的價格／成交量代理指標，不代表委買賣壓、法人流向或原參考程式的專有公式。</p><small>{mode === "after_market" && history.data ? history.data.source : intraday.data?.source ?? selected.source} · {mode === "after_market" && history.data ? timeText(history.data.asOf) : timeText(intraday.data?.asOf ?? selected.asOf)}</small></details>
                    </article>
                    <section className="monitor-volume-pressure glass-panel" aria-labelledby="monitor-volume-heading" data-testid="panel-monitor-volume-pressure">
                      <div className="monitor-volume-heading">
                        <div>
                          <small>PRICE × VOLUME / RECENT 5 BARS</small>
                          <h4 id="monitor-volume-heading">近期量價分布</h4>
                          {volumePressure && <small className="monitor-volume-total">總成交量 {volumePressure.totalVolume.toLocaleString("zh-TW")}</small>}
                        </div>
                        {volumePressure && (
                          <strong className={`monitor-volume-bias is-${volumePressure.direction}`}>
                            {volumePressure.direction === "bullish" ? "估計偏多" : volumePressure.direction === "bearish" ? "估計偏空" : "方向中性"}
                          </strong>
                        )}
                      </div>
                      <p className="monitor-volume-context">
                        {mode === "live" && !isLiveData
                          ? intraday.isError ? "即時分時資料暫不可用；不以歷史 K 棒充當即時量價分布。" : "等待 sessionType 為 live 的新鮮分時資料；目前不以歷史 K 棒充當即時量價分布。"
                          : mode === "after_market" && !volumeSource && history.isFetching
                            ? "正在讀取已驗證的歷史 OHLCV 資料…"
                            : mode === "after_market" && !volumeSource && history.isError
                              ? "歷史 OHLCV 資料暫不可用；盤後分布無法計算。"
                              : !volumeSource
                                ? "目前沒有可用的已驗證 OHLCV 資料。"
                                : !volumePressure
                                  ? "有效成交 K 少於 3 根，資料不足，暫不估計方向。"
                                  : volumePressure.direction === "bullish"
                                    ? "近端上漲 K 棒成交量高於下跌 K 棒，價格／成交量型態估計偏多。"
                                    : volumePressure.direction === "bearish"
                                      ? "近端下跌 K 棒成交量高於上漲 K 棒，價格／成交量型態估計偏空。"
                                      : "上漲與下跌 K 棒成交量相當，或有效量主要來自持平 K 棒；方向中性。"}
                      </p>
                      {volumePressure && (
                        <>
                          <div
                            className="monitor-volume-distribution"
                            role="img"
                            aria-label={`近 ${volumePressure.barCount} 根有效 K 棒成交量分布：上漲 K ${volumePressure.upVolume.toLocaleString("zh-TW")}，下跌 K ${volumePressure.downVolume.toLocaleString("zh-TW")}，持平 K ${volumePressure.flatVolume.toLocaleString("zh-TW")}`}
                          >
                            <span className="volume-up" style={{ width: `${volumePressure.upVolume / volumePressure.totalVolume * 100}%` }} />
                            <span className="volume-down" style={{ width: `${volumePressure.downVolume / volumePressure.totalVolume * 100}%` }} />
                            <span className="volume-flat" style={{ width: `${volumePressure.flatVolume / volumePressure.totalVolume * 100}%` }} />
                          </div>
                          <div className="monitor-volume-values">
                            <span><i className="volume-key volume-up" />上漲 K <b>{volumePressure.upVolume.toLocaleString("zh-TW")}</b></span>
                            <span><i className="volume-key volume-down" />下跌 K <b>{volumePressure.downVolume.toLocaleString("zh-TW")}</b></span>
                            <span><i className="volume-key volume-flat" />持平 K <b>{volumePressure.flatVolume.toLocaleString("zh-TW")}</b></span>
                          </div>
                        </>
                      )}
                      {volumeSource && (
                        <small className="monitor-volume-source">
                          {volumeSource.label}{volumePressure ? ` · ${volumePressure.barCount} 根有效 K / 最新 5 根` : " · OHLCV 來源"}
                        </small>
                      )}
                      <small className="monitor-volume-caveat">依 K 棒收盤相對開盤分類成交量，僅為估計的多／空價格量型態；不代表主動買賣量、委託簿壓力或法人流向。平 K 成交量獨立列示。</small>
                    </section>
                      <section className="monitor-ai-opinion glass-panel" aria-label="AI 主觀結論">
                        <div className="monitor-ai-opinion-heading">
                          <div>
                            <strong>AI 現價短線判讀</strong>
                            <small>判斷最新行情是否適合現價進場；盤後只作次日參考</small>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (aiRequested) void assessment.refetch();
                              else setAiRequested(true);
                            }}
                            disabled={assessment.isFetching}
                          >
                            {assessment.isFetching ? "分析中…" : assessment.data ? "重新分析" : "取得 AI 結論"}
                          </button>
                        </div>
                        {aiRequested && assessment.isLoading && (
                          <p className="monitor-ai-state">正在整理行情與個股證據…</p>
                        )}
                        {aiRequested && assessment.isError && (
                          <p className="monitor-ai-state is-error">
                            AI 結論暫時無法取得；可稍後重試，分類與行情仍可使用。
                          </p>
                        )}
                        {aiRequested && assessment.data && (
                          <div className="monitor-ai-result">
                            <div className={`monitor-ai-bias bias-${assessment.data.direction}`}>
                              <strong>{biasLabels[assessment.data.biasLevel]}</strong>
                              <span>信心 {confidenceLabels[assessment.data.confidence]}</span>
                            </div>
                            <p>{assessment.data.summary}</p>
                            <div
                              className={`monitor-ai-action action-${assessment.data.action}`}
                              data-testid="text-monitor-ai-action"
                            >
                              <small>操作判斷</small>
                              <p>{assessment.data.actionText}</p>
                            </div>
                            <section
                              className={`monitor-entry-plan${hasShortTermEntryPlan ? " is-ready" : " is-waiting"}`}
                              aria-label="AI 現價進場短線策略"
                              data-testid="panel-monitor-entry-plan"
                            >
                              <div className="monitor-entry-plan-heading">
                                <strong>
                                  {assessment.data.referenceType === "verified_trade"
                                    ? "現價進場策略"
                                    : "收盤基準的次日策略"}
                                </strong>
                                <span>AI 主觀估算 · 未來 1–5 個交易日</span>
                              </div>
                              {hasShortTermEntryPlan && assessmentResult ? (
                                <>
                                  <div className="monitor-entry-plan-levels">
                                    <div className="is-entry">
                                      <small>
                                        {assessmentResult.referenceType === "verified_trade"
                                          ? "現價進場"
                                          : "次日參考價"}
                                      </small>
                                      <strong>
                                        {assessmentResult.entryPrice!.toLocaleString("zh-TW", {
                                          minimumFractionDigits: 2,
                                          maximumFractionDigits: 2,
                                        })}
                                      </strong>
                                    </div>
                                    <div>
                                      <small>停損參考</small>
                                      <strong>
                                        {assessmentResult.stopLossPrice!.toLocaleString("zh-TW", {
                                          minimumFractionDigits: 2,
                                          maximumFractionDigits: 2,
                                        })}
                                      </strong>
                                    </div>
                                    <div>
                                      <small>目標參考</small>
                                      <strong>
                                        {assessmentResult.takeProfitPrice!.toLocaleString("zh-TW", {
                                          minimumFractionDigits: 2,
                                          maximumFractionDigits: 2,
                                        })}
                                      </strong>
                                    </div>
                                  </div>
                                  <p>{assessmentResult.entryReason}</p>
                                  <small className="monitor-entry-plan-note">
                                    {assessmentResult.referenceType === "official_daily_close"
                                      ? "目前沒有可用的即時成交；此收盤價只作下一交易日情境參考，開盤後先核對最新成交與條件，不可視為現在可執行價格。"
                                      : "進場價採用本次已驗證成交價；只有行情與判讀條件仍成立時才考慮。"}
                                    {" "}非歷史回測或獲利保證。
                                  </small>
                                </>
                              ) : (
                                <p className="monitor-entry-plan-unavailable">
                                  {assessment.data.action === "insufficient"
                                    ? "證據不足，暫不提供現價進場策略。"
                                    : assessment.data.action === "wait"
                                      ? "AI 判斷現價不適合直接進場，或必要條件尚未成立。"
                                      : "AI 這次沒有提供可用的現價進場方案。"}
                                  {" "}{assessment.data.pricePlanMessage}
                                </p>
                              )}
                            </section>
                            <small>
                              參考價 {assessment.data.referencePrice.toLocaleString("zh-TW")} ·{" "}
                              {assessment.data.referenceType === "verified_trade" ? "已驗證成交" : "官方日收盤"}{" "}
                              {timeText(assessment.data.quoteAsOf ?? undefined)} · AI 分析{" "}
                              {timeText(assessment.data.analyzedAt)}
                            </small>
                          </div>
                        )}
                      </section>
                    </div>
                  )}
                </div>
              ) : <p className="monitor-state">此分類目前沒有符合條件的標的。</p>}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
