import { useEffect, useState } from "react";
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Clock3, Database, RefreshCw, ShieldCheck } from "lucide-react";
import {
  getGetStockAiAssessmentQueryKey,
  getGetStockAiPicksScanJobQueryKey,
  useGetStockAiAssessment,
  useGetStockAiPicksScanJob,
  useStartStockAiPicksScanJob,
  type StockAiPick,
} from "@workspace/api-client-react";
import { StockAiHistoricalValidation } from "../components/stock-ai-historical-validation";
import "./ai-picks.css";

const number = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const signedPercent = (value: number | null) =>
  value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

const dateText = (value?: string | null) => {
  if (!value) return "未提供";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
};

const timeText = (value?: string | null) => {
  if (!value) return "未提供";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
};

const compactValue = (value: number) =>
  new Intl.NumberFormat("zh-TW", { notation: "compact", maximumFractionDigits: 1 }).format(value);

type CdpZone = NonNullable<StockAiPick["cdpLevels"]>["currentZone"];
const cdpZoneLabels: Record<CdpZone, string> = {
  above_ah: "高於 AH",
  ah_to_nh: "AH–NH",
  nh_to_cdp: "NH–CDP",
  cdp_to_nl: "CDP–NL",
  nl_to_al: "NL–AL",
  below_al: "低於 AL",
};

function PickCard({ pick, rank, onSelect }: { pick: StockAiPick; rank: number; onSelect: () => void }) {
  const trend = pick.referenceChange == null ? "flat" : pick.referenceChange > 0 ? "up" : pick.referenceChange < 0 ? "down" : "flat";
  const isFallback = pick.reason.startsWith("[🟡 綜合高分補位標的]");
  const quickTags = pick.screeningReportMarkdown
    .split("\n")
    .filter((line) => line.startsWith("* "))
    .slice(0, 3)
    .map((line) => line.slice(2));
  return (
    <div className="aipick-card-row">
      <button
        type="button"
        className="aipick-card"
        onClick={onSelect}
        data-testid={`button-open-assessment-${pick.symbol}`}
        aria-label={`查看 ${pick.symbol} ${pick.name} 的 pending 名單資料`}
      >
      <span className="aipick-index mono" aria-hidden="true">TOP {String(rank).padStart(2, "0")}</span>
      <span className="aipick-identity">
        <span className="aipick-name-line">
          <strong data-testid={`text-candidate-name-${pick.symbol}`}>{pick.name}</strong>
          <span className="aipick-ticker mono" data-testid={`text-candidate-symbol-${pick.symbol}`}>{pick.symbol}</span>
          <span className={`aipick-tier ${isFallback ? "fallback" : "tier-one"}`} data-testid={`tag-selection-tier-${pick.symbol}`}>
            {isFallback ? "🟡 次級條件候選" : "🟢 符合短線條件"}
          </span>
        </span>
        <span className="aipick-exchange">{pick.ticker}</span>
      </span>
      <span className="aipick-quote">
        <strong className="mono" data-testid={`text-reference-price-${pick.symbol}`}>{number(pick.referencePrice)}</strong>
        <span data-testid={`text-quote-provenance-${pick.symbol}`}>
          {pick.referenceType === "verified_trade"
            ? `已驗證成交 · ${pick.referenceSource} · ${timeText(String(pick.referenceAsOf))}`
          : `${pick.referenceSource} · 歷史成交時間 ${timeText(String(pick.referenceAsOf))}`}
          {" · 成交值 "}{compactValue(pick.tradedValue)}
        </span>
      </span>
      <span className={`aipick-delta ${trend}`} data-testid={`status-daily-change-${pick.symbol}`}>
        {trend === "up" && <ArrowUpRight size={14} aria-hidden="true" />}
        {trend === "down" && <ArrowDownRight size={14} aria-hidden="true" />}
        <strong className="mono" data-testid={`text-change-percent-${pick.symbol}`}>{signedPercent(pick.referenceChangePercent)}</strong>
        <small data-testid={`text-change-amount-${pick.symbol}`}>{pick.referenceChange == null ? "漲跌未提供" : `${pick.referenceChange > 0 ? "+" : ""}${number(pick.referenceChange)}`}</small>
      </span>
      <span className="aipick-reason" data-testid={`text-candidate-reason-${pick.symbol}`}>
        {pick.reason} 機率驗證依據：{pick.probabilityEvidence}
        <span className="aipick-quick-tags">{quickTags.map((tag) => <span key={tag}>{tag}</span>)}</span>
      </span>
      <span className="aipick-probability" data-testid={`status-direction-probability-${pick.symbol}`}>
        <small>日線策略歷史回測（非當沖勝率）</small>
        <strong className="mono">{pick.ruleHitRatePercent?.toFixed(1) ?? "—"}%</strong>
        <span>{pick.ruleCorrectCount} 勝 / {pick.ruleSampleCount - pick.ruleCorrectCount} 敗 · {pick.ruleSampleCount} 筆 · 95% 下界 {pick.ruleLowerBoundPercent?.toFixed(1) ?? "—"}%</span>
        <span>日線情境參考：進場 {number(pick.operationPlan.entryPrice)} · 目標 {number(pick.operationPlan.targetPrice)} · 停損 {number(pick.operationPlan.stopPrice)}</span>
        <span className="aipick-action-hint">{isFallback ? "次級條件候選 · 非當沖績效" : "多日策略歷史回測 · 非當沖績效"}</span>
      </span>
      <span className="aipick-card-arrow" aria-hidden="true"><ChevronRight size={18} /></span>
      </button>
      <details className="aipick-screening-report" data-testid={`report-screening-${pick.symbol}`}>
        <summary>查看短線篩選與入選依據</summary>
        <p>{pick.reason} {pick.probabilityEvidence}</p>
        <p>日線歷史結果不是當沖勝率；盤中候選只在 10:00–12:30 的即時條件下成立，盤後名單是下一交易日觀察清單。AI 條件研判不是下單指令。</p>
        {pick.cdpLevels && <p data-testid={`text-cdp-summary-${pick.symbol}`}>
          CDP 五價（基準 {dateText(String(pick.cdpLevels.referenceDate))}）：AH {number(pick.cdpLevels.ah)} · NH {number(pick.cdpLevels.nh)} · CDP {number(pick.cdpLevels.cdp)} · NL {number(pick.cdpLevels.nl)} · AL {number(pick.cdpLevels.al)}；現價位於{cdpZoneLabels[pick.cdpLevels.currentZone]}。
        </p>}
      </details>
    </div>
  );
}

