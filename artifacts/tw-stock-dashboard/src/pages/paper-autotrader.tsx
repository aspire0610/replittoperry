import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Clock3,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import {
  getGetAccountPaperTradingAutomationQueryKey,
  getPatchAccountPaperTradingAutomationStatusMutationKey,
  getPutAccountPaperTradingAutomationMutationKey,
  useGetAccountPaperTradingAutomation,
  usePatchAccountPaperTradingAutomationStatus,
  usePutAccountPaperTradingAutomation,
  type PaperAutomationDashboard,
  type PaperAutomationEvent,
} from "@workspace/api-client-react";
import { Form } from "@/components/ui/form";
import { PaperFuturesMarketCard } from "@/components/paper-futures-market-card";
import "./paper-autotrader.css";

type SettingsValues = {
  startingCash: number;
  riskPerTradePercent: number;
  dailyLossLimitPercent: number;
  maxOpenPositions: number;
  futuresEnabled: boolean;
  futuresContract: "TX" | "MTX" | "TMF";
  futuresEntryMode: "aggressive" | "convergent";
  futuresForceEntryEnabled: boolean;
};

const money = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : `NT$ ${value.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;

const signedMoney = (value: number) =>
  `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;

const price = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const taipeiTime = (value: string | null | undefined) => {
  if (!value) return "尚未回報";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-TW", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
};

const shortDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
};

