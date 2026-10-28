import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "wouter";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getGetAccountPaperTradingQueryKey,
  getGetStockAiAssessmentQueryKey,
  useGetAccountPaperTrading,
  useGetStockAiAssessment,
  usePostAccountPaperTrade,
  usePostAccountPaperTrading,
  usePostAccountPaperTradingReset,
  type StockAiAssessment,
} from "@workspace/api-client-react";
import { useAccountWatchlist } from "../components/account-watchlist";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Activity, ArrowDown, ArrowUp, Check, CircleAlert, Copy, Database, FlaskConical, LockKeyhole, RefreshCw, ShieldCheck, Sparkles, Wallet } from "lucide-react";

const money = (n: number | null | undefined) =>
  n == null ? "—" : `NT$ ${Math.round(n).toLocaleString("zh-TW")}`;
const pct = (n: number | null | undefined) =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
const dateText = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString("zh-TW") : "—";
const dateTimeText = (value: string | null | undefined) => {
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
        hour12: false,
      });
};
const assessmentPrice = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "未提供" : value.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const assessmentReferenceType = (value: StockAiAssessment["referenceType"]) =>
  value === "verified_trade" ? "已驗證成交" : "官方日收盤";
const apiError = (error: unknown, fallback: string) => {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { error?: unknown } }).data;
    if (typeof data?.error === "string") return data.error;
  }
  return fallback;
};
type PaperAccountFormValues = { startingCash: number };
type PaperTradeFormValues = {
  ticker: string;
  side: "buy" | "sell";
  shares: number;
  price: number | undefined;
};