function AssessmentDetail({ symbol, pick, onBack }: { symbol: string; pick?: StockAiPick; onBack: () => void }) {
  const assessment = useGetStockAiAssessment(
    { symbol },
    { query: { enabled: Boolean(symbol) && !pick, queryKey: getGetStockAiAssessmentQueryKey({ symbol }), staleTime: 60_000 } },
  );
  const data = assessment.data;
  if (pick) {
    return (
      <section className="assessment-view" aria-labelledby="assessment-title" data-testid="panel-ai-assessment">
        <button type="button" className="aipick-back" onClick={onBack} data-testid="button-back-to-candidates">
          <ChevronLeft size={16} /> 返回候選清單
        </button>
        <header className="assessment-header">
          <div>
            <p className="aipick-eyebrow">短線當沖條件參考 / {pick.ticker}</p>
            <h2 id="assessment-title"><span className="mono">{pick.symbol}</span><span>觀察條件</span></h2>
            <p className="assessment-summary">{pick.reason}</p>
          </div>
          <div className="assessment-action assessment-validation">
            <small>AI 條件研判</small>
            <strong>看多入選</strong>
            <span>AI 依個股消息與技術資料作判斷</span>
            <span>歷史勝率由程式按訊號與價位規則計算</span>
          </div>
        </header>
        <div className="pick-hit-rate">
          <div><small>日線回測命中率（非當沖）</small><strong>{pick.ruleHitRatePercent?.toFixed(1) ?? "—"}%</strong></div>
          <span>觀察 {pick.ruleCorrectCount} 勝 / {pick.ruleSampleCount - pick.ruleCorrectCount} 敗 · 共 {pick.ruleSampleCount} 筆；同日同時觸及目標與停損算失敗，未觸及任一價位不計入分母。</span>
          <span data-testid="text-local-price-plan-backtest">{pick.probabilityEvidence}</span>
          <span>以下價位來自日線多日策略，不是當沖進出點：進場 {number(pick.operationPlan.entryPrice)}、目標 {number(pick.operationPlan.targetPrice)}、停損 {number(pick.operationPlan.stopPrice)}。</span>
        </div>
        <div className="market-context">
          <strong>{pick.operationPlan.action === "wait_for_pullback" ? "買法：等回檔，不追高" : pick.operationPlan.action === "conditional_entry" ? "買法：參考價附近條件進場" : "買法：目前不進場"}</strong>
          {pick.operationPlan.action === "no_trade" ? <p>目前沒有符合風險報酬條件的計畫，先觀望。</p> : (
            <div className="price-plan-grid">
              <PriceLevel label="條件進場" value={pick.operationPlan.entryPrice} reason={pick.operationPlan.action === "wait_for_pullback" ? "等待回落至此價附近並確認止跌；不代表觸價必買。" : "僅限未大幅跳漲時；分批並核對即時行情。"} testId="entry" />
              <PriceLevel label="停損" value={pick.operationPlan.stopPrice} reason="跌破此價代表原情境失效，依計畫停損。" testId="stop" />
              <PriceLevel label="目標" value={pick.operationPlan.targetPrice} reason="到價重新評估，不保證成交或獲利。" testId="target" />
            </div>
          )}
          {pick.operationPlan.rewardToRisk != null && <p>試算風險報酬比 1：{pick.operationPlan.rewardToRisk.toFixed(2)}。這是價格情境，不是勝率。</p>}
        </div>
        <div className="market-context" data-testid={`panel-cdp-${pick.symbol}`}>
          <strong>CDP 五價區間參考</strong>
          {pick.cdpLevels ? (
            <>
              <p>使用 {dateText(String(pick.cdpLevels.referenceDate))} 的已完成交易日高、低、收盤價計算：AH {number(pick.cdpLevels.ah)} · NH {number(pick.cdpLevels.nh)} · CDP {number(pick.cdpLevels.cdp)} · NL {number(pick.cdpLevels.nl)} · AL {number(pick.cdpLevels.al)}。</p>
              <p>現價位置：{cdpZoneLabels[pick.cdpLevels.currentZone]}{pick.cdpLevels.openingZone ? `；當日開盤位置：${cdpZoneLabels[pick.cdpLevels.openingZone]}` : ""}。</p>
              <p>只呈現價格所在區間；資料未確認盤中穿越先後，不代表已突破、反轉或交易訊號。</p>
            </>
          ) : <p>無足夠有效的前一交易日 OHLC 資料，無法計算 CDP 區間。</p>}
        </div>
          <div className="market-context">{pick.reason.startsWith("[🟡 綜合高分補位標的]") ? "此為量化排序補位標的，未通過完整 Tier-1 回測門檻；目前不提供進場計畫，請勿視為完整 SMC 交易訊號。" : "依近期看多 BOS／CHoCH 或掃蕩站回，並確認 OB／未回補 FVG 支撐。回測至少 10 筆、勝率 ≥ 50%，SMC R/R ≥ 2.0；結果不代表未來獲利。"}</div>
        <div className="assessment-disclaimer"><p>僅供短線條件參考，不是個人化投資建議、當沖訊號或獲利保證。盤後資料須於下一交易日重新確認；下單前應先設定停損，並確認風險報酬比至少 1:2。</p></div>
      </section>
    );
  }
  const directionLabel = data?.direction === "bullish"
    ? "偏多"
    : data?.direction === "bearish"
      ? "偏空"
      : data?.direction === "neutral"
        ? "方向不明"
        : "資料不足";
  const confidenceLabel = data?.confidence === "high"
    ? "高"
    : data?.confidence === "medium"
      ? "中"
      : data?.confidence === "low"
        ? "低"
        : "不適用";

  return (
    <section className="assessment-view" aria-labelledby="assessment-title" data-testid="panel-ai-assessment">
      <button type="button" className="aipick-back" onClick={onBack} data-testid="button-back-to-candidates">
        <ChevronLeft size={16} /> 返回候選清單
      </button>
      {assessment.isLoading && (
        <div className="assessment-skeleton" data-testid="status-assessment-loading" aria-label="正在載入個股評估">
          <span /><span /><span /><span />
        </div>
      )}
      {assessment.isError && (
        <div className="aipick-state error" role="alert" data-testid="status-assessment-error">
          <AlertTriangle size={20} />
          <div><strong>評估資料暫時無法取得</strong><p>官方參考資料或分析服務目前沒有回應，請稍後重試。</p></div>
          <button type="button" onClick={() => void assessment.refetch()} data-testid="button-retry-assessment">重試</button>
        </div>
      )}
      {data && (
        <>
          <header className="assessment-header">
            <div>
              <p className="aipick-eyebrow">個股短線分析 / {data.ticker}</p>
              <h2 id="assessment-title"><span className="mono">{data.symbol}</span><span>結論</span></h2>
              <p className="assessment-summary" data-testid="text-assessment-summary">{data.summary}</p>
            </div>
            <div className={`assessment-action action-${data.action}`} data-testid="status-assessment-action">
              <small>怎麼做</small><strong data-testid="text-assessment-action">{data.actionText || data.action}</strong>
              <span data-testid="text-assessment-horizon">{data.horizon}</span>
            </div>
          </header>
          <div className="assessment-provenance" data-testid="status-assessment-reference">
            <div><Database size={15} /><span>參考價格</span><strong className="mono">{number(data.referencePrice)}</strong></div>
            <div><span>參考依據</span><strong data-testid="text-assessment-reference-type">{data.referenceType === "official_daily_close" ? "官方日收盤" : "已驗證成交"}</strong></div>
            <div><span>資料日期</span><strong data-testid="text-assessment-reference-date">{dateText(data.quoteAsOf)}</strong></div>
            <div><Clock3 size={15} /><span>分析時間</span><strong data-testid="text-assessment-analyzed-at">{timeText(data.analyzedAt)}</strong></div>
          </div>
          {data.actionReferenceReason && (
            <p className="assessment-reference-note" data-testid="text-assessment-reference-reason">{data.actionReferenceLabel ? `${data.actionReferenceLabel}：` : ""}{data.actionReferenceReason}</p>
          )}
          <div className="assessment-columns">
            <section className="assessment-section">
              <div className="aipick-section-heading"><span className="section-index">01</span><div><small>為什麼</small><h3>支持理由</h3></div></div>
              {data.signals.length ? (
                <ul className="assessment-list" data-testid="list-assessment-signals">
                  {data.signals.map((signal, index) => <li key={`${index}-${signal}`} data-testid={`item-assessment-signal-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{signal}</p></li>)}
                </ul>
              ) : <p className="aipick-muted" data-testid="empty-assessment-signals">目前沒有可列示的訊號。</p>}
              <div className="market-context" data-testid="panel-assessment-news">
                <small>近期消息線索 · 搜尋時間 {timeText(data.webResearch.searchedAt)}</small>
                {data.webResearch.sources.length ? (
                  <ul className="assessment-list" data-testid="list-assessment-news">
                    {data.webResearch.sources.map((source, index) => (
                      <li key={`${source.url}-${index}`} data-testid={`item-assessment-news-${index}`}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <p>
                          <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
                          {source.snippet ? <><br />{source.snippet}</> : null}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p data-testid="status-assessment-news">
                    {data.webResearch.status === "unavailable"
                      ? "新聞搜尋服務目前無回應；本次方向不以消息面作判斷。"
                      : "本次沒有可列示的近期消息；不以未核實傳聞補足證據。"}
                  </p>
                )}
              </div>
              {data.marketSummary && <div className="market-context" data-testid="text-assessment-market-context"><small>大盤環境 · {data.marketInfluence}</small><p>{data.marketSummary}</p></div>}
            </section>
            <section className="assessment-section risk-section">
              <div className="aipick-section-heading"><span className="section-index">02</span><div><small>風險邊界</small><h3>需要留意</h3></div></div>
              {data.risks.length ? (
                <ul className="risk-list" data-testid="list-assessment-risks">
                  {data.risks.map((risk, index) => <li key={`${index}-${risk}`} data-testid={`item-assessment-risk-${index}`}><AlertTriangle size={14} /><span>{risk}</span></li>)}
                </ul>
              ) : <p className="aipick-muted" data-testid="empty-assessment-risks">目前未列出個別風險；這不代表沒有風險。</p>}
              <div className="assessment-confidence" data-testid="status-assessment-confidence">
                <span>方向 / 線索一致度</span><strong>{directionLabel} · {confidenceLabel}</strong>
                <small>一致度不是勝率，尚未經歷史校準。</small>
              </div>
            </section>
          </div>
          <section className="price-plan" data-testid="panel-assessment-price-plan">
            <div className="price-plan-title">
              <div><p className="aipick-eyebrow">操作價位</p><h3>進場／停損／目標</h3></div>
              <span className={`plan-status ${data.pricePlanStatus}`}>{data.pricePlanStatus === "available" ? "可供參考" : data.pricePlanStatus === "rejected" ? "評估未通過" : "不適用"}</span>
            </div>
            <div className="price-plan-grid">
              <PriceLevel label="觀察進場" value={data.entryPrice} reason={data.entryReason} testId="entry" />
              <PriceLevel label="風險停損" value={data.stopLossPrice} reason={data.stopLossReason} testId="stop" />
              <PriceLevel label="目標停利" value={data.takeProfitPrice} reason={data.takeProfitReason} testId="target" />
            </div>
            {data.pricePlanMessage && <p className="price-plan-message" data-testid="text-price-plan-message">{data.pricePlanMessage}</p>}
          </section>
          <StockAiHistoricalValidation symbol={symbol} />
          <div className="assessment-disclaimer" data-testid="status-assessment-disclaimer">
            <ShieldCheck size={17} /><p>此頁是研究輔助，不構成投資建議。價格框架依所示官方參考資料，不是即時報價或下單指令；請自行核對來源、流動性與部位風險。</p>
          </div>
        </>
      )}
    </section>
  );
}

function PriceLevel({ label, value, reason, testId }: { label: string; value: number | null; reason: string | null; testId: string }) {
  return (
    <div className="price-level" data-testid={`price-level-${testId}`}>
      <small>{label}</small>
      <strong className="mono" data-testid={`text-price-${testId}`}>{value == null ? "未提供" : number(value)}</strong>
      <p>{reason || "此評估未提供價格理由。"}</p>
    </div>
  );
}

export default function AiPicksPage() {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [isCompactHeader, setIsCompactHeader] = useState(false);
  const [scanJobId, setScanJobId] = useState<number | null>(null);
  const handleScanStarted = (job: { id: number }) => setScanJobId(job.id);
  const startScan = useStartStockAiPicksScanJob({
    mutation: { onSuccess: handleScanStarted },
  });
  const startInitialScan = useStartStockAiPicksScanJob({
    mutation: {
      retry: 1,
      onSuccess: handleScanStarted,
    },
  });
  const scanQuery = useGetStockAiPicksScanJob(scanJobId ?? 0, {
    query: {
      enabled: scanJobId !== null,
      queryKey: getGetStockAiPicksScanJobQueryKey(scanJobId ?? 0),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "completed" || status === "failed" ? false : 1000;
      },
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    },
  });
  useEffect(() => { startInitialScan.mutate({ data: { force: false } }); }, []);
  const isScanning = startScan.isPending || startInitialScan.isPending ||
    scanQuery.data?.status === "queued" || scanQuery.data?.status === "running";
  const picksQuery = {
    data: scanQuery.data?.result ?? undefined,
    isError: startScan.isError || startInitialScan.isError || scanQuery.isError ||
      scanQuery.data?.status === "failed",
    isFetching: isScanning,
  };
  const retryScan = () => {
    if (scanQuery.data?.status === "failed") {
      startScan.mutate({ data: { force: true } });
    } else if (scanJobId !== null) {
      void scanQuery.refetch();
    } else {
      startInitialScan.mutate({ data: { force: false } });
    }
  };
  useEffect(() => {
    const updateHeaderSize = () => {
      const scrollY = window.scrollY;
      setIsCompactHeader((wasCompact) =>
        wasCompact ? scrollY > 24 : scrollY > 92,
      );
    };
    updateHeaderSize();
    window.addEventListener("scroll", updateHeaderSize, { passive: true });
    return () => {
      window.removeEventListener("scroll", updateHeaderSize);
    };
  }, []);
  const data = picksQuery.data;
  const isLegacyResult = Boolean(data && (
    data.dailyPendingChanges === undefined ||
    !data.probabilityDefinition.includes("短線流動性篩選") ||
    !data.probabilityDefinition.includes("10:00–12:30") ||
    !data.probabilityDefinition.includes("不是當沖勝率")
  ));
  const forwardValidation = data?.forwardValidation;
  const picks = isLegacyResult
    ? []
    : (data?.picks ?? []).filter((pick) =>
      pick.reason.startsWith("[🟡 綜合高分補位標的]") ||
      (
        pick.historicalPricePlanSampleCount >= 10 &&
        (pick.ruleHitRatePercent ?? 0) >= 50 &&
        (pick.operationPlan.rewardToRisk ?? 0) >= 2
      ),
    );
  const breadthTotal = data ? data.advances + data.declines + data.unchanged : 0;
  const progress = scanQuery.data;
  const progressMessage = progress?.stage === "market_data"
    ? progress.percent > 3
      ? `逐股日線備援 · ${progress.completedCandidates}/${progress.candidateCount} 檔`
      : "讀取官方日報與大盤資料"
    : progress?.stage === "preliminary"
      ? "準備流動性候選"
      : progress?.stage === "final_selection"
        ? "AI 正在研究個股消息並作最終判斷"
        : progress?.stage === "candidate_analysis"
          ? progress.percent < 35
            ? `讀取候選股票日線 · ${progress.completedCandidates}/${progress.candidateCount} 檔`
            : progress.percent < 68
              ? `計算量價訊號與歷史回測 · ${progress.completedCandidates}/${progress.candidateCount} 檔`
              : `整理合格候選 · ${progress.completedCandidates}/${progress.candidateCount} 檔`
          : progress?.stage === "error"
            ? "掃描遇到問題，請稍後重試"
            : "準備開始全市場掃描";

  return (
    <main className={`ai-picks-page${isCompactHeader ? " is-title-compact" : ""}`} data-testid="page-ai-picks">
      <div className="ai-picks-inner">
        <div className="aipick-sticky-stack">
        <div className="aipick-topline">
          <div className="aipick-breadcrumb"><span>市場研究</span><span>/</span><strong>AI 候選掃描</strong></div>
          <button type="button" className="aipick-refresh" onClick={() => startScan.mutate({ data: { force: true } })} disabled={picksQuery.isFetching} data-testid="button-rescan-market">
            <RefreshCw size={15} className={picksQuery.isFetching ? "is-spinning" : ""} />
            {picksQuery.isFetching ? "更新行情中…" : "更新行情並重篩"}
          </button>
        </div>

        <header className="aipick-hero">
          <div className="hero-copy">
            <p className="aipick-eyebrow"><Activity size={13} /> TAIWAN EQUITY RESEARCH / 01</p>
            <h1>先看證據，<br /><em>再看判斷。</em></h1>
          <p className="hero-lede">以當沖流動性與風險報酬條件篩選：低於 100 元至少 1 萬張、100 元以上至少 5 千張；盤中僅於 10:00–12:30 採用即時行情。盤後結果只作下一交易日觀察，須重新確認，不是進場指令。</p>
          </div>
          <div className="hero-note">
            <span className="hero-note-mark">TW</span>
            <div><small>LOCAL QUANT + AI REVIEW</small><strong>當沖條件 · AI 消息判讀</strong><span>日線回測不是當沖勝率</span></div>
            <span className="hero-note-number mono">05</span>
          </div>
        </header>

        <section className="market-context" data-testid="panel-day-trade-guidance">
          <strong>短線當沖條件參考</strong>
          <p>優先看成交量與流動性，排除 ETF 與文章舉例的權值股（2330、2002、2317）；開盤後 60 分鐘避免追價，尾盤前 60 分鐘不列新進場候選。CDP 僅作支撐壓力參考，不單獨作進場訊號；下單前先設停損，風險報酬至少 1:2。歷史統計仍是多日線策略，不能解讀為當沖勝率。</p>
          <details className="aipick-screening-report" data-testid="panel-cdp-method">
            <summary>查看 CDP 公式與判讀限制</summary>
            <p>以基準交易日高／低／收（H/L/C）計算：CDP＝(H＋L＋2C)/4、AH＝CDP＋(H－L)、NH＝2CDP－L、NL＝2CDP－H、AL＝CDP－(H－L)。文章的判讀方式是順勢突破 AH/NH 偏多、跌破 NL/AL 偏空；逆勢向上穿越 AL 偏多、向下穿越 AH 偏空。此頁只有開盤與現價所在區間，不能驗證盤中穿越順序。參考 <a href="https://www.sinotrade.com.tw/richclub/news/644a0151a25129d56f75e8c3" target="_blank" rel="noopener noreferrer">豐雲學堂短線交易文章</a>與 <a href="https://quantpass.org/cdp-2/" target="_blank" rel="noopener noreferrer">QuantPass CDP 指標說明</a>。</p>
          </details>
        </section>

        {picksQuery.isFetching && (
          <section className="scan-progress" data-testid="status-market-scan-progress" role="status" aria-live="polite">
            <div className="scan-progress-copy">
              <span>{progressMessage}</span>
              <strong className="mono">{progress?.percent ?? 0}%</strong>
            </div>
            <div
              className="scan-progress-track"
              role="progressbar"
              aria-label="全市場掃描進度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress?.percent ?? 0}
            >
              <span style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <small>
              {progress?.scannedCount
                ? `已納入 ${progress.scannedCount.toLocaleString("zh-TW")} 檔普通股`
                : "正在準備官方市場資料"}
            </small>
          </section>
        )}
        </div>
        {picksQuery.isError && (
          <div className="aipick-state error scan-error" role="alert" data-testid="status-scan-error">
            <AlertTriangle size={21} /><div><strong>市場掃描資料暫時無法取得</strong><p>請稍後重試。頁面不會以模擬行情補上缺漏。</p></div>
            <button type="button" onClick={retryScan} data-testid="button-retry-scan">重新載入</button>
          </div>
        )}
        {data && (
          <>
            <section className="market-snapshot" aria-label="市場掃描摘要" data-testid="panel-market-snapshot">
              <div className="snapshot-head">
                <div><p className="aipick-eyebrow">全市場掃描 / LIVE QUOTES + OFFICIAL UNIVERSE</p><h2>掃描日 <span className="mono" data-testid="text-market-date">{dateText(data.marketDate)}</span></h2></div>
                <div className="snapshot-source"><span className="source-led" /><span data-testid="text-market-source">{data.source}</span></div>
              </div>
              {data.marketContextStatus === "partial" && !isLegacyResult && (
                <p className="market-context-warning" role="status" data-testid="status-partial-market-context">
                  <AlertTriangle size={14} />{data.marketContextNote}
                </p>
              )}
              <section className="market-index-snapshot" aria-label="與市場分析同步的大盤摘要" data-testid="panel-synced-market-summary">
                <div className="market-index-heading">
                  <strong>同步市場分析 · 台灣加權指數</strong>
                  <span data-testid="text-synced-market-source">{data.marketIndexQuote.source ?? data.marketSummary?.source ?? "來源暫不可用"}</span>
                </div>
                <div className="market-index-grid">
                  <div><small>最新參考</small><strong className="mono" data-testid="text-synced-index-price">{number(data.marketIndexQuote.price)}</strong></div>
                  <div><small>當日漲跌</small><strong className={`mono ${(data.marketIndexQuote.changePercent ?? 0) >= 0 ? "up" : "down"}`} data-testid="text-synced-index-change">{signedPercent(data.marketIndexQuote.changePercent)}</strong></div>
                  <div><small>20 日平均價</small><strong className="mono">{number(data.marketSummary?.ma20)}</strong></div>
                  <div><small>60 日平均價</small><strong className="mono">{number(data.marketSummary?.ma60)}</strong></div>
                </div>
                <p className="market-index-foot" data-testid="text-synced-index-time">
                  行情更新 {data.marketIndexQuote.asOf ? timeText(String(data.marketIndexQuote.asOf)) : "時間未提供"}
                  {data.marketSummary?.dailyCloseDate ? ` · 官方日資料截至 ${dateText(String(data.marketSummary.dailyCloseDate))}` : " · 官方大盤日線摘要暫不可用"}
                </p>
              </section>
              {!isLegacyResult && <div className="snapshot-metrics">
                <div className="metric-total"><small>掃描標的</small><strong className="mono" data-testid="text-scanned-count">{data.scannedCount.toLocaleString("zh-TW")}</strong><span>上市 / 上櫃日報</span></div>
                  <div className="metric-candidates"><small>AI 最終入選</small><strong className="mono" data-testid="text-candidate-count">{data.candidateCount}</strong><span>最多 5 檔；顯示 Tier-1／補位標籤</span></div>
                <div className="breadth-metric">
                  <small>市場漲跌家數</small>
                  <div className="breadth-values">
                    <span className="up" data-testid="text-advances"><b>{data.advances.toLocaleString("zh-TW")}</b>上漲</span>
                    <span className="down" data-testid="text-declines"><b>{data.declines.toLocaleString("zh-TW")}</b>下跌</span>
                    <span data-testid="text-unchanged"><b>{data.unchanged.toLocaleString("zh-TW")}</b>平盤</span>
                  </div>
                  <div className="breadth-track" role="img" aria-label={`市場漲跌家數：上漲 ${data.advances}，下跌 ${data.declines}，平盤 ${data.unchanged}`}>
                    <span className="breadth-up" style={{ width: `${breadthTotal ? data.advances / breadthTotal * 100 : 0}%` }} />
                    <span className="breadth-even" style={{ width: `${breadthTotal ? data.unchanged / breadthTotal * 100 : 0}%` }} />
                    <span className="breadth-down" style={{ width: `${breadthTotal ? data.declines / breadthTotal * 100 : 0}%` }} />
                  </div>
                </div>
              </div>}
              <div className="market-view">
                <span className="view-label" data-testid="label-market-view">市場觀察</span>
                <p data-testid="text-market-view">{isLegacyResult
                  ? "目前顯示的是舊版掃描結果。點選「重新篩選」可在本日重新抓取行情，依新版規則更新 pending 名單。"
                  : data.marketView}</p>
              </div>
              {!isLegacyResult && forwardValidation && (
                <div className="market-context" data-testid="panel-buy-signal-validation">
                  <strong>短線條件候選與次級候選分開標示；大盤防守日不補位</strong>
                  <p>{forwardValidation.status === "unavailable"
                    ? "AI 前瞻統計尚未提供；本名單只依策略歷史回測資格判定。"
                    : forwardValidation.hitRatePercent === null
                      ? `AI 五日方向樣本 ${forwardValidation.sampleCount} 筆；不作為本名單的勝率門檻。`
                      : `AI 五日方向實際命中 ${forwardValidation.correctCount}/${forwardValidation.sampleCount}（${forwardValidation.hitRatePercent.toFixed(1)}%）；此數字不作為本名單的勝率門檻。`}
                  </p>
                  <p>{data.probabilityDefinition} 同日目標與停損都觸及記失敗；10 日內皆未觸及不計入勝率與盈虧比分母。</p>
                </div>
              )}
              <div className="snapshot-foot">
                <span><Clock3 size={13} /> 分析完成 {timeText(data.analyzedAt)}</span>
                <span><Database size={13} /> 研究引擎 {data.aiSelectionAttempted === false ? "未執行" : data.aiProvider}</span>
                  <span className="method-note" data-testid="text-probability-definition">{isLegacyResult
                    ? "新規則：Tier-1 至少 10 筆回測、勝率至少 50%、R/R 至少 2.0；未通過時可能顯示已標記的量化補位。"
                    : data.probabilityDefinition}</span>
              </div>
            </section>

            {selectedSymbol ? (
              <AssessmentDetail
                symbol={selectedSymbol}
                pick={picks.find((pick) => pick.symbol === selectedSymbol)}
                onBack={() => setSelectedSymbol(null)}
              />
            ) : (
              <section className="candidate-section" aria-labelledby="candidate-heading" data-testid="panel-candidates">
                <div className="candidate-heading">
                  <div><p className="aipick-eyebrow">DAY-TRADE WATCH / {String(picks.length).padStart(2, "0")} NAMES</p><h2 id="candidate-heading">{data.source.includes("下一交易日") ? "下一交易日觀察清單" : data.source.includes("暫停新進場") ? "目前不建議新進場" : "短線當沖觀察名單"}</h2></div>
                  <span className="candidate-date" data-testid="text-candidate-market-date">掃描資料日：{dateText(data.marketDate)}</span>
                </div>
                {isLegacyResult && (
                  <div className="market-context" role="status" data-testid="status-legacy-scan-result">
                    目前顯示的是舊版掃描結果。點選「重新篩選」可在本日重新抓取行情，依新版規則更新 pending 名單。
                  </div>
                )}
                {data.dailyPendingChanges?.length ? (
                  <div className="market-context" data-testid="panel-pending-changes">
                    <strong>與上一個交易日相比</strong>
                    <ul>{data.dailyPendingChanges.map((change) => (
                      <li key={`${change.symbol}-${change.action}`} data-testid={`pending-change-${change.action}-${change.symbol}`}>
                        {change.action === "continued" ? "續留更新" : change.action === "removed" ? "移出" : "新增"}：{change.symbol} {change.name} — {change.detail}
                      </li>
                    ))}</ul>
                  </div>
                ) : null}
                <div className="probability-caveat" data-testid="status-probability-caveat">
                  <span className="caveat-mark">!</span><p><strong>頁面歷史回測是多日策略統計，不是當沖勝率，也不代表未來保證。</strong>{isLegacyResult
                    ? "新版 Tier-1 使用 SMC 三階段漏斗；量比 1.2–3.0、R/R 至少 2.0，回測至少 10 筆且勝率至少 50%；補位候選會另外標示。"
                    : `${data.probabilityDefinition} 日線回測自次日開盤起 10 個交易日；同日同時觸及目標與停損按失敗，未觸及不計入勝率。`}</p>
                </div>
                {picks.length > 0 ? (
                  <div className="candidate-list" data-testid="list-stock-ai-candidates">
                    {picks.map((pick, index) => <PickCard key={pick.symbol} pick={pick} rank={index + 1} onSelect={() => setSelectedSymbol(pick.symbol)} />)}
                  </div>
                ) : (
                    <div className="aipick-empty" data-testid="status-no-candidates"><div className="empty-stamp">0</div><strong>{isLegacyResult ? "新規則尚未在本交易日執行" : "本次沒有可列入的 AI 候選"}</strong><p>{isLegacyResult
                      ? "這筆仍是舊版掃描結果；按上方「重新篩選」即可立即以最新可用資料重新篩選。"
                      : `${data.marketView} ${data.marketContextNote}`}</p>{!isLegacyResult && <button type="button" onClick={() => startScan.mutate({ data: { force: true } })} disabled={picksQuery.isFetching} data-testid="button-rescan-empty">{picksQuery.isFetching ? "篩選中…" : "重新篩選"}</button>}</div>
                )}
                {picks.length === 0 && data.watchlist?.length ? (
                  <section className="unqualified-watchlist" aria-labelledby="watchlist-heading" data-testid="panel-unqualified-watchlist">
                    <div className="unqualified-watchlist-heading">
                      <div>
                        <p className="aipick-eyebrow">NOT QUALIFIED / OBSERVATION ONLY</p>
                        <h3 id="watchlist-heading">未達標觀察名單</h3>
                      </div>
                      <span>最多 {data.watchlist.length} 檔</span>
                    </div>
                    <p className="unqualified-watchlist-note">以下股票未通過現行篩選條件，僅供自行追蹤；不是 AI 合格候選，也不是進場建議。每檔標示最先未通過的關卡。</p>
                    <div className="unqualified-watchlist-list">
                      {data.watchlist.map((item) => (
                        <article className="unqualified-watchlist-item" key={item.symbol} data-testid={`watchlist-item-${item.symbol}`}>
                          <div className="unqualified-watchlist-identity">
                            <strong>{item.symbol}</strong>
                            <span>{item.name}</span>
                          </div>
                          <div className="unqualified-watchlist-price">
                            <small>參考收盤</small>
                            <strong className="mono">{number(item.referencePrice)}</strong>
                          </div>
                          <div className="unqualified-watchlist-failure">
                            <small>未通過：{watchlistStageLabel(item.failedStage)}</small>
                            <p>{item.failureReason}</p>
                            <div className="unqualified-watchlist-observation">
                              <strong>觀察內容</strong>
                              <p>{item.observation ?? "觀察後續官方資料是否達到現行條件；達標前不列入合格候選。"}</p>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}
              </section>
            )}
            <footer className="aipick-risk-footer" data-testid="status-market-risk-note">
              <ShieldCheck size={16} /><div><strong>資料與風險界線</strong><p>{data.riskNote}</p></div>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}

function watchlistStageLabel(stage: string): string {
  switch (stage) {
    case "historical_data": return "歷史資料";
    case "smc_signal": return "SMC 訊號";
    case "reward_to_risk": return "風險報酬";
    case "backtest": return "歷史回測";
    default: return "資格條件";
  }
}