const elapsedSeconds = (value: string | null | undefined, now: number) => {
  if (!value) return "尚未回報";
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1_000));
  if (!Number.isFinite(seconds)) return "時間無效";
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分鐘前`;
};

const eventKindLabels: Record<PaperAutomationEvent["kind"], string> = {
  signal_queued: "候選待確認",
  entry_filled: "模擬進場",
  exit_filled: "模擬出場",
  skipped: "未納入模擬",
  halted: "風控暫停",
};

const exitReasonLabels: Record<NonNullable<PaperAutomationEvent["exitReason"]>, string> = {
  take_profit: "停利出場",
  stop_loss: "停損出場",
  session_end: "收盤平倉",
};

function exitReasonForEvent(event: PaperAutomationEvent): PaperAutomationEvent["exitReason"] {
  if (event.exitReason) return event.exitReason;
  if (event.kind !== "exit_filled") return undefined;
  if (event.reason.includes("觸及停損線")) return "stop_loss";
  if (event.reason.includes("觸及停利線")) return "take_profit";
  return undefined;
}

const futuresEvaluationStatusLabels = {
  ready: "條件通過",
  waiting: "等待訊號／行情",
  blocked: "風控或條件未通過",
  unavailable: "分析暫不可用",
  inactive: "目前未啟動",
} as const;

const futuresActionLabels = {
  long: "AI 判斷做多",
  short: "AI 判斷做空",
  wait: "AI 判斷等待",
  insufficient: "AI 資料不足",
} as const;

const adjustmentStatusLabels = {
  idle: "尚未觸發重評",
  pending: "AI 重新評估中",
  applied: "AI 已重新評估",
} as const;

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const payload = (error as { data?: { error?: unknown } }).data;
    if (typeof payload?.error === "string") return payload.error;
  }
  return error instanceof Error ? error.message : "操作未完成，請稍後重試。";
}

function PaperSkeleton() {
  return (
    <div className="pa-skeleton-grid" role="status" aria-label="正在載入模擬帳戶">
      <div className="pa-skeleton pa-skeleton-hero" />
      <div className="pa-skeleton" />
      <div className="pa-skeleton" />
      <div className="pa-skeleton pa-skeleton-wide" />
    </div>
  );
}

function Metric({ label, value, note, featured = false }: { label: string; value: string; note?: string; featured?: boolean }) {
  return (
    <div className={`pa-metric${featured ? " is-featured" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function PaperAutotraderPage() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const queryClient = useQueryClient();
  const userScope = isSignedIn ? userId : null;
  const previousUserId = useRef<string | null>(userScope);
  const queryKey = [...getGetAccountPaperTradingAutomationQueryKey(), userScope ?? "signed-out"] as const;
  useEffect(() => {
    if (previousUserId.current !== userScope) {
      const baseKey = String(getGetAccountPaperTradingAutomationQueryKey()[0]);
      queryClient.removeQueries({
        predicate: (query) => String(query.queryKey[0] ?? "") === baseKey,
      });
      previousUserId.current = userScope;
    }
  }, [queryClient, userScope]);
  const dashboardQuery = useGetAccountPaperTradingAutomation({
    query: {
      queryKey,
      enabled: Boolean(isLoaded && isSignedIn),
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: (query) => {
        const current = query.state.data;
        return current && (current.enabled || current.positions.length > 0 || current.futuresEnabled)
          ? 15_000
          : false;
      },
    },
    request: { credentials: "include" },
  });
  const saveSettings = usePutAccountPaperTradingAutomation({
    mutation: { mutationKey: getPutAccountPaperTradingAutomationMutationKey() },
    request: { credentials: "include" },
  });
  const setAutomationStatus = usePatchAccountPaperTradingAutomationStatus({
    mutation: { mutationKey: getPatchAccountPaperTradingAutomationStatusMutationKey() },
    request: { credentials: "include" },
  });
  const dashboard = dashboardQuery.data;
  const [operationError, setOperationError] = useState("");
  const [operationNotice, setOperationNotice] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const form = useForm<SettingsValues>({
    defaultValues: {
      startingCash: 1_000_000,
      riskPerTradePercent: 0.5,
      dailyLossLimitPercent: 2,
      maxOpenPositions: 3,
      futuresEnabled: false,
      futuresContract: "TMF",
      futuresEntryMode: "convergent",
      futuresForceEntryEnabled: false,
    },
  });
  const { reset, register, handleSubmit, watch, formState } = form;

  useEffect(() => {
    if (!dashboard) return;
    reset({
      startingCash: dashboard.startingCash ?? 1_000_000,
      riskPerTradePercent: dashboard.riskPerTradePercent,
      dailyLossLimitPercent: dashboard.dailyLossLimitPercent,
      maxOpenPositions: dashboard.maxOpenPositions,
      futuresEnabled: dashboard.futuresEnabled,
      futuresContract: dashboard.futuresContract,
      futuresEntryMode: dashboard.futuresEntryMode,
      futuresForceEntryEnabled: dashboard.futuresForceEntryEnabled,
    });
  }, [dashboard, reset]);

  const isBusy = saveSettings.isPending || setAutomationStatus.isPending;
  const risk = watch("riskPerTradePercent") || 0;
  const cap = watch("dailyLossLimitPercent") || 0;
  const futuresEntryMode = watch("futuresEntryMode");
  const futuresEnabled = watch("futuresEnabled");
  const futuresForceEntryEnabled = watch("futuresForceEntryEnabled");
  const activeLimitBase = dashboard?.dailyStartEquity ?? dashboard?.startingCash ?? 0;
  const perTradeBudget = activeLimitBase * risk / 100;
  const dailyLossBudget = activeLimitBase * cap / 100;
  const events = useMemo(
    () => [...(dashboard?.events ?? [])].sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf)).slice(0, 12),
    [dashboard?.events],
  );
  const closedTrades = useMemo(
    () => [...(dashboard?.events ?? [])]
      .filter((event) =>
        event.kind === "exit_filled" &&
        (exitReasonForEvent(event) === "take_profit" || exitReasonForEvent(event) === "stop_loss")
      )
      .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf)),
    [dashboard?.events],
  );
  const closedTradePnl = closedTrades.reduce(
    (total, event) => total + (event.realizedPnl ?? 0),
    0,
  );
  const closedTradePnlCount = closedTrades.filter((event) => event.realizedPnl != null).length;
  useEffect(() => {
    if (!dashboard?.enabled && !dashboard?.positions.length && !dashboard?.futuresEnabled) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [dashboard?.enabled, dashboard?.positions.length, dashboard?.futuresEnabled]);
  const futuresEntriesLastHour = useMemo(() => {
    const cutoff = clockNow - 60 * 60 * 1_000;
    return (dashboard?.events ?? []).filter((event) =>
      event.kind === "entry_filled" &&
      (event.assetClass === "futures" || event.ticker === "TXF") &&
      Date.parse(event.asOf) >= cutoff
    ).length;
  }, [clockNow, dashboard?.events]);
  const futuresUnrealizedPnl = useMemo(
    () => (dashboard?.positions ?? [])
      .filter((position) => position.assetClass === "futures")
      .reduce((total, position) => {
        const direction = position.direction === "short" ? -1 : 1;
        return total + (position.lastPrice - position.entryPrice) *
          position.shares * (position.contractMultiplier ?? 0) * direction;
      }, 0),
    [dashboard?.positions],
  );

  const updateCache = (next: PaperAutomationDashboard, notice: string) => {
    queryClient.setQueryData(queryKey, next);
    setOperationError("");
    setOperationNotice(notice);
  };

  const submitSettings = handleSubmit((values) => {
    setOperationError("");
    setOperationNotice("");
    saveSettings.mutate(
      {
        data: {
          startingCash: dashboard?.initialized ? dashboard.startingCash ?? values.startingCash : Number(values.startingCash),
          riskPerTradePercent: Number(values.riskPerTradePercent),
          dailyLossLimitPercent: Number(values.dailyLossLimitPercent),
          maxOpenPositions: Number(values.maxOpenPositions),
          futuresEnabled: values.futuresEnabled,
          futuresContract: values.futuresContract,
          futuresEntryMode: values.futuresEntryMode,
          futuresForceEntryEnabled: values.futuresEnabled && values.futuresForceEntryEnabled,
        },
      },
      {
        onSuccess: (next) => updateCache(next, next.initialized ? "風險設定已儲存。" : "紙上模擬帳戶已建立。"),
        onError: (error) => setOperationError(errorMessage(error)),
      },
    );
  });

  const toggleAutomation = () => {
    if (!dashboard) return;
    setOperationError("");
    setOperationNotice("");
    setAutomationStatus.mutate(
      { data: { enabled: !dashboard.enabled } },
      {
        onSuccess: (next) => updateCache(next, next.enabled ? "紙上模擬已啟用。" : "紙上模擬已暫停。"),
        onError: (error) => setOperationError(errorMessage(error)),
      },
    );
  };

  if (!isLoaded) {
    return <main className="pa-page"><div className="pa-frame"><PaperSkeleton /></div></main>;
  }
  if (!isSignedIn) {
    return (
      <main className="pa-page">
        <div className="pa-frame">
          <PageHeader />
          <section className="pa-state-card" role="status">
            <ShieldCheck size={23} aria-hidden="true" />
            <div><strong>登入後管理模擬帳戶</strong><p>此頁只顯示目前帳號的紙上模擬設定與紀錄。</p></div>
            <Link href="/sign-in?returnTo=paper-autotrader" className="pa-button pa-button-primary" data-testid="link-paper-autotrader-sign-in">前往登入</Link>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="pa-page" data-testid="page-paper-autotrader">
      <div className="pa-frame">
        <PageHeader dashboard={dashboard} onRefresh={() => void dashboardQuery.refetch()} refreshing={dashboardQuery.isFetching} />

        <aside className="pa-boundary" aria-label="紙上模擬重要說明">
          <ShieldCheck size={19} aria-hidden="true" />
          <div>
            <strong>僅限紙上模擬，不連接券商、不會送出真實委託</strong>
            <p>這是個人研究桌上的風險受限模擬帳戶。所有進出場只會記錄在模擬資料中，不會動用資金或操作任何券商帳戶。</p>
          </div>
          <span className="pa-paper-stamp">PAPER ONLY</span>
        </aside>

        {dashboardQuery.isError && !dashboard ? (
          <section className="pa-state-card pa-error" role="alert" data-testid="status-paper-automation-error">
            <AlertTriangle size={21} aria-hidden="true" />
            <div><strong>模擬帳戶資料暫時無法讀取</strong><p>{errorMessage(dashboardQuery.error)}</p></div>
            <button type="button" className="pa-button pa-button-secondary" onClick={() => void dashboardQuery.refetch()} disabled={dashboardQuery.isFetching} data-testid="button-retry-paper-automation">重新讀取</button>
          </section>
        ) : dashboardQuery.isLoading && !dashboard ? (
          <PaperSkeleton />
        ) : dashboard ? (
          <>
            {dashboard.dailyStopTriggered && (
              <div className="pa-stop-alert" role="status" data-testid="status-daily-stop">
                <AlertTriangle size={17} aria-hidden="true" />
                <span><strong>已觸發當日虧損上限</strong> 今天不會新增模擬進場；現有部位仍會監控停損與停利。</span>
              </div>
            )}

            <section className="pa-account-overview" aria-label="模擬帳戶總覽">
              <div className="pa-overview-heading">
                <div>
                  <span className="pa-overline">SIMULATION ACCOUNT / TW MARKETS</span>
                  <h2>{dashboard.initialized ? "研究帳戶總覽" : "尚未建立模擬帳戶"}</h2>
                  <p>{dashboard.initialized ? "行情與研究訊號只在本帳戶的模擬紀錄中反映。" : "先設定起始本金與風險界線，建立專屬紙上模擬帳戶。"}</p>
                </div>
                <div className={`pa-status-pill ${dashboard.enabled ? "is-on" : "is-off"}`} data-testid="status-automation-enabled">
                  <i aria-hidden="true" />{dashboard.enabled ? "自動進場開啟" : dashboard.positions.length ? "只監控出場" : "自動進場已暫停"}
                </div>
              </div>
              <div className="pa-metrics">
                <Metric label="帳戶淨值" value={money(dashboard.equity)} featured note="紙上估值" />
                <Metric label="可用模擬現金" value={money(dashboard.cash)} />
                <Metric label="起始本金" value={money(dashboard.startingCash)} note="建立後不可修改" />
                <Metric label="持倉 / 上限" value={`${dashboard.positions.length} / ${dashboard.maxOpenPositions}`} note={`單筆風險 ${dashboard.riskPerTradePercent}%`} />
              </div>
              <div className="pa-overview-footer">
                <span><Clock3 size={13} aria-hidden="true" />工作程序最近回報：<strong>{taipeiTime(dashboard.lastProcessedAt)}</strong></span>
                <span className="pa-freshness">以伺服器回報時間為準</span>
              </div>
            </section>

            <PaperFuturesMarketCard />

            <section className="pa-panel pa-futures-monitor" aria-labelledby="pa-futures-monitor-title" data-testid="panel-futures-live-monitor">
              <div className="pa-panel-head pa-list-head">
                <div className="pa-panel-icon is-teal"><Activity size={16} aria-hidden="true" /></div>
                <div>
                  <span className="pa-overline">LIVE ENTRY CHECK / PAPER FUTURES</span>
                  <h2 id="pa-futures-monitor-title">即時進場判斷與績效</h2>
                </div>
                {(() => {
                  const lastProcessed = dashboard.lastProcessedAt ? Date.parse(dashboard.lastProcessedAt) : Number.NaN;
                  const workerFresh = Number.isFinite(lastProcessed) && clockNow - lastProcessed <= 45_000;
                  const monitorStatus = dashboard.currentFuturesEvaluation?.status ?? "inactive";
                  return (
                    <span className={`pa-live-pill ${workerFresh && dashboard.enabled ? `is-live is-${monitorStatus}` : "is-stale"}`} data-testid="status-futures-worker">
                      <i aria-hidden="true" />
                      {workerFresh && dashboard.enabled
                        ? futuresEvaluationStatusLabels[monitorStatus]
                        : dashboard.enabled
                          ? "等待工作程序回報"
                          : "自動模擬未啟動"}
                      <small>{elapsedSeconds(dashboard.lastProcessedAt, clockNow)}</small>
                    </span>
                  );
                })()}
              </div>

              <div className="pa-monitor-current">
                {dashboard.currentFuturesEvaluation ? (
                  <>
                    <div className="pa-monitor-current-head">
                      <strong>{dashboard.currentFuturesEvaluation.action
                        ? futuresActionLabels[dashboard.currentFuturesEvaluation.action]
                        : "等待 AI 方向判斷"}</strong>
                      <span>{futuresEvaluationStatusLabels[dashboard.currentFuturesEvaluation.status]}</span>
                    </div>
                    <p>{dashboard.currentFuturesEvaluation.reason}</p>
                    <div className="pa-monitor-levels">
                      <span>現價 <strong>{price(dashboard.currentFuturesEvaluation.price)}</strong></span>
                      <span>進場參考 <strong>{price(dashboard.currentFuturesEvaluation.entryPrice)}</strong></span>
                      <span>停損 <strong className="pa-stop-value">{price(dashboard.currentFuturesEvaluation.stopLossPrice)}</strong></span>
                      <span>停利 <strong className="pa-target-value">{price(dashboard.currentFuturesEvaluation.targetPrice)}</strong></span>
                      <small>最新評估 {taipeiTime(dashboard.currentFuturesEvaluation.asOf)}</small>
                    </div>
                  </>
                ) : (
                  <div className="pa-monitor-empty">
                    <strong>等待第一次伺服器評估</strong>
                    <span>啟用紙上自動模擬後，這裡會顯示 AI 方向、行情、進場條件及未進場原因。</span>
                  </div>
                )}
                {dashboard.futuresPerformance.adjustmentMessage && (
                  <p className={`pa-adjustment-note is-${dashboard.futuresPerformance.adjustmentStatus}`} data-testid="text-futures-strategy-adjustment">
                    <strong>{adjustmentStatusLabels[dashboard.futuresPerformance.adjustmentStatus]}</strong>
                    {dashboard.futuresPerformance.adjustmentMessage}
                    {dashboard.futuresPerformance.adjustmentAt && <small> · {taipeiTime(dashboard.futuresPerformance.adjustmentAt)}</small>}
                  </p>
                )}
                {dashboard.futuresPerformance.consecutiveStopLosses > 0 &&
                  dashboard.futuresPerformance.adjustmentStatus === "idle" && (
                    <p className="pa-adjustment-note">
                      目前連續停損 {dashboard.futuresPerformance.consecutiveStopLosses} 次；
                      {dashboard.futuresForceEntryEnabled
                        ? "達 3 次後 AI 會重新評估紙上策略。"
                        : "強制進場模式未開啟，不會自動重評策略。"}
                    </p>
                  )}
              </div>

              <div className="pa-futures-performance" aria-label="期貨模擬績效">
                <Metric
                  label="期貨已實現損益"
                  value={dashboard.futuresPerformance.closedTrades
                    ? signedMoney(dashboard.futuresPerformance.realizedPnl)
                    : "尚無平倉"}
                  note={`${dashboard.futuresPerformance.closedTrades} 筆平倉`}
                  featured
                />
                <Metric
                  label="期貨未實現損益"
                  value={dashboard.positions.some((position) => position.assetClass === "futures")
                    ? signedMoney(futuresUnrealizedPnl)
                    : "目前無持倉"}
                  note="按最新有效行情估算"
                />
                <Metric
                  label="期貨勝率"
                  value={dashboard.futuresPerformance.winRatePercent == null
                    ? "尚無樣本"
                    : `${dashboard.futuresPerformance.winRatePercent.toFixed(1)}%`}
                  note={`勝 ${dashboard.futuresPerformance.wins} ／ 敗 ${dashboard.futuresPerformance.losses} ／ 平 ${dashboard.futuresPerformance.breakeven}`}
                />
                <Metric
                  label="策略重評"
                  value={dashboard.futuresForceEntryEnabled
                    ? adjustmentStatusLabels[dashboard.futuresPerformance.adjustmentStatus]
                    : "強制模式關閉"}
                  note={dashboard.futuresForceEntryEnabled
                    ? `連續停損 ${dashboard.futuresPerformance.consecutiveStopLosses} / 3`
                    : "不自動觸發 AI 重評"}
                />
              </div>

              <div className="pa-monitor-log-head">
                <strong>進場條件判斷紀錄</strong>
                <span>狀態變化或價格移動 10 點即記錄；其餘每分鐘更新</span>
              </div>
              {dashboard.futuresDecisionLogs.length ? (
                <ol className="pa-monitor-log" data-testid="list-futures-decision-logs">
                  {dashboard.futuresDecisionLogs.slice(0, 8).map((item) => (
                    <li key={item.id} className={`pa-monitor-log-item is-${item.status}`} data-testid={`row-futures-decision-${item.id}`}>
                      <i aria-hidden="true" />
                      <div className="pa-monitor-log-main">
                        <div>
                          <strong>{item.action ? futuresActionLabels[item.action] : "等待 AI 方向判斷"}</strong>
                          <span>{futuresEvaluationStatusLabels[item.status]}</span>
                        </div>
                        <p>{item.reason}</p>
                        {(item.price != null || item.entryPrice != null) && (
                          <small>
                            現價 {price(item.price)} · 進場 {price(item.entryPrice)} · 停損 {price(item.stopLossPrice)} · 停利 {price(item.targetPrice)}
                          </small>
                        )}
                      </div>
                      <time dateTime={new Date(item.asOf).toISOString()}>{taipeiTime(item.asOf)}</time>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyBlock title="目前沒有判斷紀錄" detail="工作程序首次評估後，會在這裡顯示訊號、行情、風控結果及沒有進場的原因。" />
              )}
              <p className="pa-monitor-footnote">勝率以有損益資料的已平倉期貨模擬交易計算；升級前最多回溯帳本保留的最近 100 筆事件。AI 重新評估不保證改善績效，單筆風險上限與每日停損不會因重評而放寬。</p>
            </section>

            <div className="pa-main-grid">
              <div className="pa-column">
                <section className="pa-panel" aria-labelledby="pa-settings-title">
                  <div className="pa-panel-head">
                    <div className="pa-panel-icon"><SlidersHorizontal size={16} aria-hidden="true" /></div>
                    <div><span className="pa-overline">RISK CONTROL</span><h2 id="pa-settings-title">模擬設定</h2></div>
                    {dashboard.initialized && <span className="pa-immutable-label">起始本金固定</span>}
                  </div>
                  <Form {...form}>
                    <form className="pa-settings-form" onSubmit={submitSettings} noValidate>
                      <label className="pa-field" htmlFor="pa-starting-cash">
                        <span>起始本金 <small>NT$</small></span>
                        <input id="pa-starting-cash" type="number" min="100000" max="100000000" step="10000" disabled={dashboard.initialized || isBusy} aria-describedby="pa-starting-cash-help" {...register("startingCash", { valueAsNumber: true, required: true, min: 100000, max: 100000000 })} data-testid="input-paper-starting-cash" />
                        <small id="pa-starting-cash-help">{dashboard.initialized ? "帳戶建立後不可更改。" : "可設定 NT$ 100,000 至 NT$ 100,000,000。"}</small>
                      </label>
                      <label className="pa-field" htmlFor="pa-risk-per-trade">
                        <span>單筆風險 <small>0.1%–1%</small></span>
                        <div className="pa-input-suffix"><input id="pa-risk-per-trade" type="number" min="0.1" max="1" step="0.1" disabled={isBusy} {...register("riskPerTradePercent", { valueAsNumber: true, required: true, min: 0.1, max: 1 })} data-testid="input-paper-risk-per-trade" /><b>%</b></div>
                        <small>依目前帳戶基準，單筆風險額約 {money(perTradeBudget)}。</small>
                      </label>
                      <label className="pa-field" htmlFor="pa-daily-cap">
                        <span>每日虧損上限 <small>0.5%–5%</small></span>
                        <div className="pa-input-suffix"><input id="pa-daily-cap" type="number" min="0.5" max="5" step="0.1" disabled={isBusy} {...register("dailyLossLimitPercent", { valueAsNumber: true, required: true, min: 0.5, max: 5 })} data-testid="input-paper-daily-loss-cap" /><b>%</b></div>
                        <small>目前設定換算約 {money(dailyLossBudget)}。</small>
                      </label>
                      <label className="pa-field" htmlFor="pa-max-positions">
                        <span>最多同時持倉 <small>1–5 個標的</small></span>
                        <input id="pa-max-positions" type="number" min="1" max="5" step="1" disabled={isBusy} {...register("maxOpenPositions", { valueAsNumber: true, required: true, min: 1, max: 5 })} data-testid="input-paper-max-positions" />
                        <small>股票與期貨持倉共用此上限；期貨每次最多 5 口。</small>
                      </label>
                      <label className="pa-toggle-option" htmlFor="pa-futures-enabled">
                        <input id="pa-futures-enabled" type="checkbox" disabled={isBusy} {...register("futuresEnabled")} data-testid="input-paper-futures-enabled" />
                        <span><strong>加入臺指期自動模擬</strong><small>日盤與夜盤分別使用 TXF1／TXF8 專屬 AI 判斷及同時段 K 線；日盤 13:30、夜盤 04:45 停止新進場，各盤收盤前 5 分鐘有新鮮行情時模擬平倉。</small></span>
                      </label>
                      <label className="pa-field" htmlFor="pa-futures-contract">
                        <span>臺指期契約 <small>單一契約</small></span>
                        <select id="pa-futures-contract" disabled={isBusy} {...register("futuresContract")} data-testid="select-paper-futures-contract">
                          <option value="TX">大台 TX · NT$200／點</option>
                          <option value="MTX">小台 MTX · NT$50／點</option>
                          <option value="TMF">微台 TMF · NT$10／點</option>
                        </select>
                        <small>行情依 TX 連續行情估算；不代表各契約獨立報價。平倉時仍不扣保證金、手續費或期交稅。</small>
                      </label>
                      <label className="pa-field" htmlFor="pa-futures-entry-mode">
                        <span>期貨自動進場模式 <small>只影響期貨</small></span>
                        <select id="pa-futures-entry-mode" disabled={isBusy} {...register("futuresEntryMode")} data-testid="select-paper-futures-entry-mode">
                          <option value="aggressive">積極模式 · 每小時目標 3 次</option>
                          <option value="convergent">收斂模式 · 只等明確訊號</option>
                        </select>
                        <small>{futuresForceEntryEnabled
                          ? "強制模式停利至少 20 點、不設上限；每小時 3 次仍是目標，不保證。單口風險超過額度、無有效方向或行情不新鮮時不進場。"
                          : futuresEntryMode === "aggressive"
                            ? "完整行情、期指與加權同向且風險門檻通過時，可不等突破回測；3 次是目標，無合格訊號不強迫進場。"
                            : "完整行情、期指與加權同向、風險門檻通過，且兩根完成的一分 K 突破回測確認後才進場。"}
                        </small>
                      </label>
                      <label className={`pa-toggle-option${!futuresEnabled ? " is-disabled" : ""}`} htmlFor="pa-futures-force-entry">
                        <input id="pa-futures-force-entry" type="checkbox" disabled={isBusy || !futuresEnabled} {...register("futuresForceEntryEnabled")} data-testid="input-paper-futures-force-entry" />
                        <span>
                          <strong>AI 明確判斷多空時強制現價進場</strong>
                          <small>
                            {futuresForceEntryEnabled
                              ? "只有 AI 明確判斷做多或做空，且有完整價位方案與新鮮行情時才評估進場；AI 判斷等待或資料不足時不進場。停利至少 20 點、不設上限；保留單口風險、持倉上限及每日停損。連續停損 3 次後 AI 重新評估，不保證每小時至少 3 次。"
                              : "開啟後依 AI 明確的多空判斷按最新價模擬進場，不等突破回測或期指／加權同向；AI 判斷等待或資料不足時不進場。仍保留有效停損停利與帳戶風控，只作用於紙上模擬，不會送出真實委託。"}
                          </small>
                        </span>
                      </label>
                      {Object.keys(formState.errors).length > 0 && <p className="pa-form-error" role="alert">請確認各項設定在允許範圍內。</p>}
                      <button className="pa-button pa-button-primary pa-save-button" type="submit" disabled={isBusy} data-testid="button-save-paper-settings">
                        {saveSettings.isPending ? <RefreshCw className="pa-spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                        {dashboard.initialized ? "儲存風險設定" : "建立紙上帳戶"}
                      </button>
                    </form>
                  </Form>
                </section>

                <section className="pa-panel pa-qualification" aria-labelledby="pa-qualification-title">
                  <div className="pa-panel-head">
                    <div className="pa-panel-icon"><ShieldCheck size={16} aria-hidden="true" /></div>
                    <div><span className="pa-overline">ELIGIBILITY</span><h2 id="pa-qualification-title">啟用條件</h2></div>
                  </div>
                  <ul className="pa-check-list">
                    <li className={dashboard.initialized ? "is-ready" : ""}><span>{dashboard.initialized ? <Check size={13} /> : "01"}</span><div><strong>已建立模擬帳戶</strong><small>{dashboard.initialized ? "起始本金已固定" : "完成左側設定後即可建立"}</small></div></li>
                    <li className={dashboard.futuresEnabled ? "is-ready" : ""}><span>{dashboard.futuresEnabled ? <Check size={13} /> : "02"}</span><div><strong>臺指期自動模擬{dashboard.futuresEnabled ? "已啟用" : "選用"}</strong><small>{dashboard.futuresEnabled ? `目前選擇 ${dashboard.futuresContract}、${dashboard.futuresEntryMode === "aggressive" ? "積極模式（每小時目標 3 次）" : "收斂模式"}${dashboard.futuresForceEntryEnabled ? "、AI 強制進場開啟" : ""}；日盤與夜盤分開使用 TXF1／TXF8 證據，最多每 5 分鐘評估一次。` : "可在左側設定中加入大台、小台或微台模擬。"}</small></div></li>
                    <li className={!dashboard.futuresEnabled ? "is-ready" : ""}><span>{dashboard.futuresEnabled ? "03" : <Check size={13} />}</span><div><strong>{dashboard.futuresEnabled ? "個股與期貨分別受控" : "個股自動模擬"}</strong><small>個股方向與停損停利方案各需至少 100 筆結果，且 95% 信賴下限達 80%；未達門檻不會模擬進場。<Link href="/research-office" className="pa-inline-link" data-testid="link-paper-autotrader-researchers">研究員設定</Link></small></div></li>
                    <li className={dashboard.dailyStopTriggered ? "is-blocked" : "is-ready"}><span>{dashboard.dailyStopTriggered ? <AlertTriangle size={13} /> : <Check size={13} />}</span><div><strong>當日風控狀態</strong><small>{dashboard.dailyStopTriggered ? "已達當日虧損上限" : "目前未回報觸發當日停損"}</small></div></li>
                  </ul>
                  <div className="pa-risk-readout"><span>今日起始淨值</span><strong>{money(dashboard.dailyStartEquity)}</strong><span>每日虧損限額</span><strong>{money(dailyLossBudget)}</strong></div>
                  <button type="button" className={`pa-button pa-toggle-button ${dashboard.enabled ? "is-pause" : "is-enable"}`} onClick={toggleAutomation} disabled={!dashboard.initialized || isBusy} aria-label={dashboard.enabled ? "暫停自動模擬進場" : "啟用自動模擬進場"} data-testid="button-toggle-paper-automation">
                    {dashboard.enabled ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                    {setAutomationStatus.isPending ? "正在更新…" : dashboard.enabled ? "暫停自動進場" : dashboard.dailyStopTriggered ? "今日上限已達，無法啟用新進場" : "啟用紙上自動進場"}
                  </button>
                  {futuresEntryMode === "aggressive" && <p className="pa-helper-note" data-testid="status-futures-hourly-entry-goal">最近 60 分鐘期貨進場 {futuresEntriesLastHour} 次／目標 3 次；已有持倉、無合格訊號或風控觸發時可能未達標，系統不會為湊次數強迫成交。</p>}
                  <p className="pa-helper-note">暫停總開關會取消尚未成交的股票與期貨訊號；關閉期貨選項只停止新期貨進場，既有持倉仍監控停損停利。無新鮮行情就不模擬成交。</p>
                </section>
              </div>

              <div className="pa-column">
                <section className="pa-panel" aria-labelledby="pa-pending-title">
                  <div className="pa-panel-head pa-list-head">
                    <div className="pa-panel-icon is-amber"><Clock3 size={16} aria-hidden="true" /></div>
                    <div><span className="pa-overline">AWAITING ENTRY</span><h2 id="pa-pending-title">待處理進場</h2></div>
                    <span className="pa-count">{dashboard.pendingEntries.length.toString().padStart(2, "0")}</span>
                  </div>
                  {dashboard.pendingEntries.length ? (
                    <div className="pa-table-wrap">
                      <table className="pa-table">
                        <thead><tr><th>標的</th><th>進場參考</th><th>停損 / 目標</th><th>市場日 / 到期</th></tr></thead>
                        <tbody>{dashboard.pendingEntries.map((item) => (
                          <tr key={item.id} data-testid={`row-pending-entry-${item.id}`}>
                            <th scope="row"><strong className="pa-ticker">{item.assetClass === "futures" ? `${item.ticker} · ${item.contractType}` : item.ticker.replace(/\.(TW|TWO)$/i, "")}</strong><small>{item.name}{item.direction ? ` · ${item.direction === "long" ? "多單" : "空單"}` : ""}</small></th>
                            <td className="pa-number">{price(item.entryPrice)}</td>
                            <td className="pa-number"><span className="pa-stop-value">{price(item.stopLossPrice)}</span><span className="pa-target-value">{price(item.takeProfitPrice)}</span></td>
                            <td><span>{shortDate(item.marketDate)}</span><small>到期 {taipeiTime(item.expiresAt)}</small></td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  ) : <EmptyBlock title="目前沒有待處理進場" detail="符合條件的研究訊號若進入待確認狀態，會顯示於此。" />}
                </section>

                <section className="pa-panel" aria-labelledby="pa-positions-title">
                  <div className="pa-panel-head pa-list-head">
                    <div className="pa-panel-icon is-teal"><Wallet size={16} aria-hidden="true" /></div>
                    <div><span className="pa-overline">OPEN SIMULATIONS</span><h2 id="pa-positions-title">模擬持倉</h2></div>
                    <span className="pa-count">{dashboard.positions.length.toString().padStart(2, "0")}</span>
                  </div>
                  {dashboard.positions.length ? (
                    <div className="pa-position-list">
                      {dashboard.positions.map((position) => {
                        const isFutures = position.assetClass === "futures";
                        const move = position.lastPrice - position.entryPrice;
                        const direction = position.direction === "short" ? -1 : 1;
                        const grossUnrealizedPnl = move *
                          position.shares *
                          (position.contractMultiplier ?? 1) *
                          direction;
                        const entryCommission = isFutures
                          ? 0
                          : Math.round(position.entryPrice * position.shares * 0.001425 * 100) / 100;
                        const unrealizedPnl = grossUnrealizedPnl - entryCommission;
                        const positivePnl = unrealizedPnl >= 0;
                        return (
                          <article className="pa-position" key={position.id} data-testid={`card-paper-position-${position.id}`}>
                            <div className="pa-position-top">
                              <div className="pa-position-identity"><strong className="pa-ticker">{isFutures ? `${position.ticker} · ${position.contractType}` : position.ticker.replace(/\.(TW|TWO)$/i, "")}</strong><span>{position.name}{position.direction ? ` · ${position.direction === "long" ? "多單" : "空單"}` : ""}</span></div>
                              <div className={`pa-position-pnl ${positivePnl ? "is-up" : "is-down"}`} data-testid={`pnl-paper-position-${position.id}`}>
                                <small>目前未實現損益</small>
                                <strong>{positivePnl ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{signedMoney(unrealizedPnl)}</strong>
                              </div>
                            </div>
                            <div className="pa-position-metrics">
                              <div><small>{isFutures ? "口數" : "股數"}</small><strong>{position.shares.toLocaleString("zh-TW")}{isFutures ? " 口" : ""}</strong></div>
                              <div><small>模擬進場</small><strong>{price(position.entryPrice)}{isFutures ? " 點" : ""}</strong></div>
                              <div><small>最近報價</small><strong>{price(position.lastPrice)}{isFutures ? " 點" : ""}</strong></div>
                              <div><small>停損 / 目標</small><strong><span className="pa-stop-value">{price(position.stopLossPrice)}</span> / <span className="pa-target-value">{price(position.takeProfitPrice)}</span></strong></div>
                            </div>
                            <div className="pa-position-foot"><span>{position.quoteSource} · 行情 {taipeiTime(position.lastQuoteAt)}</span><span>進場 {taipeiTime(position.entryAt)}</span></div>
                          </article>
                        );
                      })}
                    </div>
                  ) : <EmptyBlock title="尚無模擬持倉" detail="這裡只顯示模擬帳戶由系統記錄的持倉，不會連動券商庫存。" />}
                  {!!dashboard.positions.length && <p className="pa-position-note">股票損益已扣買進手續費，未扣出場費用；期貨依契約點值估算，未扣交易費用。</p>}
                </section>
              </div>
            </div>

            <section className="pa-panel pa-closed-trades" aria-labelledby="pa-closed-trades-title">
              <div className="pa-panel-head pa-list-head">
                <div className="pa-panel-icon is-teal"><Check size={16} aria-hidden="true" /></div>
                <div><span className="pa-overline">REALIZED RESULTS</span><h2 id="pa-closed-trades-title">停利／停損損益</h2></div>
                <span className={`pa-closed-total ${closedTradePnlCount ? (closedTradePnl >= 0 ? "is-up" : "is-down") : "is-empty"}`} data-testid="text-realized-paper-pnl">
                  {closedTradePnlCount ? signedMoney(closedTradePnl) : "尚無已實現損益"}
                </span>
              </div>
              {closedTrades.length ? (
                <div className="pa-table-wrap">
                  <table className="pa-table pa-closed-table">
                    <thead><tr><th>平倉時間</th><th>標的／結果</th><th>口數／股數</th><th>進場價</th><th>出場價</th><th>已實現損益</th></tr></thead>
                    <tbody>{closedTrades.map((trade) => (
                      <tr key={trade.id} data-testid={`row-closed-trade-${trade.id}`}>
                        <td>{taipeiTime(trade.asOf)}</td>
                        <th scope="row">
                          <strong className="pa-ticker">{trade.assetClass === "futures" ? `${trade.ticker ?? "TXF"} · ${trade.contractType ?? ""}` : (trade.ticker ?? "—").replace(/\.(TW|TWO)$/i, "")}</strong>
                          <small>{exitReasonForEvent(trade) ? exitReasonLabels[exitReasonForEvent(trade)!] : "模擬出場"}{trade.direction ? ` · ${trade.direction === "long" ? "多單" : "空單"}` : ""}</small>
                        </th>
                        <td>{trade.shares?.toLocaleString("zh-TW") ?? "—"} {trade.assetClass === "futures" ? "口" : "股"}</td>
                        <td className="pa-number">{price(trade.entryPrice)}</td>
                        <td className="pa-number">{price(trade.price)}</td>
                        <td className={`pa-realized-value ${(trade.realizedPnl ?? 0) >= 0 ? "is-up" : "is-down"}`}>
                          {trade.realizedPnl == null ? "—" : signedMoney(trade.realizedPnl)}
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : <EmptyBlock
                title={dashboard.positions.length ? "尚無停利或停損平倉紀錄" : "目前沒有已成交的模擬部位"}
                detail={dashboard.positions.length
                  ? "目前仍持倉中；未實現損益請看上方「模擬持倉」。只有觸及停利或停損並完成模擬平倉後，才會出現在這份已實現損益清單。"
                  : "「候選待確認」尚未成交；「未納入模擬」代表未建立部位，因此沒有未實現或已實現損益。符合風控並出現「模擬進場」後，持倉損益才會開始計算。"}
              />}
              {closedTrades.some((trade) => trade.realizedPnl == null) && (
                <p className="pa-position-note">更新前的平倉事件未保存損益；新產生的停利／停損紀錄會顯示已實現損益。</p>
              )}
            </section>

            <section className="pa-panel pa-events" aria-labelledby="pa-events-title">
              <div className="pa-panel-head pa-list-head">
                <div className="pa-panel-icon"><Activity size={16} aria-hidden="true" /></div>
                <div><span className="pa-overline">AUDIT TRAIL</span><h2 id="pa-events-title">近期模擬事件</h2></div>
                <span className="pa-event-caption">最多顯示 12 筆</span>
              </div>
              {events.length ? (
                <div className="pa-event-list">
                  {events.map((event) => (
                    <article className="pa-event" key={event.id} data-testid={`event-paper-${event.id}`}>
                      <span className={`pa-event-mark is-${event.kind}`} aria-hidden="true">{event.kind === "entry_filled" ? <ArrowDownRight size={14} /> : event.kind === "exit_filled" ? <ArrowUpRight size={14} /> : <Activity size={14} />}</span>
                      <div className="pa-event-main"><div><strong>{eventKindLabels[event.kind]}</strong>{event.ticker && <span className="pa-event-ticker">{event.assetClass === "futures" ? `${event.ticker} · ${event.contractType ?? ""}` : event.ticker.replace(/\.(TW|TWO)$/i, "")}{event.direction ? ` · ${event.direction === "long" ? "多" : "空"}` : ""}</span>}</div><p>{event.reason}</p></div>
                      <div className="pa-event-value">{event.shares != null && <strong>{event.shares.toLocaleString("zh-TW")} {event.assetClass === "futures" ? "口" : "股"}</strong>}{event.price != null && <strong>{price(event.price)}{event.assetClass === "futures" ? " 點" : ""}</strong>}<small>{taipeiTime(event.asOf)}</small></div>
                    </article>
                  ))}
                </div>
              ) : <EmptyBlock title="尚無模擬事件" detail="帳戶建立、候選訊號與模擬進出場紀錄會依伺服器資料顯示於此。" />}
            </section>

            <footer className="pa-disclaimer" data-testid="text-paper-disclaimer">
              <strong>模擬交易聲明</strong>
              <p>{dashboard.disclaimer}</p>
              <p>本功能不連結任何券商、不存取券商帳戶，也不送出真實買賣委託。報價時間、資料來源與模擬紀錄以頁面所示為準；模擬結果不代表實際成交或未來績效。</p>
            </footer>

            {(operationError || operationNotice) && (
              <div className={`pa-toast ${operationError ? "is-error" : ""}`} role={operationError ? "alert" : "status"} data-testid="status-paper-operation">
                {operationError ? <AlertTriangle size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                <span>{operationError || operationNotice}</span>
                {operationError && <button type="button" onClick={() => setOperationError("")} aria-label="關閉錯誤訊息">關閉</button>}
              </div>
            )}
          </>
        ) : null}
      </div>
    </main>
  );
}

function PageHeader({ dashboard, onRefresh, refreshing }: { dashboard?: PaperAutomationDashboard; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <header className="pa-header">
      <div>
        <div className="pa-breadcrumb"><span>個人研究桌</span><span aria-hidden="true">/</span><strong>紙上自動模擬</strong></div>
        <div className="pa-title-line">
          <div><span className="pa-overline">RESEARCH → SIMULATION</span><h1>自動化紙上交易</h1></div>
          <span className="pa-title-mark"><Activity size={22} aria-hidden="true" /></span>
        </div>
        <p className="pa-intro">把可核對的個股與臺指期訊號，轉成有風險界線、可追溯的紙上模擬紀錄。</p>
      </div>
      {onRefresh && <button type="button" className="pa-refresh" onClick={onRefresh} disabled={refreshing} data-testid="button-refresh-paper-dashboard"><RefreshCw size={14} className={refreshing ? "pa-spin" : ""} aria-hidden="true" />{refreshing ? "同步中" : "重新整理"}</button>}
      {dashboard?.enabled && <span className="sr-only">紙上模擬監控中</span>}
    </header>
  );
}

function EmptyBlock({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="pa-empty">
      <span aria-hidden="true"><Activity size={17} /></span>
      <div><strong>{title}</strong><p>{detail}</p></div>
    </div>
  );
}

export default PaperAutotraderPage;