function StockAssessmentReport({
  assessment,
  copied,
  onCopy,
}: {
  assessment: StockAiAssessment;
  copied: boolean;
  onCopy: () => void;
}) {
  const scores = assessment.scorecard;
  const scenarios = assessment.tradeScenarios;
  const scanTags = assessment.reportMarkdown
    .split("## 1.")[0]
    .split("\n")
    .filter((line) => line.startsWith("* "))
    .map((line) => line.replace(/^\* `|`$/g, ""));
  const actionLabels: Record<StockAiAssessment["action"], string> = {
    buy: "🔵 分批進場",
    hold: "🟡 續抱觀望",
    sell: "🟢 分批停利／減碼",
    wait: "⚪ 區間觀望",
    insufficient: "資料不足，暫不交易",
  };
  const scenarioRows = [
    { label: "情境一：現價自動進場", scenario: scenarios.directEntry, id: "direct" },
    { label: "情境二：回測支撐佈局", scenario: scenarios.pullbackEntry, id: "pullback" },
  ];
  const scenarioLevel = (price: number | null, percent: number | null, sign: "+" | "-") =>
    price === null
      ? "未取得"
      : `${assessmentPrice(price)} 元${percent === null ? "" : `（${sign}${percent.toFixed(1)}%）`}`;

  return (
    <article className="ql-assess-report" data-testid="result-stock-assessment">
      <header className="ql-assess-title">
        <div>
          <span className="ql-index">CURRENT EVIDENCE / {assessment.ticker}</span>
          <h3><span className="mono">{assessment.symbol}</span> 個股評估</h3>
          <p>{assessment.actionText || assessment.action} · {assessment.horizon} · 分析時間 {dateTimeText(assessment.analyzedAt)}</p>
        </div>
        <button type="button" className="ql-assess-copy" onClick={onCopy} data-testid="button-copy-assessment-report">
          {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "已複製 Markdown" : "複製 Markdown 報告"}
        </button>
      </header>
      <section className="ql-scan-tags" data-testid="panel-automated-scan-tags">
        <div className="ql-assess-section-head"><h4>0. 自動化掃描與亮點標籤</h4><small>只列有證據支持的標記</small></div>
        <div>{scanTags.map((tag) => <span key={tag}>{tag}</span>)}</div>
      </section>
      <div className="ql-assess-provenance" data-testid="panel-assessment-provenance">
        <div><span>參考價格</span><strong>{assessmentPrice(assessment.referencePrice)}</strong></div>
        <div><span>參考價格類型</span><strong>{assessmentReferenceType(assessment.referenceType)}</strong></div>
        <div><span>參考資料時間</span><strong>{dateTimeText(assessment.quoteAsOf)}</strong></div>
        <div><span>資料來源</span><strong>{assessment.source || "未提供"}</strong></div>
      </div>
      <section className="ql-trade-snapshot" data-testid="panel-trading-simulation-summary">
        <div><span>當前評估價</span><strong>{assessmentPrice(assessment.referencePrice)} 元</strong></div>
        <div><span>量化綜合得分</span><strong>{scores.earnedPoints} / 100 分</strong><small>本次可評估 {scores.availablePoints} / 100 分；缺漏不補分</small></div>
        <div><span>自動化決策訊號</span><strong>{actionLabels[assessment.action]}</strong><small>{assessmentReferenceType(assessment.referenceType)} · {dateTimeText(assessment.quoteAsOf)}</small></div>
      </section>
      <section className="ql-core-decision" data-testid="panel-core-trade-decision">
        <div><span>建議處置</span><strong data-testid="text-trade-action">{actionLabels[assessment.action]}</strong></div>
        <p data-testid="text-stock-assessment-summary">{assessment.summary}</p>
        <small>{assessment.actionText}</small>
      </section>
      <section className="ql-assess-section" aria-labelledby="ql-assessment-score-title">
        <div className="ql-assess-section-head">
          <h4 id="ql-assessment-score-title">三大維度量化診斷</h4>
          <small data-testid="text-assessment-score-total">{scores.earnedPoints} / {scores.maximumPoints} 分已得；本次可評估 {scores.availablePoints} / {scores.maximumPoints} 分</small>
        </div>
        <div className="ql-score-list" data-testid="list-assessment-scorecard">
          {scores.items.map((item) => (
            <div className="ql-score-item" key={item.id} data-testid={`item-assessment-score-${item.id}`}>
              <div className="ql-score-item-head"><span>{item.label}</span><strong>{item.points == null ? `未取得 / ${item.maximumPoints}` : `${item.points} / ${item.maximumPoints}`}</strong></div>
              {item.points != null && <div className="ql-score-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, item.points / item.maximumPoints * 100))}%` }} /></div>}
              <p>{item.points == null ? `未評分：${item.note}` : item.note}</p>
            </div>
          ))}
        </div>
        <p className="ql-assess-note" data-testid="text-assessment-score-note">{scores.note} 分數是診斷資訊，不是交易訊號；未提供項目保持未評分，不推估持股或融資數據。</p>
      </section>
      <section className="ql-assess-section" aria-labelledby="ql-assessment-scenarios-title">
        <div className="ql-assess-section-head"><h4 id="ql-assessment-scenarios-title">智慧交易策略與部位試算</h4><small>依該次評估參考價試算</small></div>
        <div className="ql-assess-provenance">
          <div><span>情境參考價</span><strong>{assessmentPrice(scenarios.referencePrice)}</strong></div>
          <div><span>20 日支撐</span><strong>{assessmentPrice(scenarios.supportPrice)}</strong></div>
          <div><span>20 日壓力</span><strong>{assessmentPrice(scenarios.resistancePrice)}</strong></div>
          <div><span>60 日深層支撐</span><strong>{assessmentPrice(scenarios.deepSupportPrice)}</strong></div>
        </div>
        <div className="ql-scenario-table-wrap">
          <table className="ql-scenario-table">
            <thead><tr><th>執行情境</th><th>建議進場價位</th><th>預估停利位</th><th>預估停損位（含 ATR 防守）</th><th>風險報酬比 (R/R)</th><th>建議建倉方式</th></tr></thead>
            <tbody>
              {scenarioRows.map(({ label, scenario, id }) => (
                <tr key={id} data-testid={`panel-assessment-scenario-${id}`}>
                  <th scope="row">{label}</th>
                  <td>{assessmentPrice(scenario.entryPrice)}</td>
                  <td>{scenarioLevel(scenario.targetPrice, scenario.profitPercent, "+")}</td>
                  <td>{scenarioLevel(scenario.stopPrice, scenario.lossPercent, "-")}</td>
                  <td>{scenario.rewardToRisk === null ? "無法計算" : `1 : ${scenario.rewardToRisk.toFixed(2)}`}</td>
                  <td>未提供單筆風險預算，不估算金額或股數</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ql-assess-note">同條件歷史勝率尚未驗證；不以其他策略回測數字替代。{assessment.pricePlanMessage}</p>
        <p className="ql-assess-note" data-testid="text-assessment-scenario-method">{scenarios.methodNote}</p>
      </section>
      <section className="ql-action-plan" data-testid="panel-trade-action-plan">
        <div className="ql-assess-section-head"><h4>自動化執行紀律與風控</h4><small>試算不會送出委託</small></div>
        <p>{assessment.actionText}</p>
        {assessment.pricePlanStatus === "available" && assessment.entryPrice !== null && assessment.stopLossPrice !== null && assessment.takeProfitPrice !== null && (
          <p className="ql-action-levels">AI 價格參考：進場 {assessmentPrice(assessment.entryPrice)} 元 · 停損 {assessmentPrice(assessment.stopLossPrice)} 元 · 目標 {assessmentPrice(assessment.takeProfitPrice)} 元</p>
        )}
        <p className="ql-risk-note"><strong>⚠️ 風險提示：</strong>{assessment.risks[0] || assessment.disclaimer}</p>
      </section>
      <p className="ql-disclaimer" data-testid="text-assessment-disclaimer">{assessment.disclaimer}</p>
    </article>
  );
}

export default function QuantLabPage() {
  const { isSignedIn, isLoading: authLoading } = useAccountWatchlist();
  const { userId: authUserId } = useAuth();
  const userScope = isSignedIn ? authUserId : null;
  const previousUserId = useRef<string | null>(userScope);
  const userScopeRef = useRef<string | null>(userScope);
  const queryClient = useQueryClient();
  const [paperFeedback, setPaperFeedback] = useState("");
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [assessmentInput, setAssessmentInput] = useState("");
  const [assessmentSymbol, setAssessmentSymbol] = useState("");
  const [assessmentRequested, setAssessmentRequested] = useState(false);
  const [assessmentFeedback, setAssessmentFeedback] = useState("");
  const [reportCopied, setReportCopied] = useState(false);
  const paperCacheKey = [
    ...getGetAccountPaperTradingQueryKey(),
    userScope ?? "signed-out",
  ] as const;
  const initializeForm = useForm<PaperAccountFormValues>({
    defaultValues: { startingCash: 1_000_000 },
  });
  const tradeForm = useForm<PaperTradeFormValues>({
    defaultValues: { ticker: "", side: "buy", shares: 1000, price: undefined },
  });
  const assessmentQuery = useGetStockAiAssessment(
    { symbol: assessmentSymbol },
    {
      query: {
        enabled: assessmentRequested && Boolean(assessmentSymbol),
        queryKey: getGetStockAiAssessmentQueryKey({ symbol: assessmentSymbol }),
        staleTime: 60_000,
      },
      request: { credentials: "include" },
    },
  );

  const portfolio = useGetAccountPaperTrading({
    query: {
      queryKey: paperCacheKey,
      enabled: isSignedIn,
    },
    request: { credentials: "include" },
  });
  const initializeMutation = usePostAccountPaperTrading({ request: { credentials: "include" } });
  const resetPortfolioMutation = usePostAccountPaperTradingReset({
    request: { credentials: "include" },
  });
  const tradeMutation = usePostAccountPaperTrade({ request: { credentials: "include" } });

  useEffect(() => {
    if (previousUserId.current !== userScope) {
      const paperKey = String(getGetAccountPaperTradingQueryKey()[0]);
      queryClient.removeQueries({
        predicate: (query) => {
          const key = String(query.queryKey[0] ?? "");
          return key === paperKey;
        },
      });
      setPaperFeedback("");
      setAssessmentInput("");
      setAssessmentSymbol("");
      setAssessmentRequested(false);
      setAssessmentFeedback("");
      setReportCopied(false);
      setResetDialogOpen(false);
      initializeForm.reset();
      tradeForm.reset();
      initializeMutation.reset();
      resetPortfolioMutation.reset();
      tradeMutation.reset();
    }
    previousUserId.current = userScope;
    userScopeRef.current = userScope;
  }, [userScope, queryClient]);

  const updatePortfolio = (data: NonNullable<typeof portfolio.data>) => {
    queryClient.setQueryData(paperCacheKey, data);
    void queryClient.invalidateQueries({ queryKey: paperCacheKey });
  };

  const initializePortfolio = initializeForm.handleSubmit((values) => {
    setPaperFeedback("");
    initializeMutation.mutate(
      { data: { startingCash: Number(values.startingCash) } },
      {
        onSuccess: (data) => {
          if (userScopeRef.current !== userScope) return;
          updatePortfolio(data);
          setPaperFeedback("模擬帳戶已建立。");
        },
        onError: (error) => setPaperFeedback(apiError(error, "帳戶建立失敗，請重試。")),
      },
    );
  });

  const recordTrade = tradeForm.handleSubmit((values) => {
    setPaperFeedback("");
    const normalized = values.ticker.trim().toUpperCase();
    const fullTicker = /\.(TW|TWO)$/.test(normalized) ? normalized : `${normalized}.TW`;
    tradeMutation.mutate(
      { data: {
        ticker: fullTicker,
        side: values.side,
        shares: Number(values.shares),
        price: Number(values.price),
      } },
      {
        onSuccess: (data) => {
          if (userScopeRef.current !== userScope) return;
          updatePortfolio(data);
          setPaperFeedback(`${values.side === "buy" ? "買進" : "賣出"}模擬交易已記錄，成交價依你輸入的價格計算。`);
        },
        onError: (error) => setPaperFeedback(apiError(error, "交易未能記錄，請檢查代碼、股數與持倉。")),
      },
    );
  });

  const resetPaperPortfolio = () => {
    setPaperFeedback("");
    resetPortfolioMutation.mutate(undefined, {
      onSuccess: (data) => {
        if (userScopeRef.current !== userScope) return;
        updatePortfolio(data);
        tradeForm.reset();
        setResetDialogOpen(false);
        setPaperFeedback("已清空紙上持倉與交易紀錄，現金已恢復至起始本金。");
      },
      onError: (error) =>
        setPaperFeedback(apiError(error, "紙上帳戶重設失敗，請重試。")),
    });
  };

  return (
    <div className="ql-root">
      <style>{`
        .ql-root{grid-column:2;grid-row:1 / span 2;width:100%;max-width:100%;min-width:0;min-height:100dvh;justify-self:stretch;box-sizing:border-box}
        @media(max-width:760px){.ql-root{grid-column:1 / -1;grid-row:2 / span 2}}
        .ql-main{width:100%;max-width:100%;min-width:0;box-sizing:border-box;padding:30px clamp(18px,4vw,56px) 60px;background:radial-gradient(ellipse at 83% 0%,rgba(125,177,245,.2),transparent 34%),hsl(var(--background))}
        .ql-wrap{width:100%;max-width:1380px;min-width:0;box-sizing:border-box;margin:auto}
        .ql-kicker{display:flex;align-items:center;gap:9px;color:hsl(var(--primary));font:700 10px var(--app-font-mono);letter-spacing:.15em;text-transform:uppercase}
        .ql-head{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin:15px 0 26px}
        .ql-head h1{font-size:clamp(34px,5vw,54px);line-height:1.04;letter-spacing:-.055em;margin:0;font-weight:700}
        .ql-head p{margin:10px 0 0;color:hsl(var(--muted-foreground));font-size:13px;max-width:570px;line-height:1.65}
        .ql-mark{flex:0 0 auto;width:76px;height:76px;display:grid;place-items:center;border:1px solid hsl(var(--primary)/.32);color:hsl(var(--primary));background:linear-gradient(145deg,hsl(var(--primary)/.12),transparent);transform:rotate(45deg)}
        .ql-mark svg{transform:rotate(-45deg)}
        .ql-boundary{display:flex;align-items:flex-start;gap:11px;padding:13px 16px;border:1px solid hsl(var(--primary)/.25);border-left:3px solid hsl(var(--primary));background:hsl(var(--primary)/.055);color:hsl(var(--foreground));font-size:11px;line-height:1.6;margin-bottom:23px}
        .ql-boundary svg{color:hsl(var(--primary));flex:0 0 auto;margin-top:1px}
        .ql-assessment{margin:0 0 20px;border:1px solid hsl(var(--border));background:linear-gradient(120deg,hsl(var(--secondary)/.28),hsl(var(--card)/.8))}
        .ql-assessment-form{display:flex;gap:9px;align-items:flex-end;padding:15px 18px}
        .ql-assessment-form label{display:grid;gap:6px;flex:1;color:hsl(var(--foreground));font-size:11px;font-weight:700}
        .ql-assessment-form input{width:100%;min-height:40px;box-sizing:border-box;padding:8px 10px;border:1px solid hsl(var(--input));background:hsl(var(--background));color:hsl(var(--foreground));font:12px var(--app-font-mono)}
        .ql-assess-button{min-height:40px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid hsl(var(--primary));background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-size:11px;font-weight:700;white-space:nowrap}
        .ql-assess-button:disabled{opacity:.55;cursor:not-allowed}
        .ql-assess-result{padding:0 18px 18px}
        .ql-assess-loading{display:grid;gap:8px;padding:8px 0}
        .ql-assess-loading i{height:12px;background:linear-gradient(90deg,hsl(var(--muted)),hsl(var(--card)),hsl(var(--muted)));background-size:200% 100%;animation:ql-shimmer 1.4s ease-in-out infinite}
        .ql-assess-error{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px;color:hsl(var(--destructive));border:1px solid hsl(var(--destructive)/.25);font-size:11px}
        .ql-assess-report{border-top:1px solid hsl(var(--border));padding-top:15px}
        .ql-assess-title{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
        .ql-scan-tags{margin:12px 0;padding:11px 12px;border:1px solid hsl(var(--primary)/.24);background:hsl(var(--primary)/.045)}
        .ql-scan-tags>div:last-child{display:flex;flex-wrap:wrap;gap:7px}
        .ql-scan-tags>div:last-child span{padding:5px 8px;border:1px solid hsl(var(--border));background:hsl(var(--card));font-size:10px;line-height:1.4}
        .ql-assess-title h3{margin:3px 0;font-size:18px;letter-spacing:-.03em}
        .ql-assess-title p{margin:0;color:hsl(var(--muted-foreground));font-size:10px;line-height:1.5}
        .ql-assess-copy{flex:0 0 auto;min-height:34px;padding:0 10px;display:inline-flex;align-items:center;gap:7px;border:1px solid hsl(var(--border));background:hsl(var(--card));color:hsl(var(--foreground));font-size:10px}
        .ql-assess-provenance{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid hsl(var(--border));margin:12px 0}
        .ql-assess-provenance div{min-width:0;padding:9px 11px;border-right:1px solid hsl(var(--border))}
        .ql-assess-provenance div:last-child{border-right:0}
        .ql-assess-provenance span,.ql-assess-provenance strong{display:block;overflow-wrap:anywhere}
        .ql-assess-provenance span{color:hsl(var(--muted-foreground));font-size:9px}
        .ql-assess-provenance strong{margin-top:5px;font:600 11px var(--app-font-mono)}
        .ql-assess-summary{margin:0;padding:12px;border-left:2px solid hsl(var(--primary));background:hsl(var(--primary)/.055);font-size:11px;line-height:1.65}
        .ql-trade-snapshot{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;margin:12px 0;background:hsl(var(--border));border:1px solid hsl(var(--border))}
        .ql-trade-snapshot>div{min-width:0;padding:11px;background:hsl(var(--card))}
        .ql-trade-snapshot span,.ql-trade-snapshot strong,.ql-trade-snapshot small{display:block}
        .ql-trade-snapshot span{color:hsl(var(--muted-foreground));font-size:9px}
        .ql-trade-snapshot strong{margin-top:6px;font-size:12px;overflow-wrap:anywhere}
        .ql-trade-snapshot small{margin-top:4px;color:hsl(var(--muted-foreground));font-size:9px;line-height:1.45}
        .ql-rr-good{color:hsl(145 55% 38%)}
        .ql-rr-caution{color:hsl(38 85% 42%)}
        .ql-rr-risk{color:hsl(var(--destructive))}
        .ql-rr-neutral{color:hsl(var(--muted-foreground))}
        .ql-core-decision{margin:12px 0;padding:12px;border:1px solid hsl(var(--primary)/.28);border-left:3px solid hsl(var(--primary));background:hsl(var(--primary)/.055)}
        .ql-core-decision>div{display:flex;align-items:center;gap:10px}
        .ql-core-decision>div span{color:hsl(var(--muted-foreground));font-size:9px}
        .ql-core-decision>div strong{font-size:12px}
        .ql-core-decision p{margin:8px 0 0;font-size:11px;line-height:1.65}
        .ql-core-decision small{display:block;margin-top:7px;color:hsl(var(--muted-foreground));font-size:9px;line-height:1.55}
        .ql-assess-section{margin-top:14px}
        .ql-assess-section-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:8px}
        .ql-assess-section h4{margin:0;font-size:12px}
        .ql-assess-section-head small,.ql-assess-note{color:hsl(var(--muted-foreground));font-size:9px;line-height:1.55}
        .ql-score-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
        .ql-score-item{padding:9px 10px;border:1px solid hsl(var(--border));background:hsl(var(--card)/.6)}
        .ql-score-item-head{display:flex;justify-content:space-between;gap:10px;font-size:10px}
        .ql-score-item-head strong{font:600 10px var(--app-font-mono);white-space:nowrap}
        .ql-score-item p{margin:5px 0 0;color:hsl(var(--muted-foreground));font-size:9px;line-height:1.5}
        .ql-score-track{height:3px;margin-top:7px;background:hsl(var(--muted))}
        .ql-score-track span{display:block;height:100%;background:hsl(var(--primary))}
        .ql-scenario-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
        .ql-scenario{padding:12px;border:1px solid hsl(var(--border));background:hsl(var(--card)/.55)}
        .ql-scenario h5{margin:0 0 9px;font-size:11px}
        .ql-scenario dl{display:grid;grid-template-columns:1fr auto;gap:6px 10px;margin:0;font-size:10px}
        .ql-scenario dt{color:hsl(var(--muted-foreground))}
        .ql-scenario dd{margin:0;font:600 10px var(--app-font-mono);text-align:right}
        .ql-scenario-table-wrap{max-width:100%;overflow-x:auto;border:1px solid hsl(var(--border))}
        .ql-scenario-table{width:100%;min-width:700px;border-collapse:collapse;text-align:left}
        .ql-scenario-table th,.ql-scenario-table td{padding:10px 11px;border-bottom:1px solid hsl(var(--border));font-size:10px;vertical-align:top}
        .ql-scenario-table thead th{background:hsl(var(--secondary)/.42);color:hsl(var(--muted-foreground));font-size:9px;white-space:nowrap}
        .ql-scenario-table tbody th{font-weight:700}
        .ql-scenario-table td{font:600 10px var(--app-font-mono);white-space:nowrap}
        .ql-scenario-table tr:last-child th,.ql-scenario-table tr:last-child td{border-bottom:0}
        .ql-action-plan{margin-top:14px;padding:12px;border:1px solid hsl(var(--border));background:hsl(var(--card)/.55)}
        .ql-action-plan p{margin:7px 0 0;font-size:10px;line-height:1.6}
        .ql-action-plan .ql-action-levels{padding:8px 10px;border-left:2px solid hsl(var(--primary));background:hsl(var(--primary)/.05);font-family:var(--app-font-mono)}
        .ql-action-plan .ql-risk-note{margin-top:10px;color:hsl(var(--destructive))}
        .ql-disclaimer{margin-top:12px;padding:10px 12px;border:1px solid hsl(var(--accent)/.45);background:hsl(var(--accent)/.11);font-size:10px;line-height:1.6}
        .ql-workflow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0 0 13px;border:1px solid hsl(var(--border))}
        .ql-workflow span{padding:8px 9px;color:hsl(var(--muted-foreground));font-size:9px;border-right:1px solid hsl(var(--border))}
        .ql-workflow span:last-child{border-right:0}
        .ql-workflow b{margin-right:5px;color:hsl(var(--primary));font:10px var(--app-font-mono)}
        .ql-risk-scan{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;border:1px solid hsl(var(--border));background:hsl(var(--border))}
        .ql-risk-scan>div{min-width:0;padding:10px;background:hsl(var(--card))}
        .ql-risk-scan span{display:block;color:hsl(var(--muted-foreground));font-size:9px}
        .ql-risk-scan strong{display:block;margin-top:6px;font:700 13px var(--app-font-mono);overflow-wrap:anywhere}
        .ql-risk-scan small{display:block;margin-top:4px;color:hsl(var(--muted-foreground));font-size:9px;line-height:1.4}
        .ql-grid{display:grid;grid-template-columns:minmax(290px,.8fr) minmax(0,1.65fr);gap:18px;align-items:start;min-width:0}
        .ql-left-stack{display:grid;gap:18px;min-width:0}
        .ql-panel{min-width:0;border:1px solid var(--glass-edge, hsl(var(--border)));border-radius:19px;background:linear-gradient(145deg,rgba(255,255,255,.56),rgba(255,255,255,.08) 62%),var(--glass-surface,hsl(var(--card)/.88));box-shadow:var(--glass-shadow,0 8px 24px hsl(var(--foreground)/.025)),inset 0 1px 0 rgba(255,255,255,.72);backdrop-filter:blur(24px) saturate(1.45);-webkit-backdrop-filter:blur(24px) saturate(1.45)}
        .ql-panel-head{padding:17px 19px 14px;border-bottom:1px solid hsl(var(--border)/.75);display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
        .ql-panel-head>div:first-child{min-width:0}
        .ql-panel-head h2{font-size:15px;margin:4px 0 0;letter-spacing:-.02em}
        .ql-panel-head p{font-size:10px;color:hsl(var(--muted-foreground));margin:5px 0 0;line-height:1.5}
        .ql-index{font:10px var(--app-font-mono);color:hsl(var(--primary));letter-spacing:.1em}
        .ql-body{padding:18px 19px}
        .ql-form{display:grid;gap:15px}
        .ql-label,.ql-form label{font-size:11px;font-weight:700;color:hsl(var(--foreground))}
        .ql-control{width:100%;max-width:100%;min-width:0;box-sizing:border-box;margin-top:7px;border:1px solid hsl(var(--input));background:hsl(var(--background));color:hsl(var(--foreground));border-radius:3px;min-height:39px;padding:8px 10px;font:12px var(--app-font-sans)}
        .ql-control:focus{outline:2px solid hsl(var(--primary)/.35);border-color:hsl(var(--primary))}
        .ql-control.textarea{min-height:102px;resize:vertical;line-height:1.55}
        .ql-form small{color:hsl(var(--muted-foreground));font-size:10px}
        .ql-form-help{display:block;margin-top:6px;color:hsl(var(--muted-foreground));font-size:10px;line-height:1.5}
        .ql-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;min-width:0}
        .ql-button{width:100%;min-height:42px;display:flex;align-items:center;justify-content:center;gap:9px;border:1px solid hsl(var(--primary));background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-size:12px;font-weight:750;transition:transform .18s,opacity .18s}
        .ql-button:hover:not(:disabled){transform:translateY(-1px);opacity:.92}
        .ql-button:disabled{opacity:.55;cursor:not-allowed}
        .ql-spin{animation:ql-spin .85s linear infinite}
        @keyframes ql-spin{to{transform:rotate(360deg)}}
        .ql-progress-backdrop{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:18px;background:hsl(220 28% 10%/.62);backdrop-filter:blur(3px)}
        .ql-progress-dialog{width:min(620px,100%);max-height:min(720px,calc(100dvh - 36px));display:flex;flex-direction:column;overflow:hidden;border:1px solid hsl(var(--primary)/.42);background:hsl(var(--card));color:hsl(var(--foreground));box-shadow:0 24px 80px hsl(220 35% 5%/.28)}
        .ql-progress-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:17px 19px 14px;border-bottom:1px solid hsl(var(--border))}
        .ql-progress-title{display:flex;align-items:center;gap:10px}
        .ql-progress-title svg{flex:0 0 auto;color:hsl(var(--primary))}
        .ql-progress-title h2{margin:0;font-size:15px}
        .ql-progress-head p{margin:7px 0 0;color:hsl(var(--muted-foreground));font-size:10px;line-height:1.55}
        .ql-progress-elapsed{flex:0 0 auto;color:hsl(var(--muted-foreground));font:10px var(--app-font-mono);white-space:nowrap}
        .ql-progress-body{display:grid;gap:10px;min-height:0;padding:15px 19px}
        .ql-progress-caption{display:flex;justify-content:space-between;gap:12px;color:hsl(var(--muted-foreground));font-size:10px}
        .ql-progress-caption strong{color:hsl(var(--foreground));font-weight:650}
        .ql-progress-track{height:5px;overflow:hidden;background:hsl(var(--muted))}
        .ql-progress-fill{height:100%;background:hsl(var(--primary));transition:width .25s ease}
        .ql-progress-fill.indeterminate{width:32%;animation:ql-progress-sweep 1.2s ease-in-out infinite alternate}
        @keyframes ql-progress-sweep{from{transform:translateX(0)}to{transform:translateX(210%)}}
        .ql-progress-log{min-height:150px;max-height:290px;overflow:auto;padding:10px;background:hsl(var(--background));border:1px solid hsl(var(--border));font:10px/1.55 var(--app-font-mono)}
        .ql-progress-entry{display:grid;grid-template-columns:58px 92px minmax(0,1fr);gap:8px;padding:4px 0;border-bottom:1px solid hsl(var(--border)/.55);overflow-wrap:anywhere}
        .ql-progress-entry:last-child{border-bottom:0}
        .ql-progress-time{color:hsl(var(--muted-foreground))}
        .ql-progress-entry strong{color:hsl(var(--primary));font-weight:650}
        .ql-progress-entry p{margin:0;color:hsl(var(--foreground))}
        .ql-progress-error{padding:10px 12px;border-left:2px solid hsl(var(--destructive));background:hsl(var(--destructive)/.08);color:hsl(var(--destructive));font-size:11px;line-height:1.55}
        .ql-progress-footer{display:flex;justify-content:flex-end;gap:8px;padding:0 19px 17px}
        .ql-progress-retry{min-height:36px;padding:0 14px;border:1px solid hsl(var(--primary));background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-size:11px;font-weight:650}
        .ql-progress-retry:disabled{opacity:.5;cursor:not-allowed}
        .ql-progress-close{min-width:100px;min-height:36px;padding:0 14px;border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));font-size:11px;font-weight:650}
        .ql-progress-close:disabled{opacity:.5;cursor:not-allowed}
        .ql-feedback{font-size:11px;line-height:1.5;padding:10px 12px;background:hsl(var(--secondary)/.32);border-left:2px solid hsl(var(--secondary-foreground));color:hsl(var(--foreground))}
        .ql-feedback.error{color:hsl(var(--destructive));background:hsl(var(--destructive)/.07);border-color:hsl(var(--destructive))}
        .ql-runlist{display:grid;gap:6px;max-height:210px;overflow:auto}
        .ql-run{width:100%;text-align:left;padding:9px 10px;border:1px solid hsl(var(--border));background:transparent;color:hsl(var(--foreground));display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 12px;font-size:11px}
        .ql-run.active{border-color:hsl(var(--primary)/.55);background:hsl(var(--primary)/.06)}
        .ql-run strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
        .ql-run small{color:hsl(var(--muted-foreground));font:10px var(--app-font-mono)}
        .ql-run em{grid-column:1/-1;color:hsl(var(--muted-foreground));font:10px var(--app-font-mono);font-style:normal}
        .ql-state{padding:23px 12px;text-align:center;color:hsl(var(--muted-foreground));font-size:11px;line-height:1.6}
        .ql-state svg{display:block;margin:0 auto 9px;color:hsl(var(--primary))}
        .ql-loading{display:grid;gap:9px;padding:18px 4px}
        .ql-loading i{height:10px;background:linear-gradient(90deg,hsl(var(--muted)),hsl(var(--card)),hsl(var(--muted)));background-size:200% 100%;animation:ql-shimmer 1.4s ease-in-out infinite}
        @keyframes ql-shimmer{to{background-position:-200% 0}}
        .ql-result{display:grid;gap:16px}
        .ql-result-title{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
        .ql-result-title h2{font-size:18px;margin:0;line-height:1.35}
        .ql-result-title small{font:10px var(--app-font-mono);color:hsl(var(--muted-foreground));white-space:nowrap}
        .ql-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid hsl(var(--border))}
        .ql-metric{padding:12px 13px;min-width:0;border-right:1px solid hsl(var(--border));border-bottom:1px solid hsl(var(--border))}
        .ql-metric:nth-child(4n){border-right:0}
        .ql-metric:nth-child(n+5){border-bottom:0}
        .ql-metric span{display:block;color:hsl(var(--muted-foreground));font-size:10px}
        .ql-metric strong{display:block;margin-top:7px;font:700 clamp(13px,1.5vw,18px) var(--app-font-mono);white-space:nowrap}
        .ql-primary-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}
        .ql-secondary-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}
        .ql-secondary-metrics .ql-metric:nth-child(3n){border-right:0}
        .ql-secondary-metrics .ql-metric:nth-child(4n){border-right:1px solid hsl(var(--border))}
        .ql-secondary-metrics .ql-metric:nth-child(n+4){border-bottom:0}
        .ql-details{border:1px solid hsl(var(--border));background:hsl(var(--card)/.45)}
        .ql-details>summary{cursor:pointer;list-style:none;padding:12px 14px;color:hsl(var(--foreground));font-size:11px;font-weight:700}
        .ql-details>summary::-webkit-details-marker{display:none}
        .ql-details>summary:after{content:"＋";float:right;color:hsl(var(--primary));font-size:13px}
        .ql-details[open]>summary:after{content:"－"}
        .ql-details[open]>summary{border-bottom:1px solid hsl(var(--border))}
        .ql-details-content{display:grid;gap:14px;padding:14px}
        .ql-trade-explainer{padding:10px 12px;border-left:2px solid hsl(var(--primary));background:hsl(var(--primary)/.06);color:hsl(var(--muted-foreground));font-size:10px;line-height:1.6}
        .ql-ai-summary{display:grid;gap:10px;padding:16px;border:1px solid hsl(var(--primary)/.28);background:linear-gradient(135deg,hsl(var(--primary)/.08),hsl(var(--card)/.7))}
        .ql-ai-summary-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
        .ql-ai-summary-head h3{display:flex;align-items:center;gap:8px;margin:0;font-size:13px}
        .ql-ai-summary-head h3 svg{color:hsl(var(--primary))}
        .ql-ai-summary-head small,.ql-ai-summary-disclaimer{color:hsl(var(--muted-foreground));font-size:9px;line-height:1.55}
        .ql-ai-summary>p{display:flex;align-items:center;gap:7px;margin:0;font-size:12px;line-height:1.75}
        .ql-ai-summary-error{display:grid;justify-items:start;gap:8px;color:hsl(var(--muted-foreground));font-size:11px;line-height:1.6}
        .ql-summary-retry{border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));padding:7px 10px;font-size:10px;font-weight:650}
        .ql-summary-retry:disabled{opacity:.5;cursor:not-allowed}
        .ql-up{color:hsl(8 70% 48%)}
        .ql-down{color:hsl(155 42% 40%)}
        .ql-chart{height:270px;width:100%;margin:4px 0}
        .ql-source{display:flex;gap:8px;align-items:flex-start;color:hsl(var(--muted-foreground));font-size:10px;line-height:1.6;padding:11px;background:hsl(var(--secondary)/.2);overflow-wrap:anywhere}
        .ql-source svg{color:hsl(var(--secondary-foreground));flex:0 0 auto}
        .ql-weights{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
        .ql-weight{padding:10px;border:1px solid hsl(var(--border));background:hsl(var(--background))}
        .ql-weight span{display:block;color:hsl(var(--muted-foreground));font-size:9px}
        .ql-weight strong{font:700 13px var(--app-font-mono);display:block;margin-top:5px}
        .ql-signal-rules{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
        .ql-signal-card{min-width:0;padding:12px;border:1px solid hsl(var(--border));background:hsl(var(--background))}
        .ql-signal-card.entry{border-left:3px solid hsl(12 76% 52%)}
        .ql-signal-card.exit{border-left:3px solid hsl(155 42% 40%)}
        .ql-signal-card span{display:block;margin-bottom:7px;color:hsl(var(--muted-foreground));font-size:10px;font-weight:700}
        .ql-signal-card p{margin:0;font-size:11px;line-height:1.65;overflow-wrap:anywhere}
        .ql-signal-note{grid-column:1/-1;margin:0;color:hsl(var(--muted-foreground));font-size:10px;line-height:1.6}
        .ql-table-wrap{overflow:auto}
        .ql-table{width:100%;border-collapse:collapse;font-size:10px;white-space:nowrap}
        .ql-table th{text-align:left;color:hsl(var(--muted-foreground));font-size:9px;font-weight:600;padding:9px 8px;border-bottom:1px solid hsl(var(--border))}
        .ql-table td{padding:9px 8px;border-bottom:1px solid hsl(var(--border)/.65);font-family:var(--app-font-mono)}
        .ql-table td:first-child{font-family:var(--app-font-sans);font-weight:600}
        .ql-subhead{display:flex;justify-content:space-between;align-items:center;gap:10px}
        .ql-subhead h3{font-size:12px;margin:0}
        .ql-subhead small{font:10px var(--app-font-mono);color:hsl(var(--muted-foreground))}
        .ql-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:18px;min-width:0}
        .ql-columns>*{min-width:0}
        .ql-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid hsl(var(--border));min-width:0}
        .ql-summary div{min-width:0;padding:14px 15px;border-right:1px solid hsl(var(--border))}
        .ql-summary div:last-child{border:0}
        .ql-summary span{display:block;color:hsl(var(--muted-foreground));font-size:9px}
        .ql-summary strong{display:block;margin-top:6px;font:700 14px var(--app-font-mono);overflow-wrap:anywhere}
        .ql-paper-content{width:100%;min-width:0;box-sizing:border-box;padding:16px}
        .ql-position{display:grid;grid-template-columns:minmax(0,1fr) auto;min-width:0;gap:10px;padding:10px 0;border-bottom:1px solid hsl(var(--border)/.7);font-size:10px}
        .ql-position:last-child{border:0}
        .ql-position>div{min-width:0}
        .ql-position>div:last-child{max-width:48%;overflow-wrap:anywhere}
        .ql-position strong{display:block;font:700 11px var(--app-font-mono)}
        .ql-position small{display:block;color:hsl(var(--muted-foreground));font-size:9px;overflow-wrap:anywhere}
        .ql-trade-form{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.7fr) minmax(0,.7fr) minmax(0,.9fr) auto;gap:8px;align-items:end;margin-top:14px;width:100%;min-width:0}
        .ql-trade-form>*{min-width:0}
        .ql-init-form{grid-template-columns:minmax(0,1fr) auto}
        .ql-trade-form .ql-control{min-height:36px}
        .ql-trade-form .ql-button{min-height:36px;padding:0 13px;white-space:nowrap}
        .ql-panel-actions{display:flex;align-items:center;gap:10px}
        .ql-reset-button{display:inline-flex;align-items:center;gap:5px;border:1px solid hsl(var(--border));background:transparent;color:hsl(var(--muted-foreground));padding:6px 8px;font-size:9px;white-space:nowrap}
        .ql-reset-button:hover:not(:disabled){color:hsl(var(--destructive));border-color:hsl(var(--destructive)/.5)}
        .ql-reset-button:disabled{opacity:.5;cursor:not-allowed}
        .ql-reset-backdrop{position:fixed;inset:0;z-index:1300;display:grid;place-items:center;padding:16px;background:hsl(220 28% 10%/.62);backdrop-filter:blur(3px)}
        .ql-reset-dialog{width:min(440px,100%);padding:20px;border:1px solid hsl(var(--destructive)/.4);background:hsl(var(--card));color:hsl(var(--foreground));box-shadow:0 24px 80px hsl(220 35% 5%/.28)}
        .ql-reset-dialog h2{margin:0 0 10px;font-size:16px}
        .ql-reset-dialog p{margin:0;color:hsl(var(--muted-foreground));font-size:11px;line-height:1.7}
        .ql-reset-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:18px}
        .ql-reset-cancel{min-height:42px;border:1px solid hsl(var(--border));background:transparent;color:hsl(var(--foreground));font-size:11px;font-weight:650}
        .ql-warning{margin:14px 0 0;padding:11px 13px;border:1px solid hsl(var(--accent)/.5);background:hsl(var(--accent)/.13);font-size:10px;color:hsl(var(--foreground));line-height:1.55}
        .ql-warning strong{display:block;margin-bottom:3px}
        @media(max-width:680px){.ql-result-title small{white-space:normal;overflow-wrap:anywhere}.ql-signal-rules{grid-template-columns:1fr}.ql-assess-form{align-items:stretch}.ql-assessment-form{flex-direction:column;align-items:stretch}.ql-assess-provenance{grid-template-columns:repeat(2,minmax(0,1fr))}.ql-assess-provenance div:nth-child(2){border-right:0}.ql-assess-provenance div:nth-child(-n+2){border-bottom:1px solid hsl(var(--border))}.ql-score-list,.ql-scenario-grid{grid-template-columns:1fr}.ql-trade-snapshot{grid-template-columns:1fr}.ql-risk-scan{grid-template-columns:repeat(2,minmax(0,1fr))}.ql-assess-title{flex-direction:column}}
        .ql-auth{max-width:600px;margin:64px auto;padding:38px;text-align:center}
        .ql-auth svg{color:hsl(var(--primary))}
        .ql-auth h2{font-size:20px;margin:14px 0 8px}
        .ql-auth p{color:hsl(var(--muted-foreground));font-size:12px;line-height:1.65}
        .ql-auth a{display:inline-flex;margin-top:12px;padding:10px 16px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));text-decoration:none;font-size:12px;font-weight:700}
        @media(max-width:1100px){.ql-grid{grid-template-columns:minmax(0,1fr)}.ql-columns{grid-template-columns:minmax(0,1fr)}}
        @media(max-width:680px){.ql-main{padding:22px 14px 44px}.ql-head{align-items:flex-start}.ql-mark{width:50px;height:50px}.ql-head h1{font-size:37px}.ql-two{grid-template-columns:minmax(0,1fr)}.ql-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.ql-metric:nth-child(2n){border-right:0}.ql-metric:nth-child(4n){border-right:0}.ql-metric:nth-child(n+5){border-bottom:1px solid hsl(var(--border))}.ql-metric:nth-child(n+7){border-bottom:0}.ql-weights{grid-template-columns:repeat(2,1fr)}.ql-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.ql-summary div:nth-child(2){border-right:0}.ql-summary div:nth-child(-n+2){border-bottom:1px solid hsl(var(--border))}.ql-trade-form{grid-template-columns:repeat(2,minmax(0,1fr))}.ql-trade-form .ticker-cell{grid-column:span 2}.ql-trade-form .ql-button{grid-column:span 2}.ql-result-title{display:block}.ql-result-title small{display:block;margin-top:7px}.ql-chart{height:230px}}
        @media(max-width:520px){.ql-progress-backdrop{padding:10px}.ql-progress-dialog{max-height:calc(100dvh - 20px)}.ql-progress-head,.ql-progress-body{padding-left:13px;padding-right:13px}.ql-progress-footer{padding-left:13px;padding-right:13px}.ql-progress-entry{grid-template-columns:52px minmax(0,1fr);gap:4px 8px}.ql-progress-entry strong{grid-column:2}.ql-progress-entry p{grid-column:1/-1;padding-left:60px}.ql-progress-log{max-height:40dvh}}
        @media(max-width:680px){.ql-primary-metrics .ql-metric:nth-child(n+3){border-bottom:0}.ql-secondary-metrics .ql-metric:nth-child(n+5){border-bottom:0}.ql-trade-form .ticker-cell,.ql-trade-form .price-cell{grid-column:span 2}.ql-trade-form .ql-button{grid-column:span 2}.ql-details-content{padding:10px}.ql-reset-actions{grid-template-columns:1fr}.ql-ai-summary-head{align-items:flex-start;flex-direction:column}}
      `}</style>
      <main className="ql-main">
        <div className="ql-wrap">
          <div className="ql-kicker"><FlaskConical size={14} /> TAIWAN EQUITY RESEARCH / 01</div>
          <header className="ql-head">
            <div>
              <h1>量化研究室</h1>
              <p>使用官方市場資料查看單一股票量化評估，並管理不涉及真實下單的紙上投資組合。</p>
            </div>
            <div className="ql-mark" aria-hidden="true"><Activity size={28} /></div>
          </header>

          <div className="ql-boundary" data-testid="notice-paper-only">
            <ShieldCheck size={17} />
            <span><strong>僅供參考與模擬。</strong>本頁不會送出真實委託；個股評估依其資料來源與更新時間，紙上投資組合則依你輸入的模擬成交價記錄。</span>
          </div>

          {authLoading ? (
            <section className="ql-panel ql-auth" role="status" data-testid="status-auth-loading">
              <div className="ql-loading"><i /><i /><i /></div>正在確認會員登入狀態
            </section>
          ) : !isSignedIn ? (
            <section className="ql-panel ql-auth" data-testid="panel-sign-in-required">
              <LockKeyhole size={28} />
              <h2>研究室僅供受邀會員使用</h2>
              <p>登入後即可查看單一股票量化評估，並記錄不涉及真實下單的紙上交易。</p>
              <Link href="/sign-in" data-testid="link-quant-sign-in">登入會員</Link>
            </section>
          ) : (
            <>
              <section className="ql-panel ql-assessment" aria-labelledby="ql-stock-assessment-title" data-testid="panel-single-stock-assessment">
                <div className="ql-panel-head">
                  <div><span className="ql-index">LIVE ASSESSMENT / ON DEMAND</span><h2 id="ql-stock-assessment-title">單一股票量化評估</h2><p>按下評估後才呼叫分析服務；結果反映目前可取得的市場證據。</p></div>
                  <Activity size={17} aria-hidden="true" />
                </div>
                <form className="ql-assessment-form" onSubmit={(event) => {
                  event.preventDefault();
                  const symbol = assessmentInput.trim().toUpperCase();
                  setReportCopied(false);
                  if (!/^[A-Z0-9]{4,6}(?:\.(?:TW|TWO))?$/.test(symbol)) {
                    setAssessmentFeedback("請輸入 4 至 6 位英數代碼，可加上 .TW 或 .TWO。");
                    return;
                  }
                  setAssessmentFeedback("");
                  if (assessmentRequested && symbol === assessmentSymbol) {
                    void assessmentQuery.refetch();
                    return;
                  }
                  setAssessmentSymbol(symbol);
                  setAssessmentRequested(true);
                }} data-testid="form-single-stock-assessment">
                  <label htmlFor="ql-assessment-symbol">股票代碼
                    <input id="ql-assessment-symbol" value={assessmentInput} onChange={(event) => setAssessmentInput(event.target.value)} placeholder="2330.TW" autoComplete="off" aria-describedby="ql-assessment-help" data-testid="input-assessment-symbol" />
                    <small id="ql-assessment-help" className="ql-form-help">代碼格式：4–6 位英數，可選 .TW / .TWO。沒有後綴時依服務既有規則判讀。</small>
                  </label>
                  <button className="ql-assess-button" type="submit" disabled={assessmentQuery.isFetching} data-testid="button-request-stock-assessment">
                    {assessmentQuery.isFetching ? <><RefreshCw className="ql-spin" size={14} />正在取得證據</> : <><Activity size={14} />{assessmentRequested ? "重新評估" : "評估此股票"}</>}
                  </button>
                </form>
                {assessmentFeedback && <div className={`ql-feedback ${reportCopied ? "" : "error"}`} role={reportCopied ? "status" : "alert"} data-testid="status-assessment-feedback">{assessmentFeedback}</div>}
                {assessmentRequested && (
                  <div className="ql-assess-result">
                    {assessmentQuery.isLoading || assessmentQuery.isFetching ? (
                      <div className="ql-assess-loading" role="status" aria-label="正在載入個股評估" data-testid="status-stock-assessment-loading"><i /><i /><i /></div>
                    ) : assessmentQuery.isError ? (
                      <div className="ql-assess-error" role="alert" data-testid="status-stock-assessment-error">
                        <span>{apiError(assessmentQuery.error, "評估資料暫時無法取得，請稍後重試。")}</span>
                        <button type="button" className="ql-assess-button" onClick={() => void assessmentQuery.refetch()} data-testid="button-retry-stock-assessment">重試</button>
                      </div>
                    ) : assessmentQuery.data ? (
                      <StockAssessmentReport
                        assessment={assessmentQuery.data}
                        copied={reportCopied}
                        onCopy={async () => {
                          try {
                            await navigator.clipboard.writeText(assessmentQuery.data!.reportMarkdown);
                            setReportCopied(true);
                            setAssessmentFeedback("Markdown 報告已複製。");
                          } catch {
                            setReportCopied(false);
                            setAssessmentFeedback("無法使用剪貼簿；請確認瀏覽器權限後重試。");
                          }
                        }}
                      />
                    ) : null}
                  </div>
                )}
              </section>
              {/* Historical backtest interface removed; persisted records are preserved.
              <div className="ql-grid">
                <div className="ql-left-stack">
                  <section className="ql-panel" data-testid="panel-research-form">
                    <div className="ql-panel-head">
                      <div><span className="ql-index">研究設定 / INPUT</span><h2>描述你的市場假設</h2><p>AI 先整理成可確認的回測條件；你確認後才載入行情並執行回測。</p></div>
                      <BookOpen size={17} />
                    </div>
                    <div className="ql-body">
                      <Form {...form}>
                        <form className="ql-form" onSubmit={submitResearch} data-testid="form-quant-research">
                          <div className="ql-workflow" aria-label="研究執行步驟" data-testid="status-research-workflow">
                            <span><b>01</b>描述假設</span><span><b>02</b>確認 AI 條件</span><span><b>03</b>載入資料並回測</span>
                          </div>
                          <FormField control={form.control} name="hypothesis" rules={{ required: "請輸入至少 8 個字的假設", minLength: { value: 8, message: "假設至少需要 8 個字" }, maxLength: { value: 600, message: "最多 600 個字" } }} render={({ field }) => (
                            <FormItem>
                              <FormLabel className="ql-label">研究假設</FormLabel>
                              <FormControl><textarea {...field} className="ql-control textarea" placeholder="例如：近 20 日動能較強且成交量穩定的股票，在月度再平衡下是否優於大盤？" data-testid="input-research-hypothesis" /></FormControl>
                              <small className="ql-form-help">可用自然語言描述條件，例如「每週投入 3,000 元買 0050，累計投入 100,000 元就停止」。AI 會先顯示解析結果供你確認。</small>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="tickerFilter" rules={{ validate: (value) => !value?.trim() || /^[0-9]{4,6}(?:\.(?:TW|TWO))?$/i.test(value.trim()) || "請輸入 4 至 6 位股票代碼，可加上 .TW 或 .TWO" }} render={({ field }) => (
                            <FormItem>
                              <FormLabel className="ql-label">限定股票（選填）</FormLabel>
                              <FormControl><input {...field} value={field.value ?? ""} className="ql-control" placeholder="2330.TW" autoComplete="off" data-testid="input-ticker-filter" /></FormControl>
                              <small className="ql-form-help">預設只回測台積電（2330.TW）；清空欄位改為全市場。限定個股時會逐交易日比較進場門檻，最多持有 1 檔。</small>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <div className="ql-two">
                            <FormField control={form.control} name="rangeMonths" render={({ field }) => (
                              <FormItem><FormLabel className="ql-label">回測期間</FormLabel><FormControl><select {...field} value={String(field.value)} onChange={(event) => field.onChange(Number(event.target.value))} className="ql-control" data-testid="select-research-range"><option value="3">近 3 個月</option><option value="6">近 6 個月</option><option value="12">近 12 個月</option></select></FormControl></FormItem>
                            )} />
                            <FormField control={form.control} name="rebalance" render={({ field }) => (
                              <FormItem><FormLabel className="ql-label">訊號檢查頻率</FormLabel><FormControl><select {...field} className="ql-control" data-testid="select-rebalance"><option value="weekly">每週</option><option value="monthly">每月</option></select></FormControl><small className="ql-form-help">{tickerFilterValue ? "限定個股一律逐交易日檢查；此選項只影響全市場回測。" : "在每個檢查點評估 AI 買入與賣出條件。"}</small></FormItem>
                            )} />
                          </div>
                          <div className="ql-two">
                            <FormField control={form.control} name="startingCapital" rules={{ required: true, min: { value: 100000, message: "最低 NT$100,000" }, max: { value: 100000000, message: "最高 NT$100,000,000" } }} render={({ field }) => (
                              <FormItem><FormLabel className="ql-label">起始資金（NT$）</FormLabel><FormControl><input {...field} type="number" min="100000" max="100000000" step="10000" className="ql-control" data-testid="input-starting-capital" /></FormControl><small className="ql-form-help">若假設使用定期投入模式，起始資金不會投入；資金來自假設中指定的每次投入金額。</small><FormMessage /></FormItem>
                            )} />
                            {tickerFilterValue ? (
                              <div data-testid="notice-single-stock-input">
                                <span className="ql-label">持有檔數</span>
                                <small className="ql-form-help">單一股票最多 1 檔；分段驗證會逐交易日檢查買賣條件。</small>
                              </div>
                            ) : (
                              <FormField control={form.control} name="topN" rules={{ required: true, min: { value: 3, message: "至少 3 檔" }, max: { value: 30, message: "最多 30 檔" } }} render={({ field }) => (
                                <FormItem><FormLabel className="ql-label">持有檔數</FormLabel><FormControl><input {...field} type="number" min="3" max="30" className="ql-control" data-testid="input-top-n" /></FormControl><FormMessage /></FormItem>
                              )} />
                            )}
                          </div>
                          <button className="ql-button" type="submit" disabled={researchMutation.isPending || isInterpreting} data-testid="button-run-research" aria-busy={researchMutation.isPending || isInterpreting}>
                            {isInterpreting ? <><RefreshCw className="ql-spin" size={15} /> AI 正在判讀假設</> : researchMutation.isPending ? <><RefreshCw className="ql-spin" size={15} /> 正在執行研究</> : <><BarChart3 size={16} /> AI 判讀並確認條件</>}
                          </button>
                          {runFeedback && <div className={`ql-feedback ${runFeedbackIsError ? "error" : ""}`} role={runFeedbackIsError ? "alert" : "status"} data-testid="status-research-feedback">{runFeedback}</div>}
                        </form>
                      </Form>
                    </div>
                  </section>

                  <section className="ql-panel" data-testid="panel-saved-runs">
                    <div className="ql-panel-head">
                      <div><span className="ql-index">ARCHIVE / RUNS</span><h2>研究紀錄</h2><p>選取一筆紀錄以重新載入完整結果。</p></div>
                      <div className="ql-panel-actions">
                        <span className="ql-index">{runs.data?.runs.length ?? "—"} 筆</span>
                        <button
                          type="button"
                          className="ql-reset-button"
                          onClick={() => {
                            setRunFeedback("");
                            resetResearchRunsMutation.reset();
                            setResetResearchRunsDialogOpen(true);
                          }}
                          disabled={
                            !runs.data?.runs.length ||
                            runs.isLoading ||
                            runs.isError ||
                            researchMutation.isPending ||
                            selectedRun.isLoading ||
                            summaryMutation.isPending ||
                            resetResearchRunsMutation.isPending
                          }
                          aria-label="清空研究紀錄"
                          title="刪除所有已保存的回測研究紀錄"
                          data-testid="button-reset-research-runs"
                        >
                          <RefreshCw size={12} />重設
                        </button>
                      </div>
                    </div>
                    <div className="ql-body">
                      {runs.isLoading ? <div className="ql-loading" role="status" data-testid="status-runs-loading"><i /><i /><i /></div> :
                        runs.isError ? <div className="ql-state" role="alert" data-testid="error-runs"><CircleAlert size={19} />研究紀錄目前無法載入<button className="ql-button" style={{ marginTop: 12 }} type="button" onClick={() => void runs.refetch()} data-testid="button-retry-runs">重新載入</button></div> :
                          !runs.data?.runs.length ? <div className="ql-state" data-testid="empty-research-runs"><FlaskConical size={20} />尚無研究紀錄。完成第一筆回測後，結果會留存在這裡。</div> :
                            <div className="ql-runlist" data-testid="list-research-runs">{runs.data.runs.map((run) => (
                              <button key={run.runId} type="button" className={`ql-run ${activeRunId === run.runId ? "active" : ""}`} onClick={() => { setActiveRunId(run.runId); setRunFeedback(""); }} data-testid={`button-select-run-${run.runId}`}>
                                <strong>{run.hypothesis}</strong><small>{pct(run.totalReturnPercent)}</small>
                                <em>{dateText(run.createdAt)}　·　{run.dataStartDate} – {run.dataEndDate}</em>
                              </button>
                            ))}</div>}
                    </div>
                  </section>
                </div>

                <section className="ql-panel" data-testid="panel-backtest-result">
                  <div className="ql-panel-head"><div><span className="ql-index">RESULT / OFFICIAL DATA</span><h2>回測檢視</h2><p>曲線只呈現此筆 API 回傳的資產序列，含大盤基準。</p></div><span className="ql-index">{result ? `RUN ${result.runId}` : "READY"}</span></div>
                  <div className="ql-body">
                    {activeRunId && selectedRun.isLoading ? <div className="ql-loading" role="status" data-testid="status-run-loading"><i /><i /><i /><i /></div> :
                      activeRunId && selectedRun.isError ? <div className="ql-state" role="alert" data-testid="error-selected-run"><CircleAlert size={20} />無法載入這筆研究結果<button type="button" className="ql-button" onClick={() => void selectedRun.refetch()} data-testid="button-retry-selected-run">重新載入</button></div> :
                         !result ? <div className="ql-state" data-testid="empty-backtest-result"><BarChart3 size={24} />尚未選取或執行回測<p>送出假設後，會在此顯示買賣條件、模擬交易、績效與官方資料範圍。</p></div> :
                          <div className="ql-result" data-testid="result-backtest">
                             <div className="ql-result-title"><h2>{result.strategy.name}</h2><small>建立於 {dateText(result.createdAt)}　·　AI：{quantAiProviderLabels[result.aiProvider]}　·　範圍：{result.tickerFilter ?? "全市場"}　·　最多持有 {result.topN} 檔</small></div>
                             <div className="ql-metrics ql-primary-metrics" data-testid="grid-backtest-metrics">
                               <div className="ql-metric"><span>策略總報酬</span><strong className={result.metrics.totalReturnPercent >= 0 ? "ql-up" : "ql-down"}>{pct(result.metrics.totalReturnPercent)}</strong></div>
                               <div className="ql-metric"><span>相對大盤</span><strong className={result.metrics.totalReturnPercent - result.metrics.taiexReturnPercent >= 0 ? "ql-up" : "ql-down"}>{pct(result.metrics.totalReturnPercent - result.metrics.taiexReturnPercent)}</strong></div>
                               {result.strategy.positionSizing?.mode === "fixed_cash" && <div className="ql-metric"><span>累計投入</span><strong>{money(result.metrics.contributedCapital ?? result.startingCapital)}</strong></div>}
                               {result.strategy.positionSizing?.mode === "fixed_cash" && <div className="ql-metric"><span>投資損益</span><strong className={result.metrics.finalEquity >= (result.metrics.contributedCapital ?? result.startingCapital) ? "ql-up" : "ql-down"}>{money(result.metrics.finalEquity - (result.metrics.contributedCapital ?? result.startingCapital))}</strong></div>}
                               <div className="ql-metric"><span>最大回撤</span><strong className="ql-down">{result.strategy.positionSizing?.mode === "fixed_cash" ? "—" : pct(result.metrics.maxDrawdownPercent)}</strong></div>
                               <div className="ql-metric"><span>期末資產</span><strong>{money(result.metrics.finalEquity)}</strong></div>
                             </div>
                               {result.strategy.positionSizing?.mode === "fixed_cash" ? (
                                 <div className="ql-signal-rules" data-testid="panel-quant-signal-rules">
                                   <div className="ql-signal-card sizing"><span>定期投入規則</span><p>每週{result.strategy.positionSizing.weekday === "monday" ? "一" : result.strategy.positionSizing.weekday === "tuesday" ? "二" : result.strategy.positionSizing.weekday === "wednesday" ? "三" : result.strategy.positionSizing.weekday === "thursday" ? "四" : "五"}投入 {money(result.strategy.positionSizing.amountPerEntry ?? 0)}，整股買進，未用完的現金累積至下次投入；買進後持有至回測結束，不套用 AI 買賣訊號。指定日休市時順延至本週下一個交易日。</p></div>
                                   <p className="ql-signal-note">總報酬以累計投入金額為基準；TAIEX 以相同投入日期與金額模擬定期投入比較。未實現損益按最後交易日收盤價估值。</p>
                                 </div>
                               ) : result.strategy.entryRule && result.strategy.exitRule ? (
                                <div className="ql-signal-rules" data-testid="panel-quant-signal-rules">
                                  <div className="ql-signal-card entry"><span>買入條件</span><p>{formatQuantSignalRule(result.strategy.entryRule)}</p></div>
                                  <div className="ql-signal-card exit"><span>賣出條件</span><p>{formatQuantSignalRule(result.strategy.exitRule)}</p></div>
                                  {result.strategy.positionSizing && <div className="ql-signal-card sizing"><span>買入數量與頻率</span><p>{result.strategy.positionSizing.mode === "fixed_shares" ? `每${result.strategy.positionSizing.frequency === "daily" ? "個交易日" : result.strategy.positionSizing.frequency === "weekly" ? "週" : "月"}符合買入條件時買進 ${result.strategy.positionSizing.sharesPerEntry} 股並累積；出場條件成立時賣出全部持股。` : `未指定固定股數，依可用資金配置；訊號檢查頻率：${result.strategy.positionSizing.frequency === "daily" ? "每日" : result.strategy.positionSizing.frequency === "weekly" ? "每週" : "每月"}。`}</p></div>}
                                    <p className="ql-signal-note">{result.timingComparison ? "AI 提出的門檻僅以訓練期間比較；驗證期間未參與挑選。逐日以前一交易日收盤判斷，符合條件後於下一交易日開盤模擬成交，成交價每邊加 0.1% 滑價；並非即時投資建議。" : "AI 依假說提出固定門檻，未依本次歷史績效最佳化。每週／每月以前一交易日收盤資料判斷，符合條件後於下一交易日開盤模擬成交，成交價每邊加 0.1% 滑價；這是歷史回測規則，不是即時投資建議。"}</p>
                                </div>
                              ) : (
                                <div className="ql-warning" data-testid="notice-legacy-timing-rule"><strong>這筆舊紀錄沒有保存買賣條件</strong>重新執行回測後，結果會列出 AI 設計並實際套用的進出場規則。</div>
                              )}
                              {result.timingComparison && <div className="ql-warning" data-testid="panel-timing-comparison">
                                <strong>個股進場時機分段驗證</strong>
                                <p>前 60% 交易日（{result.timingComparison.calibrationStartDate} 至 {result.timingComparison.calibrationEndDate}）用來挑選門檻；後 40%（{result.timingComparison.validationStartDate} 至 {result.timingComparison.validationEndDate}）只用來驗證，不參與挑選。比較 AI 基準及 20 日動能門檻上下最多 10 個百分點的候選；候選與原門檻共用 AI 賣出條件。</p>
                                <p>驗證結果：勝率 {pct(result.timingComparison.validation.winRatePercent)}，已完成交易 {result.timingComparison.validation.closedTradeCount} 筆，總報酬 {pct(result.timingComparison.validation.totalReturnPercent)}，最大回撤 {pct(result.timingComparison.validation.maxDrawdownPercent)}。</p>
                                <p data-testid="status-backtest-80-target">
                                  {result.timingComparison.validation.closedTradeCount < 20
                                    ? `尚未驗收 80% 目標：樣本 ${result.timingComparison.validation.closedTradeCount}/20 筆`
                                    : (result.timingComparison.validation.winRatePercent ?? 0) >= 80
                                      ? "已達 80% 樣本外交易勝率目標"
                                      : "未達 80% 樣本外交易勝率目標"}
                                </p>
                                {(result.timingComparison.calibrationCandidates.find((candidate) => candidate.selected)?.closedTradeCount ?? 0) < 3 && <p role="status">訓練期完整交易少於 3 筆，候選挑選樣本不足；系統保留 AI 基準規則，不依少量交易選出高勝率候選。</p>}
                                {result.timingComparison.validation.closedTradeCount < 3 && <p role="status">驗證期完整交易少於 3 筆，勝率樣本不足，請勿視為穩定結論。</p>}
                                <div className="ql-table-wrap"><table className="ql-table"><thead><tr><th>訓練候選</th><th>完整交易</th><th>勝率</th><th>總報酬</th><th>挑選</th></tr></thead><tbody>{result.timingComparison.calibrationCandidates.map((candidate) => <tr key={candidate.name}><td>{candidate.name}</td><td>{candidate.closedTradeCount}</td><td>{pct(candidate.winRatePercent)}</td><td>{pct(candidate.totalReturnPercent)}</td><td>{candidate.selected ? "已選用" : "—"}</td></tr>)}</tbody></table></div>
                                <small>勝率以扣除估計手續費與交易稅後獲利的已完成買賣週期計算；未平倉部位不計入勝率。</small>
                              </div>}
                              {result.walkForward && <div className="ql-warning" data-testid="panel-walk-forward">
                                <strong>Walk-forward 滾動樣本外驗證</strong>
                                <p>每折只用訓練區間比較門檻，再套用到後續未參與挑選的驗證區間。各折重新選擇門檻；這是日線歷史模擬，不是當沖績效。</p>
                                <div className="ql-table-wrap"><table className="ql-table"><thead><tr><th>折次</th><th>訓練區間</th><th>驗證區間</th><th>門檻</th><th>交易</th><th>勝率</th><th>報酬</th><th>最大回撤</th></tr></thead><tbody>
                                  {result.walkForward.folds.map((fold) => <tr key={fold.index} data-testid={`row-walk-forward-${fold.index}`}>
                                    <td>{fold.index}</td><td>{dateText(fold.trainStartDate)}–{dateText(fold.trainEndDate)}</td><td>{dateText(fold.validationStartDate)}–{dateText(fold.validationEndDate)}</td><td>{pct(fold.selectedThreshold * 100)}</td><td>{fold.closedTradeCount}</td><td>{pct(fold.winRatePercent)}</td><td>{pct(fold.totalReturnPercent)}</td><td>{pct(fold.maxDrawdownPercent)}</td>
                                  </tr>)}
                                </tbody></table></div>
                              </div>}
                              {result.parameterStability && <div className="ql-warning" data-testid="panel-parameter-stability">
                                <strong>參數穩定度（校準區間）</strong>
                                <p>只展示校準區間的敏感度，不用驗證區間挑參數。調整 20 日動能門檻與訊號檢查頻率；單點最佳不代表穩定，並注意各組交易樣本數。</p>
                                <div className="ql-table-wrap"><table className="ql-table"><thead><tr><th>動能門檻</th><th>每日檢查</th><th>每週檢查</th><th>每月檢查</th></tr></thead><tbody>
                                  {[...new Set(result.parameterStability.grid.map((point) => point.threshold))].sort((a, b) => a - b).map((threshold, rowIndex) => <tr key={threshold} data-testid={`row-parameter-stability-${rowIndex}`}>
                                    <th>{pct(threshold * 100)}</th>
                                    {(["daily", "weekly", "monthly"] as const).map((rebalance) => {
                                      const point = result.parameterStability!.grid.find((item) => item.threshold === threshold && item.rebalance === rebalance);
                                      const alpha = point ? Math.min(0.55, 0.16 + Math.abs(point.totalReturnPercent) / 100) : 0;
                                      return <td key={rebalance} style={{ backgroundColor: point ? point.totalReturnPercent >= 0 ? `hsl(157 45% 38% / ${alpha})` : `hsl(2 58% 48% / ${alpha})` : undefined }}>
                                        {point ? <><strong>{pct(point.totalReturnPercent)}</strong><small style={{ display: "block" }}>勝率 {pct(point.winRatePercent)} · {point.closedTradeCount} 筆 · 回撤 {pct(point.maxDrawdownPercent)}</small></> : "—"}
                                      </td>;
                                    })}
                                  </tr>)}
                                </tbody></table></div>
                                <small>綠色為正報酬、紅色為負報酬；顏色深淺反映報酬幅度，不代表統計顯著性。</small>
                                <small>{dateText(result.parameterStability.calibrationStartDate)}–{dateText(result.parameterStability.calibrationEndDate)}；不得將校準區間表現視為樣本外成績。</small>
                              </div>}
                              {result.monteCarlo && <div className="ql-warning" data-testid="panel-monte-carlo">
                                <strong>蒙地卡羅風險分布</strong>
                                {result.monteCarlo.simulationCount > 0 ? <>
                                  <p>以 {result.monteCarlo.sampledSessions} 個 Walk-forward 樣本外日報酬進行 {result.monteCarlo.simulationCount.toLocaleString("zh-TW")} 次有放回抽樣。這是歷史路徑風險情境，不是未來預測。</p>
                                  <div className="ql-metrics ql-secondary-metrics">
                                    <div className="ql-metric"><span>期末報酬 P5</span><strong>{pct(result.monteCarlo.terminalReturnP05Percent)}</strong></div>
                                    <div className="ql-metric"><span>期末報酬中位數</span><strong>{pct(result.monteCarlo.terminalReturnMedianPercent)}</strong></div>
                                    <div className="ql-metric"><span>期末報酬 P95</span><strong>{pct(result.monteCarlo.terminalReturnP95Percent)}</strong></div>
                                    <div className="ql-metric"><span>虧損情境比例</span><strong>{pct(result.monteCarlo.probabilityOfLossPercent)}</strong></div>
                                    <div className="ql-metric"><span>最大回撤 P95</span><strong>{pct(result.monteCarlo.maxDrawdownP95Percent)}</strong></div>
                                  </div>
                                  <div aria-label="蒙地卡羅期末報酬分布" data-testid="chart-monte-carlo-distribution">
                                    {result.monteCarlo.terminalReturnBuckets.map((bucket) => {
                                      const maxCount = Math.max(1, ...result.monteCarlo!.terminalReturnBuckets.map((item) => item.count));
                                      const width = (bucket.count / maxCount) * 100;
                                      return <div key={bucket.range} style={{ display: "grid", gridTemplateColumns: "74px 1fr 42px", gap: 8, alignItems: "center", margin: "5px 0" }}>
                                        <small>{bucket.range}</small>
                                        <div role="progressbar" aria-label={`期末報酬 ${bucket.range}`} aria-valuemin={0} aria-valuemax={maxCount} aria-valuenow={bucket.count} style={{ height: 8, borderRadius: 8, background: "hsl(var(--muted))" }}>
                                          <span style={{ display: "block", width: `${width}%`, height: "100%", borderRadius: 8, background: "hsl(var(--primary))" }} />
                                        </div>
                                        <small>{bucket.count}</small>
                                      </div>;
                                    })}
                                  </div>
                                </> : <p>樣本外報酬數量或有效變動不足以支撐抽樣；暫不計算模擬分布（觀察日數 {result.monteCarlo.sampledSessions}）。</p>}
                                <small>{result.monteCarlo.method}；不適用於定期投入，也不代表真實損失機率。</small>
                              </div>}
                              {result.costStress && <div className="ql-warning" data-testid="panel-cost-stress">
                                <strong>成本加倍壓力測試</strong>
                                <p>基準每邊含 0.1% 滑價；此情境將滑價、手續費與證交稅一併加倍。{result.strategy.positionSizing?.mode === "fixed_cash" ? <>兩倍成本下，以累計投入為基準的總報酬為 {pct(result.costStress.totalReturnPercent)}。</> : <>結果：總報酬 {pct(result.costStress.totalReturnPercent)}，勝率 {pct(result.costStress.winRatePercent)}，已完成交易 {result.costStress.closedTradeCount} 筆，賺賠比 {result.costStress.payoffRatio == null ? "—" : result.costStress.payoffRatio.toFixed(2)}。</>}</p>
                              </div>}
                              <div className="ql-warning" data-testid="status-quant-80-target">
                                <strong>80% 勝率目標驗收</strong>
                                {result.strategy.positionSizing?.mode === "fixed_cash" ? (
                                  <p>定期投入策略不以單筆獲利率評分；請看總報酬、相對大盤和成本情境。</p>
                                ) : result.timingComparison ? (
                                  <p>
                                    樣本外交易勝率 {pct(result.timingComparison.validation.winRatePercent)}（{result.timingComparison.validation.closedTradeCount} 筆）；
                                    {result.timingComparison.validation.closedTradeCount < 20
                                      ? "樣本少於 20 筆，尚不能驗收 80% 目標。"
                                      : (result.timingComparison.validation.winRatePercent ?? 0) >= 80
                                        ? "達到 80% 樣本外目標。"
                                        : "未達 80% 樣本外目標。"}
                                  </p>
                                ) : (
                                  <p>本次沒有獨立樣本外區間；回測勝率不能用來驗收 80% 目標。</p>
                                )}
                              </div>
                              <section className="ql-assess-section" aria-label="回測風險與驗證摘要" data-testid="panel-backtest-risk-scan">
                                <div className="ql-assess-section-head"><h4>風險與驗證速覽</h4><small>歷史模擬數據；不是目前個股評估</small></div>
                                <div className="ql-risk-scan">
                                  <div><span>{result.strategy.positionSizing?.mode === "fixed_cash" ? "回撤" : "最大回撤"}</span><strong>{result.strategy.positionSizing?.mode === "fixed_cash" ? "不適用" : pct(result.metrics.maxDrawdownPercent)}</strong><small>{result.strategy.positionSizing?.mode === "fixed_cash" ? "定期投入採投入本金基準" : "依本次回測資產曲線"}</small></div>
                                  <div><span>成本加倍情境</span><strong>{result.costStress ? pct(result.costStress.totalReturnPercent) : "未提供"}</strong><small>{result.costStress ? "總報酬；細節見下方壓力測試" : "此紀錄未包含成本壓力測試"}</small></div>
                                  <div><span>樣本外驗證</span><strong>{result.timingComparison ? pct(result.timingComparison.validation.winRatePercent) : "無獨立驗證"}</strong><small>{result.timingComparison ? `${result.timingComparison.validation.closedTradeCount} 筆驗證交易` : "不可將整段回測勝率視為樣本外成績"}</small></div>
                                  <div><span>官方資料覆蓋</span><strong>{result.coverage.dataStartDate && result.coverage.dataEndDate ? `${dateText(result.coverage.dataStartDate)} – ${dateText(result.coverage.dataEndDate)}` : "資料未提供"}</strong><small>{result.coverage.tradingDays.toLocaleString("zh-TW")} 個交易日可用</small></div>
                                </div>
                              </section>
                              {result.tickerFilter && <div className="ql-warning" data-testid="notice-single-stock-result"><strong>本次只回測 {result.tickerFilter}</strong>{result.strategy.positionSizing?.mode === "fixed_cash" ? "依指定日期定期投入並持有至期末，不檢查 AI 買賣條件。" : result.strategy.entryRule && result.strategy.exitRule ? "逐交易日檢查買賣條件；顯示的勝率只來自未參與挑選的驗證期間。" : "這筆舊版回測沒有明確的個股買賣時機條件。"}</div>}
                             <details className="ql-details" data-testid="details-backtest-analysis">
                               <summary>走勢、其他指標與資料範圍</summary>
                               <div className="ql-details-content">
                                 <div className="ql-metrics ql-secondary-metrics" aria-label="其他回測指標">
                                   <div className="ql-metric"><span>年化報酬</span><strong>{result.strategy.positionSizing?.mode === "fixed_cash" ? "—" : pct(result.metrics.annualizedReturnPercent)}</strong></div>
                                   <div className="ql-metric"><span>年化波動</span><strong>{result.strategy.positionSizing?.mode === "fixed_cash" ? "—" : pct(result.metrics.annualizedVolatilityPercent)}</strong></div>
                                   <div className="ql-metric"><span>Sharpe</span><strong>{result.strategy.positionSizing?.mode === "fixed_cash" ? "—" : result.metrics.sharpeRatio.toFixed(2)}</strong></div>
                                   <div className="ql-metric"><span>交易筆數</span><strong>{result.metrics.tradeCount.toLocaleString("zh-TW")}</strong></div>
                                    <div className="ql-metric"><span>平均獲利交易</span><strong>{result.strategy.positionSizing?.mode === "fixed_cash" ? "—" : pct(result.metrics.averageWinPercent)}</strong></div>
                                    <div className="ql-metric"><span>平均虧損交易</span><strong>{result.strategy.positionSizing?.mode === "fixed_cash" ? "—" : pct(result.metrics.averageLossPercent)}</strong></div>
                                    <div className="ql-metric"><span>賺賠比</span><strong>{result.strategy.positionSizing?.mode === "fixed_cash" || result.metrics.payoffRatio == null ? "—" : result.metrics.payoffRatio.toFixed(2)}</strong></div>
                                   <div className="ql-metric"><span>TAIEX 同期</span><strong>{pct(result.metrics.taiexReturnPercent)}</strong></div>
                                 </div>
                            <div className="ql-subhead"><h3>資產曲線</h3><small>{result.equityCurve.length} 個官方資料點</small></div>
                            {result.equityCurve.length ? <div className="ql-chart" data-testid="chart-equity-curve">
                              <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={result.equityCurve} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                                  <defs><linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="hsl(12 76% 52%)" stopOpacity={0.22} /><stop offset="95%" stopColor="hsl(12 76% 52%)" stopOpacity={0.01} /></linearGradient></defs>
                                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 5" vertical={false} />
                                  <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }} tickFormatter={(value: string) => value.slice(5)} axisLine={false} tickLine={false} minTickGap={28} />
                                  <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }} tickFormatter={(value: number) => `${(value / 10000).toFixed(0)}萬`} axisLine={false} tickLine={false} width={42} />
                                  <Tooltip formatter={(value: number, name: string) => [money(value), name === "equity" ? "策略資產" : "TAIEX 基準"]} labelStyle={{ color: "hsl(var(--foreground))" }} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 2, fontSize: 11 }} />
                                  <Legend formatter={(value) => value === "equity" ? "策略資產" : "TAIEX 基準"} wrapperStyle={{ fontSize: 10 }} />
                                  <Area type="monotone" dataKey="equity" name="equity" stroke="hsl(12 76% 52%)" strokeWidth={2} fill="url(#equityFill)" dot={false} />
                                  <Area type="monotone" dataKey="taiexEquity" name="taiexEquity" stroke="hsl(168 48% 37%)" strokeWidth={1.5} fill="none" dot={false} />
                                </AreaChart>
                              </ResponsiveContainer>
                            </div> : <div className="ql-state" data-testid="empty-equity-curve">API 未提供可繪製的資產曲線資料。</div>}
                            <div className="ql-subhead"><h3>因子排名權重</h3><small>AI 選擇的價量因子組合</small></div>
                            <div className="ql-weights" data-testid="grid-factor-weights">
                              {([["20 日動能", result.strategy.factorWeights.momentum20], ["60 日動能", result.strategy.factorWeights.momentum60], ["20 日成交金額", result.strategy.factorWeights.liquidity20], ["20 日低波動", result.strategy.factorWeights.lowVolatility20]] as const).map(([label, weight]) => <div className="ql-weight" key={label}><span>{label}</span><strong>{(weight * 100).toFixed(1)}%</strong></div>)}
                            </div>
                            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.65 }}>{result.strategy.rationale}</p>
                            {result.tickerFilter && <div className="ql-source" data-testid="notice-single-stock-factors"><CircleAlert size={14} /><span>單一股票不需要與其他股票排名；因子權重保留作為策略紀錄，買賣時機由上方條件控制。</span></div>}
                            <div className="ql-source" data-testid="panel-data-provenance"><Database size={14} /><span><strong>資料來源與涵蓋</strong><br />{result.coverage.source}；資料日期 {result.coverage.dataStartDate} 至 {result.coverage.dataEndDate}（要求起日：{result.coverage.requestedStartDate}）。交易日 {result.coverage.tradingDays.toLocaleString("zh-TW")}、合資格證券 {result.coverage.eligibleSecurities.toLocaleString("zh-TW")}；TWSE {result.coverage.twseRows.toLocaleString("zh-TW")} 列、TPEx {result.coverage.tpexRows.toLocaleString("zh-TW")} 列。已抓取 {result.coverage.fetchedDays} 日／快取 {result.coverage.cachedDays} 日。資料指紋：{result.coverage.dataFingerprint}</span></div>
                                 <div className="ql-source" data-testid="text-backtest-disclaimer"><CircleAlert size={14} /><span><strong>回測限制與聲明</strong><br />{result.disclaimer}{result.tradeLogTruncated ? " 交易明細已截斷，所列筆數不代表完整交易紀錄。" : ""}</span></div>
                               </div>
                             </details>
                             <details className="ql-details" data-testid="details-backtest-trades">
                               <summary>回測模擬交易明細（{result.trades.length} 筆{result.tradeLogTruncated ? "／已截斷" : ""}）</summary>
                               <div className="ql-details-content">
                                 <div className="ql-trade-explainer" data-testid="notice-backtest-trade-source">
                                   這些紀錄由回測引擎依本次策略與歷史資料推演，是假設性買賣，不是你、其他會員、券商或交易所的真實成交，也沒有送出委託。
                                 </div>
                                  {result.trades.length ? <div className="ql-table-wrap" data-testid="table-backtest-trades"><table className="ql-table"><thead><tr><th>日期</th><th>代碼／名稱</th><th>方向</th><th>股數</th><th>成交價（含滑價）</th><th>滑價成本</th><th>手續費</th><th>交易稅</th></tr></thead><tbody>{result.trades.map((trade, index) => <tr key={`${trade.date}-${trade.ticker}-${index}`} data-testid={`row-backtest-trade-${index}`}><td>{dateText(trade.date)}</td><td>{trade.ticker} {trade.name}</td><td>{trade.side === "buy" ? "買進" : "賣出"}</td><td>{trade.shares.toLocaleString("zh-TW")}</td><td>{money(trade.price)}</td><td>{money(trade.slippageCost)}</td><td>{money(trade.commission)}</td><td>{money(trade.transactionTax)}</td></tr>)}</tbody></table></div> : <div className="ql-state" data-testid="empty-backtest-trades">此回測沒有可列示的交易明細。</div>}
                               </div>
                             </details>
                             <section className="ql-ai-summary" data-testid="panel-ai-backtest-summary" aria-live="polite">
                               <div className="ql-ai-summary-head"><h3><Sparkles size={15} />AI 回測摘要</h3><small>只解讀本次歷史結果</small></div>
                               {result.aiSummary ? <p>{result.aiSummary}</p> :
                                 summaryMutation.isPending ? <p role="status"><RefreshCw className="ql-spin" size={13} /> 正在整理這筆回測的 AI 摘要…</p> :
                                   aiSummaryFeedback ? <div className="ql-ai-summary-error" role="alert">{aiSummaryFeedback}<button className="ql-summary-retry" type="button" onClick={() => requestAiSummary(result.runId)} disabled={summaryMutation.isPending}>重新產生摘要</button></div> :
                                     result.aiSummary === null ? <div className="ql-ai-summary-error">摘要暫時無法生成，回測結果仍可查看。<button className="ql-summary-retry" type="button" onClick={() => requestAiSummary(result.runId)} disabled={summaryMutation.isPending}>重新產生摘要</button></div> :
                                       <p role="status">正在為這筆已保存的回測補上 AI 摘要…</p>}
                               <small className="ql-ai-summary-disclaimer">摘要只根據本次策略與回測數據生成，不推論原因或預測未來，也不是買賣建議。資料來源與限制請展開上方說明。</small>
                             </section>
                          </div>}
                  </div>
                </section>
              </div>

              */}
              <div className="ql-columns">
                <section className="ql-panel" data-testid="panel-paper-portfolio">
                  <div className="ql-panel-head">
                    <div><span className="ql-index">PAPER LEDGER / 02</span><h2>紙上投資組合</h2><p>成交價由你手動輸入；持倉市值仍依最新官方收盤價估值。</p></div>
                    <div className="ql-panel-actions">
                      {portfolio.data?.initialized && <button type="button" className="ql-reset-button" onClick={() => { setPaperFeedback(""); resetPortfolioMutation.reset(); setResetDialogOpen(true); }} disabled={resetPortfolioMutation.isPending} data-testid="button-reset-paper"><RefreshCw size={12} />重設</button>}
                      <Wallet size={17} />
                    </div>
                  </div>
                  {portfolio.isLoading ? <div className="ql-body ql-loading" role="status" data-testid="status-paper-loading"><i /><i /><i /></div> :
                    portfolio.isError ? <div className="ql-body"><div className="ql-state" role="alert" data-testid="error-paper-portfolio"><CircleAlert size={19} />紙上帳戶目前無法讀取<button type="button" className="ql-button" onClick={() => void portfolio.refetch()} data-testid="button-retry-paper">重新載入</button></div></div> :
                      !portfolio.data?.initialized ? <div className="ql-paper-content">
                        <div className="ql-state" style={{ paddingTop: 8 }} data-testid="empty-paper-portfolio"><Wallet size={21} />尚未建立紙上帳戶<p>指定模擬起始資金後即可記錄買進與賣出。</p></div>
                        <Form {...initializeForm}>
                          <form onSubmit={initializePortfolio} className="ql-trade-form ql-init-form" data-testid="form-initialize-paper">
                            <FormField control={initializeForm.control} name="startingCash" rules={{ required: "請輸入起始現金", min: { value: 100000, message: "最低 NT$100,000" }, max: { value: 100000000, message: "最高 NT$100,000,000" } }} render={({ field }) => (
                              <FormItem className="ticker-cell"><FormLabel>起始現金（NT$）</FormLabel><FormControl><input {...field} className="ql-control" type="number" min="100000" max="100000000" step="10000" value={field.value ?? ""} onChange={(event) => field.onChange(event.target.valueAsNumber)} data-testid="input-paper-starting-cash" /></FormControl><FormMessage /></FormItem>
                            )} />
                            <button type="submit" className="ql-button" disabled={initializeMutation.isPending} data-testid="button-initialize-paper">{initializeMutation.isPending ? "建立中…" : "建立模擬帳戶"}</button>
                          </form>
                        </Form>
                        {paperFeedback && <div className={`ql-feedback ${initializeMutation.isError ? "error" : ""}`} role={initializeMutation.isError ? "alert" : "status"} data-testid="status-paper-feedback">{paperFeedback}</div>}
                      </div> :
                        <div className="ql-paper-content">
                          <div className="ql-summary" data-testid="grid-paper-summary">
                            <div><span>總資產</span><strong>{money(portfolio.data.equity)}</strong></div><div><span>可用現金</span><strong>{money(portfolio.data.cash)}</strong></div><div><span>持倉市值</span><strong>{money(portfolio.data.marketValue)}</strong></div><div><span>累計報酬</span><strong className={(portfolio.data.returnPercent ?? 0) >= 0 ? "ql-up" : "ql-down"}>{pct(portfolio.data.returnPercent)}</strong></div>
                          </div>
                          <p style={{ margin: "10px 0", color: "hsl(var(--muted-foreground))", fontSize: 9 }}>估值日期：{dateText(portfolio.data.asOf)} · 起始資金 {money(portfolio.data.startingCash)}</p>
                          <div className="ql-subhead"><h3>持倉明細</h3><small>{portfolio.data.positions.length} 檔</small></div>
                          {portfolio.data.positions.length ? portfolio.data.positions.map((position) => <div className="ql-position" key={position.ticker} data-testid={`row-paper-position-${position.ticker}`}><div><strong>{position.ticker}　{position.name}</strong><small>{position.shares.toLocaleString("zh-TW")} 股 · 均價 {money(position.averageCost)} · 收盤 {money(position.latestClose)}</small></div><div style={{ textAlign: "right" }}><strong>{money(position.marketValue)}</strong><small>未實現 {money(position.unrealizedPnl)}</small></div></div>) : <div className="ql-state" data-testid="empty-paper-positions">尚無持倉，完成一筆模擬買進後會顯示於此。</div>}
                           <Form {...tradeForm}>
                             <form onSubmit={recordTrade} className="ql-trade-form" data-testid="form-paper-trade">
                               <FormField control={tradeForm.control} name="ticker" rules={{ required: "請輸入台股代碼", pattern: { value: /^[A-Za-z0-9]{4,6}(\.(TW|TWO))?$/i, message: "請輸入有效代碼，例如 2330.TW 或 6488.TWO" } }} render={({ field }) => (
                                 <FormItem className="ticker-cell"><FormLabel>股票代碼</FormLabel><FormControl><input {...field} className="ql-control" pattern="[A-Za-z0-9]{4,6}(\.(TW|TWO))?" placeholder="例如 2330.TW" data-testid="input-paper-ticker" /></FormControl><FormMessage /></FormItem>
                               )} />
                               <FormField control={tradeForm.control} name="side" render={({ field }) => (
                                 <FormItem><FormLabel>方向</FormLabel><FormControl><select {...field} className="ql-control" data-testid="select-paper-side"><option value="buy">買進</option><option value="sell">賣出</option></select></FormControl></FormItem>
                               )} />
                               <FormField control={tradeForm.control} name="shares" rules={{ required: "請輸入股數", min: { value: 1, message: "至少 1 股" }, max: { value: 10000000, message: "股數超出上限" } }} render={({ field }) => (
                                 <FormItem><FormLabel>股數</FormLabel><FormControl><input {...field} className="ql-control" type="number" min="1" max="10000000" step="1" value={field.value ?? ""} onChange={(event) => field.onChange(event.target.valueAsNumber)} data-testid="input-paper-shares" /></FormControl><FormMessage /></FormItem>
                               )} />
                                <FormField control={tradeForm.control} name="price" rules={{ required: "請輸入模擬成交價", min: { value: 0.01, message: "成交價至少 NT$0.01" }, max: { value: 1000000, message: "成交價不可超過 NT$1,000,000" } }} render={({ field }) => (
                                  <FormItem className="price-cell"><FormLabel>成交價格（NT$/股）</FormLabel><FormControl><input {...field} className="ql-control" type="number" min="0.01" max="1000000" step="0.01" placeholder="自行輸入價格" value={field.value ?? ""} onChange={(event) => field.onChange(event.target.value === "" ? undefined : event.target.valueAsNumber)} data-testid="input-paper-price" /></FormControl><FormMessage /><small>不會自動套用現價。</small></FormItem>
                                )} />
                               <button type="submit" className="ql-button" disabled={tradeMutation.isPending} data-testid="button-record-paper-trade">{tradeMutation.isPending ? "記錄中…" : <>{tradeForm.watch("side") === "buy" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}{tradeForm.watch("side") === "buy" ? "模擬買進" : "模擬賣出"}</>}</button>
                             </form>
                           </Form>
                          {paperFeedback && <div className={`ql-feedback ${initializeMutation.isError || tradeMutation.isError ? "error" : ""}`} role={initializeMutation.isError || tradeMutation.isError ? "alert" : "status"} data-testid="status-paper-feedback">{paperFeedback}</div>}
                           <div className="ql-subhead" style={{ marginTop: 18 }}><h3>紙上交易紀錄</h3><small>{portfolio.data.trades.length} 筆</small></div>
                          {portfolio.data.trades.length ? <div className="ql-table-wrap" data-testid="table-paper-trades"><table className="ql-table"><thead><tr><th>日期</th><th>股票</th><th>方向</th><th>股數</th><th>成交價</th><th>已實現</th></tr></thead><tbody>{portfolio.data.trades.map((trade) => <tr key={trade.id} data-testid={`row-paper-trade-${trade.id}`}><td>{trade.tradingDate}</td><td>{trade.ticker} {trade.name}</td><td>{trade.side === "buy" ? "買進" : "賣出"}</td><td>{trade.shares.toLocaleString("zh-TW")}</td><td>{money(trade.price)}</td><td>{money(trade.realizedPnl)}</td></tr>)}</tbody></table></div> : <div className="ql-state" data-testid="empty-paper-trades">尚無紙上交易紀錄。</div>}
                        </div>}
                  <div className="ql-warning" data-testid="notice-paper-disclaimer"><strong>模擬交易，不是真實委託</strong>{portfolio.data?.disclaimer ?? "成交價由使用者輸入；持倉市值依最近官方收盤價估值。估算手續費與交易稅；未連接券商、不代表可成交價格，也不構成投資建議。"}</div>
                </section>
                <section className="ql-panel" data-testid="panel-methodology">
                  <div className="ql-panel-head"><div><span className="ql-index">PAPER / LIMITS</span><h2>紙上交易界線</h2><p>這裡只記錄模擬交易，不會送出真實委託。</p></div><Database size={17} /></div>
                  <div className="ql-paper-content" style={{ display: "grid", gap: 13 }}>
                    <div className="ql-source"><LockKeyhole size={14} /><span>成交價格由你手動輸入，持倉市值依最近官方收盤價估值；只更新模擬帳本，不連接券商，也不會下單。</span></div>
                    <div className="ql-source"><ShieldCheck size={14} /><span>紙上交易僅供記錄與觀察，不代表可成交價格或投資建議。</span></div>
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      </main>
      {/* Research-history deletion dialog removed; persisted records are preserved.
      {resetResearchRunsDialogOpen && (
        <div className="ql-reset-backdrop">
          <section
            className="ql-reset-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ql-reset-research-title"
            aria-describedby="ql-reset-research-description"
            data-testid="dialog-reset-research-runs"
          >
            <h2 id="ql-reset-research-title">清空量化研究紀錄？</h2>
            <p id="ql-reset-research-description">
              此操作會永久刪除帳戶中所有已保存的回測研究結果（清單目前顯示 {runs.data?.runs.length ?? 0} 筆），包含策略績效、資產曲線、模擬交易明細與 AI 摘要。清除後無法復原；不會影響研究設定或紙上帳戶、持倉與交易紀錄。
            </p>
            {resetResearchRunsMutation.isError && runFeedback && (
              <div className="ql-feedback error" role="alert" style={{ marginTop: 12 }}>{runFeedback}</div>
            )}
            <div className="ql-reset-actions">
              <button
                type="button"
                className="ql-reset-cancel"
                onClick={() => {
                  setResetResearchRunsDialogOpen(false);
                  resetResearchRunsMutation.reset();
                }}
                disabled={resetResearchRunsMutation.isPending}
                data-testid="button-cancel-reset-research-runs"
              >
                保留紀錄
              </button>
              <button
                type="button"
                className="ql-button"
                onClick={resetResearchRuns}
                disabled={resetResearchRunsMutation.isPending}
                data-testid="button-confirm-reset-research-runs"
              >
                {resetResearchRunsMutation.isPending ? <><RefreshCw className="ql-spin" size={14} /> 清除中…</> : "確認重設並清空"}
              </button>
            </div>
          </section>
        </div>
      )}
      */}
      {resetDialogOpen && (
        <div className="ql-reset-backdrop">
          <section
            className="ql-reset-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ql-reset-title"
            aria-describedby="ql-reset-description"
            data-testid="dialog-reset-paper"
          >
            <h2 id="ql-reset-title">重設紙上投資組合？</h2>
            <p id="ql-reset-description">
              此操作會清除全部紙上持倉與交易紀錄，並把可用現金恢復至起始本金 {money(portfolio.data?.startingCash)}。清除後無法復原。
            </p>
            {resetPortfolioMutation.isError && paperFeedback && (
              <div className="ql-feedback error" role="alert" style={{ marginTop: 12 }}>{paperFeedback}</div>
            )}
            <div className="ql-reset-actions">
              <button type="button" className="ql-reset-cancel" onClick={() => { setResetDialogOpen(false); resetPortfolioMutation.reset(); }} disabled={resetPortfolioMutation.isPending} data-testid="button-cancel-reset-paper">保留資料</button>
              <button type="button" className="ql-button" onClick={resetPaperPortfolio} disabled={resetPortfolioMutation.isPending} data-testid="button-confirm-reset-paper">
                {resetPortfolioMutation.isPending ? <><RefreshCw className="ql-spin" size={14} /> 重設中…</> : "確認重設並清空"}
              </button>
            </div>
          </section>
        </div>
      )}
      {/* Backtest confirmation and progress dialogs removed.
      {interpretationDialogOpen && researchInterpretation && (
        <div className="ql-progress-backdrop">
          <section className="ql-progress-dialog" role="dialog" aria-modal="true" aria-labelledby="ql-interpretation-title" data-testid="dialog-research-interpretation">
            <header className="ql-progress-head">
              <div>
                <div className="ql-progress-title"><Sparkles size={17} /><h2 id="ql-interpretation-title">確認 AI 判讀條件</h2></div>
                <p>尚未載入行情或執行回測。請先確認下列條件符合你的假設。</p>
              </div>
            </header>
            <div className="ql-progress-body">
              <div className="ql-signal-card">
                <span>AI 判讀</span>
                <p>{researchInterpretation.summary}</p>
              </div>
              <div className="ql-signal-card">
                <span>回測標的</span>
                <p>{researchInterpretation.tickerFilter ?? "依表單設定的市場範圍"}</p>
              </div>
              {pendingResearchInput && (
                <div className="ql-signal-card">
                  <span>回測期間與資金設定</span>
                  <p>
                    {pendingResearchInput.rangeMonths} 個月；{researchInterpretation.mode === "recurring_cash"
                      ? `定期投入方案不使用起始本金欄位（目前填寫 ${money(pendingResearchInput.startingCapital)}）`
                      : `起始本金 ${money(pendingResearchInput.startingCapital)}`}
                    ；每次持有 {pendingResearchInput.topN} 檔；{pendingResearchInput.rebalance === "weekly" ? "每週" : "每月"}再平衡。
                  </p>
                </div>
              )}
              {researchInterpretation.mode === "recurring_cash" ? (
                <div className="ql-signal-card sizing">
                  <span>定期投入規則</span>
                  <p>
                    每週{researchInterpretation.weekday === "first_trading_day"
                      ? "第一個交易日"
                      : ({ monday: "一", tuesday: "二", wednesday: "三", thursday: "四", friday: "五" } as const)[researchInterpretation.weekday ?? "monday"] ?? "第一個交易日"}
                    投入 {money(researchInterpretation.amountPerEntry)}
                    {researchInterpretation.totalContributionLimit
                      ? `，累計投入至 ${money(researchInterpretation.totalContributionLimit)} 後停止，最後一期只投入剩餘額度`
                      : "，持續至回測期間結束"}
                    ；買進整股並持有至期末，不依 AI 買賣訊號交易。
                  </p>
                </div>
              ) : (
                <>
                  <div className="ql-signal-card">
                    <span>買入條件</span>
                    <p>{researchInterpretation.strategy.entryRule
                      ? formatQuantSignalRule(researchInterpretation.strategy.entryRule)
                      : "AI 未提供可確認的買入條件，請返回修改後重新判讀。"}</p>
                  </div>
                  <div className="ql-signal-card">
                    <span>賣出條件</span>
                    <p>{researchInterpretation.strategy.exitRule
                      ? formatQuantSignalRule(researchInterpretation.strategy.exitRule)
                      : "AI 未提供可確認的賣出條件，請返回修改後重新判讀。"}</p>
                  </div>
                  <div className="ql-signal-card sizing">
                    <span>持倉與檢查方式</span>
                    <p>{researchInterpretation.strategy.positionSizing?.mode === "fixed_shares"
                      ? `每${researchInterpretation.strategy.positionSizing.frequency === "daily" ? "個交易日" : researchInterpretation.strategy.positionSizing.frequency === "weekly" ? "週" : "月"}符合進場條件時買進 ${researchInterpretation.strategy.positionSizing.sharesPerEntry ?? "—"} 股；符合賣出條件時賣出全部持股。`
                      : `依可用資金配置持倉；訊號檢查頻率 ${researchInterpretation.strategy.positionSizing?.frequency ?? pendingResearchInput?.rebalance ?? "—"}。`}
                      {" "}排名權重：近20日動能 {((researchInterpretation.strategy.factorWeights.momentum20) * 100).toFixed(0)}%、近60日動能 {((researchInterpretation.strategy.factorWeights.momentum60) * 100).toFixed(0)}%、成交金額 {((researchInterpretation.strategy.factorWeights.liquidity20) * 100).toFixed(0)}%、低波動 {((researchInterpretation.strategy.factorWeights.lowVolatility20) * 100).toFixed(0)}%。
                    </p>
                  </div>
                </>
              )}
              <div className="ql-progress-footer">
                <button className="ql-progress-close" type="button" onClick={() => setInterpretationDialogOpen(false)} data-testid="button-cancel-research-interpretation">返回修改</button>
                <button className="ql-button" type="button" onClick={confirmResearchInterpretation} data-testid="button-confirm-research-interpretation">確認條件並開始回測</button>
              </div>
            </div>
          </section>
        </div>
      )}
      {researchModalOpen && (
        <div className="ql-progress-backdrop">
          <section
            className="ql-progress-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ql-progress-title"
            data-testid="dialog-research-progress"
          >
            <header className="ql-progress-head">
              <div>
                <div className="ql-progress-title">
                  {researchMutation.isPending ? (
                    <RefreshCw className="ql-spin" size={17} />
                  ) : (
                    <Activity size={17} />
                  )}
                  <h2 id="ql-progress-title">
                    {researchMutation.isPending
                      ? "正在執行回測"
                      : researchMutation.isError
                        ? "研究未完成"
                        : "回測完成"}
                  </h2>
                </div>
                <p>
                  即時記錄 AI 備援、官方日行情載入與回測狀態。成功取得的每日行情會保留；若官方端點暫時失敗，可重新執行接續缺漏日期。
                </p>
              </div>
              <span className="ql-progress-elapsed">
                {`${Math.floor(researchElapsedSeconds / 60)
                  .toString()
                  .padStart(2, "0")}:${(researchElapsedSeconds % 60)
                  .toString()
                  .padStart(2, "0")}`}
              </span>
            </header>
            <div className="ql-progress-body">
              <div className="ql-progress-caption">
                <strong>{researchStageLabels[researchStage]}</strong>
                <span>
                  {researchProgress && researchProgress.total > 0
                    ? `${researchProgress.current.toLocaleString("zh-TW")} / ${researchProgress.total.toLocaleString("zh-TW")} 個交易所日期`
                    : researchMutation.isPending
                      ? "等待服務回報進度"
                      : "已停止"}
                </span>
              </div>
              <div
                className="ql-progress-track"
                role="progressbar"
                aria-label="回測資料載入進度"
                aria-valuemin={0}
                aria-valuemax={researchProgress?.total || 100}
                aria-valuenow={
                  researchProgress && researchProgress.total > 0
                    ? researchProgress.current
                    : undefined
                }
              >
                <div
                  className={`ql-progress-fill ${
                    !researchProgress && researchMutation.isPending
                      ? "indeterminate"
                      : ""
                  }`}
                  style={{
                    width:
                      researchProgress && researchProgress.total > 0
                        ? `${Math.min(
                            100,
                            (researchProgress.current /
                              researchProgress.total) *
                              100,
                          )}%`
                        : researchMutation.isPending
                          ? undefined
                          : "100%",
                  }}
                />
              </div>
              <div
                className="ql-progress-log"
                role="log"
                aria-live="polite"
                aria-label="回測執行即時紀錄"
                ref={researchLogRef}
                data-testid="log-research-progress"
              >
                {researchLogs.map((entry) => (
                  <div className="ql-progress-entry" key={entry.id}>
                    <span className="ql-progress-time">{entry.time}</span>
                    <strong>{entry.stage}</strong>
                    <p>{entry.message}</p>
                  </div>
                ))}
              </div>
              {researchMutation.isError && runFeedback && (
                <div
                  className="ql-progress-error"
                  role="alert"
                  data-testid="error-research-progress"
                >
                  {runFeedback}
                </div>
              )}
            </div>
            <footer className="ql-progress-footer">
              {researchMutation.isError &&
                (runFeedback.includes("官方日行情仍缺少") ||
                  runFeedback.includes("已保存的官方行情")) && (
                  <button
                    className="ql-progress-retry"
                    type="button"
                    onClick={() => void submitResearch()}
                    data-testid="button-retry-missing-market-data"
                  >
                    重新執行研究
                  </button>
                )}
              <button
                className="ql-progress-close"
                type="button"
                onClick={() => setResearchModalOpen(false)}
                disabled={researchMutation.isPending}
                data-testid="button-close-research-progress"
              >
                {researchMutation.isPending ? "執行中…" : "關閉"}
              </button>
            </footer>
          </section>
        </div>
      )}
      */}
    </div>
  );
}
