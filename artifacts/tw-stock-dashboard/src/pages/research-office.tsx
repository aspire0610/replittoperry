import { useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  Check,
  Clock3,
  LoaderCircle,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  getGetAccountStockResearchAgentsQueryKey,
  useCreateAccountStockResearchAgent,
  useDeleteAccountStockResearchAgent,
  useGetAccountStockResearchAgents,
  useRunAccountStockResearchAgent,
  useUpdateAccountStockResearchAgent,
  type AiStockResearchAgent,
  type AiStockResearchReport,
} from "@workspace/api-client-react";
import "./research-office.css";

export type ResearchJobStatus = "queued" | "running" | "completed" | "failed";
export type ResearchChannel = "web" | "line";

export type ResearchAgent = {
  id: string | number;
  name: string;
  specialty: string;
  task: string;
  status: ResearchJobStatus;
  analysis: string;
  sources: Array<{ title: string; url: string }>;
};

export type ResearchJob = {
  id: string | number;
  question: string;
  channel: ResearchChannel;
  status: ResearchJobStatus;
  createdAt: string;
  answer: string;
  agents: ResearchAgent[];
};

export type ResearchOfficePageProps = {
  jobs: ResearchJob[];
  selectedJobId: ResearchJob["id"] | null;
  onSelectJob: (jobId: ResearchJob["id"]) => void;
  isLoading: boolean;
  onRefresh: () => void | Promise<void>;
  error?: string | null;
};

const statusLabels: Record<ResearchJobStatus, string> = {
  queued: "排隊中",
  running: "研究中",
  completed: "已完成",
  failed: "執行失敗",
};

const dateTime = (value: string) => {
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
        hour12: false,
      });
};

const taipeiDateTime = (value: string | null | undefined) => {
  if (!value) return "尚未執行";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-TW", {
        timeZone: "Asia/Taipei",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
};

function reportSources(report: AiStockResearchReport): Array<{ title: string; url: string }> {
  const assessment = report.assessment;
  if (!assessment || typeof assessment !== "object") return [];
  const record = assessment as Record<string, unknown>;
  const entries = [record.sources, record.evidence, record.references].find(Array.isArray);
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const source = entry as Record<string, unknown>;
    const url = typeof source.url === "string" ? source.url : typeof source.href === "string" ? source.href : "";
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) return [];
    } catch {
      return [];
    }
    return [{ title: typeof source.title === "string" ? source.title : url, url }];
  });
}

function reportQuoteAsOf(report: AiStockResearchReport): string | null {
  if (!report.assessment || typeof report.assessment !== "object") return null;
  const context = (report.assessment as Record<string, unknown>).context;
  if (!context || typeof context !== "object") return null;
  const quoteAsOf = (context as Record<string, unknown>).quoteAsOf;
  return typeof quoteAsOf === "string" ? quoteAsOf : null;
}

function StockAgentManagement() {
  const queryClient = useQueryClient();
  const agentsQuery = useGetAccountStockResearchAgents({
    query: {
      queryKey: getGetAccountStockResearchAgentsQueryKey(),
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: 5_000,
      refetchIntervalInBackground: false,
    },
    request: { credentials: "include" },
  });
  const createAgent = useCreateAccountStockResearchAgent({ request: { credentials: "include" } });
  const updateAgent = useUpdateAccountStockResearchAgent({ request: { credentials: "include" } });
  const deleteAgent = useDeleteAccountStockResearchAgent({ request: { credentials: "include" } });
  const runAgent = useRunAccountStockResearchAgent({ request: { credentials: "include" } });
  const [symbol, setSymbol] = useState("");
  const [mission, setMission] = useState("");
  const [formError, setFormError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const busy = createAgent.isPending || updateAgent.isPending || deleteAgent.isPending || runAgent.isPending;
  const agents = agentsQuery.data ?? [];
  const invalidateAgents = () => queryClient.invalidateQueries({ queryKey: getGetAccountStockResearchAgentsQueryKey() });
  const agentErrorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，請稍後重試。";

  const submitAgent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(normalizedSymbol)) {
      setFormError("請輸入 4–6 碼台股代號，例如 2330。");
      return;
    }
    if (!mission.trim()) {
      setFormError("請為這位研究員指定任務。");
      return;
    }
    setFormError("");
    setMutationError("");
    createAgent.mutate(
      { data: { symbol: normalizedSymbol, mission: mission.trim() } },
      {
        onSuccess: () => {
          setSymbol("");
          setMission("");
          void invalidateAgents();
        },
        onError: (error) => setMutationError(agentErrorText(error)),
      },
    );
  };

  const toggleAgent = (agent: AiStockResearchAgent) => {
    setMutationError("");
    updateAgent.mutate(
      { agentId: agent.id, data: { enabled: !agent.enabled } },
      { onSuccess: () => void invalidateAgents(), onError: (error) => setMutationError(agentErrorText(error)) },
    );
  };
  const queueRun = (agent: AiStockResearchAgent) => {
    setMutationError("");
    runAgent.mutate(
      { agentId: agent.id },
      { onSuccess: () => void invalidateAgents(), onError: (error) => setMutationError(agentErrorText(error)) },
    );
  };
  const removeAgent = (agentId: string) => {
    setMutationError("");
    deleteAgent.mutate(
      { agentId },
      {
        onSuccess: () => {
          setConfirmDeleteId(null);
          void invalidateAgents();
        },
        onError: (error) => setMutationError(agentErrorText(error)),
      },
    );
  };

  return (
    <section className="stock-agents-panel" aria-labelledby="stock-agents-heading">
      <div className="stock-agents-panel-head">
        <div>
          <p className="research-eyebrow">持續研究・盤後排程</p>
          <h2 id="stock-agents-heading">個股研究員</h2>
          <p>每檔股票配置一位專家；每日收盤後自動整理，手動執行只會送出工作，不代表報告已完成。</p>
        </div>
        <div className="stock-agent-count" aria-label={`${agents.length} 位研究員`}>
          <strong>{String(agents.length).padStart(2, "0")}</strong><span>位研究員</span>
        </div>
      </div>
      <div className="stock-agents-layout">
        <form className="stock-agent-create" onSubmit={submitAgent} noValidate>
          <div className="stock-agent-create-title">
            <span className="stock-agent-create-icon"><Plus size={16} aria-hidden="true" /></span>
            <div><strong>建立研究員</strong><small>定義標的與研究範圍</small></div>
          </div>
          <label htmlFor="stock-agent-symbol">台股代號</label>
          <div className="stock-agent-symbol-wrap">
            <input
              id="stock-agent-symbol"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              placeholder="例如 2330"
              maxLength={6}
              autoComplete="off"
              aria-describedby={formError ? "stock-agent-form-error" : "stock-agent-symbol-hint"}
              data-testid="input-stock-agent-symbol"
              disabled={createAgent.isPending}
            />
            <span className="mono">TWSE / TPEx</span>
          </div>
          <small id="stock-agent-symbol-hint" className="stock-agent-hint">4–6 碼英數代號，不含市場後綴</small>
          <label htmlFor="stock-agent-mission">自訂研究任務</label>
          <textarea
            id="stock-agent-mission"
            value={mission}
            onChange={(event) => setMission(event.target.value)}
            placeholder="例如：追蹤營收動能、法說會指引與主要風險，引用可核對的來源。"
            maxLength={500}
            rows={4}
            aria-describedby={formError ? "stock-agent-form-error" : undefined}
            data-testid="input-stock-agent-mission"
            disabled={createAgent.isPending}
          />
          <div className="stock-agent-form-foot">
            <small>{mission.length}/500</small>
            <button className="stock-agent-primary" type="submit" disabled={createAgent.isPending} data-testid="button-create-stock-agent">
              {createAgent.isPending ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
              {createAgent.isPending ? "正在建立" : "建立研究員"}
            </button>
          </div>
          {formError && <p className="stock-agent-inline-error" id="stock-agent-form-error" role="alert">{formError}</p>}
          <p className="stock-agent-schedule-note"><CalendarClock size={13} aria-hidden="true" />自動排程由伺服器管理；此頁不會模擬背景執行。</p>
        </form>

        <div className="stock-agent-list-wrap" aria-label="已建立的個股研究員">
          <div className="stock-agent-list-head">
            <div><strong>研究席位</strong><span>狀態、排程與最新報告</span></div>
            <button
              type="button"
              className="stock-agent-refresh"
              onClick={() => void agentsQuery.refetch()}
              disabled={agentsQuery.isFetching}
              aria-label="更新研究員清單"
              data-testid="button-refresh-stock-agents"
            ><RefreshCw size={14} className={agentsQuery.isFetching ? "is-spinning" : ""} aria-hidden="true" /></button>
          </div>
          {mutationError && <div className="stock-agent-operation-error" role="alert"><AlertTriangle size={15} aria-hidden="true" /><span>{mutationError}</span></div>}
          {agentsQuery.isError ? (
            <div className="stock-agent-query-state is-error" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              <div><strong>研究員資料無法載入</strong><p>請確認登入狀態與連線，再重新讀取。</p></div>
              <button type="button" onClick={() => void agentsQuery.refetch()} disabled={agentsQuery.isFetching} data-testid="button-retry-stock-agents">重試</button>
            </div>
          ) : agentsQuery.isLoading ? (
            <div className="stock-agent-skeleton-list" role="status" aria-label="正在載入研究員">
              {[0, 1].map((item) => <div className="stock-agent-skeleton" key={item}><i /><i /><i /></div>)}
            </div>
          ) : agents.length === 0 ? (
            <div className="stock-agent-empty" data-testid="empty-stock-agents">
              <span className="stock-agent-empty-mark"><Search size={19} aria-hidden="true" /></span>
              <strong>研究席位尚未建立</strong>
              <p>從左側建立第一位個股專家。每位研究員都會保留自己的任務與逐日報告。</p>
            </div>
          ) : (
            <div className="stock-agent-list">
              {agents.map((agent) => {
                const latest = agent.reports?.[0];
                const lastRunAt = agent.lastRunAt ? Date.parse(agent.lastRunAt) : 0;
                const latestReportAt = latest ? Date.parse(latest.asOf) : 0;
                const nextRunAt = Date.parse(agent.nextRunAt);
                const isQueued = agent.enabled &&
                  nextRunAt <= Date.now() &&
                  (!lastRunAt || lastRunAt <= latestReportAt);
                const isRunning = agent.enabled &&
                  lastRunAt > latestReportAt &&
                  !agent.lastError;
                const runState = !agent.enabled
                  ? "paused"
                  : isQueued
                    ? "queued"
                    : latest?.status === "failed" && agent.lastError
                      ? "failed"
                      : isRunning
                        ? "running"
                        : "monitoring";
                const runStateLabel = {
                  paused: "已暫停",
                  queued: "排隊中",
                  running: "執行中",
                  failed: "上次失敗",
                  monitoring: "追蹤中",
                }[runState];
                const operationPending = busy;
                return (
                  <article className={`stock-agent-card${agent.lastError ? " has-error" : ""}`} key={agent.id} data-testid={`card-stock-agent-${agent.id}`}>
                    <div className="stock-agent-card-top">
                      <div className="stock-agent-symbol-mark">{agent.symbol}</div>
                      <div className="stock-agent-identity">
                        <div className="stock-agent-name-line"><h3>{agent.name}</h3><span className={`stock-agent-state is-${runState}`}><i aria-hidden="true" />{runStateLabel}</span></div>
                        <p>{agent.mission}</p>
                      </div>
                      <div className="stock-agent-actions" role="group" aria-label={`${agent.symbol} 研究員控制`}>
                        <button type="button" onClick={() => queueRun(agent)} disabled={operationPending || isQueued || isRunning} className="stock-agent-action is-run" data-testid={`button-run-stock-agent-${agent.id}`}>
                          {runAgent.isPending || isQueued || isRunning ? <LoaderCircle size={13} className="is-spinning" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                          <span>{isQueued ? "排隊中" : isRunning ? "執行中" : "立即執行"}</span>
                        </button>
                        <button type="button" onClick={() => toggleAgent(agent)} disabled={operationPending} className="stock-agent-action" data-testid={`button-toggle-stock-agent-${agent.id}`} aria-label={agent.enabled ? `暫停 ${agent.symbol} 研究員` : `恢復 ${agent.symbol} 研究員`}>
                          {agent.enabled ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                          <span>{agent.enabled ? "暫停" : "恢復"}</span>
                        </button>
                        <button type="button" onClick={() => setConfirmDeleteId(confirmDeleteId === agent.id ? null : agent.id)} disabled={operationPending} className="stock-agent-action is-delete" aria-label={`刪除 ${agent.symbol} 研究員`} data-testid={`button-delete-stock-agent-${agent.id}`}>
                          <Trash2 size={13} aria-hidden="true" /><span>刪除</span>
                        </button>
                      </div>
                    </div>
                    {confirmDeleteId === agent.id && (
                      <div className="stock-agent-confirm" role="alert">
                        <span>刪除 {agent.symbol} 研究員及其報告？此動作無法復原。</span>
                        <button type="button" onClick={() => removeAgent(agent.id)} disabled={deleteAgent.isPending} data-testid={`button-confirm-delete-stock-agent-${agent.id}`}>{deleteAgent.isPending ? "刪除中" : "確認刪除"}</button>
                        <button type="button" onClick={() => setConfirmDeleteId(null)} disabled={deleteAgent.isPending}>取消</button>
                      </div>
                    )}
                    <div className="stock-agent-run-meta">
                      <span><CalendarClock size={13} aria-hidden="true" /><small>下次執行</small><strong>{agent.enabled ? taipeiDateTime(agent.nextRunAt) : "暫停中"}</strong></span>
                      <span><Clock3 size={13} aria-hidden="true" /><small>最近執行</small><strong>{taipeiDateTime(agent.lastRunAt)}</strong></span>
                      {agent.lastMarketDate && <span><Check size={13} aria-hidden="true" /><small>最近交易日</small><strong>{agent.lastMarketDate}</strong></span>}
                    </div>
                    {agent.lastError && <p className="stock-agent-last-error" role="status"><AlertTriangle size={13} aria-hidden="true" />最近執行未完成：{agent.lastError}</p>}
                    <div className="stock-agent-report">
                      <div className="stock-agent-report-head">
                        <strong>最新盤後報告</strong>
                        {latest ? <span className={`stock-report-status is-${latest.status}`}>{latest.status === "completed" ? "已完成" : "執行失敗"}</span> : <span className="stock-report-status is-empty">尚無報告</span>}
                      </div>
                      {latest ? (
                        <div className="stock-agent-report-content">
                          <p className="stock-agent-report-stamp">交易日 {latest.marketDate ?? "日期未提供"} <span>・</span> 報告時間 {taipeiDateTime(latest.asOf)} <span>・</span> 行情時間 {taipeiDateTime(reportQuoteAsOf(latest))}</p>
                          {latest.answer && (latest.status === "completed" || latest.assessment)
                            ? <p className="stock-agent-report-answer">{latest.answer}</p>
                            : <p className="stock-agent-report-error">{latest.error || "本次執行未產生可用報告；不會以預設內容代替研究結果。"}</p>}
                          {latest.assessment && <details className="stock-agent-assessment"><summary>判讀資料</summary><pre>{JSON.stringify(latest.assessment, null, 2)}</pre></details>}
                          {reportSources(latest).length > 0 && (
                            <details className="stock-agent-evidence">
                              <summary>來源證據（{reportSources(latest).length}）</summary>
                              <ul>{reportSources(latest).map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer" data-testid={`link-stock-agent-source-${agent.id}-${index}`}>{source.title}<ArrowUpRight size={13} aria-hidden="true" /></a></li>)}</ul>
                            </details>
                          )}
                        </div>
                      ) : <p className="stock-agent-no-report">尚未有已完成的盤後報告。手動執行會送出工作，結果將在伺服器完成後更新。</p>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {agentsQuery.isFetching && !agentsQuery.isLoading && <p className="stock-agent-updating" role="status">正在同步研究員資料…</p>}
    </section>
  );
}

function ResearchStatus({ status }: { status: ResearchJobStatus }) {
  return (
    <span className={`research-status is-${status}`} data-testid={`status-research-${status}`}>
      <span className="research-status-dot" aria-hidden="true" />
      {statusLabels[status]}
    </span>
  );
}

function JobSkeleton() {
  return (
    <div className="research-job-skeleton" aria-hidden="true">
      <span /><span /><span /><span />
    </div>
  );
}

export function ResearchOfficePage({
  jobs,
  selectedJobId,
  onSelectJob,
  isLoading,
  onRefresh,
  error,
}: ResearchOfficePageProps) {
  const selectedJob = jobs.find((job) => String(job.id) === String(selectedJobId));

  return (
    <main className="research-office-page" data-testid="page-research-office">
      <div className="research-office-inner">
        <div className="research-office-topline">
          <div className="research-breadcrumb">
            <span>研究部</span><span aria-hidden="true">/</span><strong>研究紀錄</strong>
          </div>
          <button
            type="button"
            className="research-refresh"
            onClick={() => void onRefresh()}
            disabled={isLoading}
            data-testid="button-refresh-research"
          >
            <RefreshCw size={15} className={isLoading ? "is-spinning" : ""} aria-hidden="true" />
            {isLoading ? "同步中" : "更新紀錄"}
          </button>
        </div>

        <header className="research-hero">
          <div>
            <p className="research-eyebrow">CEO 研究部</p>
            <h1>研究紀錄</h1>
            <p className="research-hero-copy">先看判讀與操作方向；需要時再展開專家分析和資料來源。</p>
          </div>
          <div className="research-hero-index" aria-label="研究紀錄數量">
            <strong>{jobs.length}</strong><span>筆</span>
          </div>
        </header>

        <StockAgentManagement />

        <section className="research-workspace" aria-label="研究委派工作區">
          <aside className="research-job-rail" aria-label="研究工作清單">
            <div className="research-list-heading">
              <div>
                <p className="research-eyebrow">歷次分析</p>
                <h2>研究紀錄</h2>
              </div>
              <span className="research-total mono">{jobs.length.toString().padStart(2, "0")}</span>
            </div>

            {error ? (
              <div className="research-error" role="alert" data-testid="status-research-error">
                <AlertTriangle size={19} aria-hidden="true" />
                <div><strong>紀錄暫時無法載入</strong><p>{error}</p></div>
                <button type="button" onClick={() => void onRefresh()} disabled={isLoading} data-testid="button-retry-research">
                  重試
                </button>
              </div>
            ) : isLoading && jobs.length === 0 ? (
              <div className="research-list-loading" role="status" aria-label="正在載入研究紀錄" data-testid="status-research-loading">
                <JobSkeleton /><JobSkeleton /><JobSkeleton />
              </div>
            ) : jobs.length === 0 ? (
              <div className="research-list-empty" data-testid="empty-research-jobs">
                <span className="research-empty-symbol"><Sparkles size={20} aria-hidden="true" /></span>
                <strong>尚無委派紀錄</strong>
                <p>CEO 建立研究問題後，工作與專家成果會顯示於此。</p>
              </div>
            ) : (
              <div className="research-job-list" role="list">
                {jobs.map((job) => {
                  const active = String(job.id) === String(selectedJobId);
                  return (
                    <button
                      type="button"
                      className={`research-job-item${active ? " is-selected" : ""}`}
                      key={job.id}
                      onClick={() => onSelectJob(job.id)}
                      aria-current={active ? "true" : undefined}
                      data-testid={`button-select-research-job-${job.id}`}
                    >
                      <span className="research-job-item-head">
                        <span className={`research-channel is-${job.channel}`}>
                          {job.channel === "line" ? <MessageCircle size={12} aria-hidden="true" /> : <Search size={12} aria-hidden="true" />}
                          {job.channel === "line" ? "LINE" : "WEB"}
                        </span>
                        <ResearchStatus status={job.status} />
                      </span>
                      <strong className="research-job-question">{job.question}</strong>
                      <span className="research-job-meta"><Clock3 size={12} aria-hidden="true" />{dateTime(job.createdAt)}</span>
                      <ArrowUpRight className="research-job-arrow" size={15} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            )}
            {isLoading && jobs.length > 0 && <p className="research-updating" role="status">正在同步最新紀錄…</p>}
          </aside>

          <section className="research-detail" aria-label="委派研究詳細內容">
            {selectedJob ? (
              <>
                <header className="research-detail-header">
                  <div className="research-detail-meta">
                    <span className="research-eyebrow">研究問題</span>
                    <ResearchStatus status={selectedJob.status} />
                  </div>
                  <p className="research-detail-date"><Clock3 size={13} aria-hidden="true" />{dateTime(selectedJob.createdAt)} ・ {selectedJob.channel === "line" ? "LINE" : "網站"}</p>
                  <h2 data-testid={`text-research-question-${selectedJob.id}`}>{selectedJob.question}</h2>
                </header>

                <section className="research-answer" aria-labelledby="research-answer-title">
                  <div className="research-answer-content">
                    <div className="research-section-title">
                      <div><h3 id="research-answer-title">CEO 判讀</h3></div>
                    </div>
                    {selectedJob.answer ? (
                      <p className="research-answer-text" data-testid={`text-research-answer-${selectedJob.id}`}>{selectedJob.answer}</p>
                    ) : (
                      <p className="research-pending-answer" data-testid={`empty-research-answer-${selectedJob.id}`}>
                        {selectedJob.status === "failed" ? "本次研究未能產生最終結論。" : "研究團隊仍在整理資料，結論完成後會顯示於此。"}
                      </p>
                    )}
                  </div>
                </section>

                <section className="research-agents-section" aria-labelledby="research-agents-title">
                  <div className="research-agents-heading">
                    <div><h3 id="research-agents-title">研究員分析</h3></div>
                    <span className="research-agent-count">{selectedJob.agents.length} 位</span>
                  </div>

                  {selectedJob.agents.length ? (
                    <div className="research-agent-list">
                      {selectedJob.agents.map((agent, index) => (
                        <article className="research-agent-card" key={agent.id} data-testid={`card-research-agent-${agent.id}`}>
                          <div className="research-agent-identity">
                            <div><h4 data-testid={`text-research-agent-name-${agent.id}`}>{agent.name}</h4><span>{agent.specialty}</span></div>
                          </div>
                          <div className="research-agent-body">
                            <div className="research-agent-analysis">
                              <div className="research-agent-result-head"><span>分析結果</span><ResearchStatus status={agent.status} /></div>
                              <p data-testid={`text-research-agent-analysis-${agent.id}`}>{agent.analysis || (agent.status === "failed" ? "此專家未能提交分析結果。" : "分析結果尚未提交。")}</p>
                            </div>
                            <details className="research-evidence">
                              <summary>任務與資料來源（{agent.sources.length}）</summary>
                              <p>{agent.task}</p>
                              {agent.sources.length ? (
                                <ul>
                                  {agent.sources.map((source, sourceIndex) => (
                                    <li key={`${source.url}-${sourceIndex}`}>
                                      <a href={source.url} target="_blank" rel="noopener noreferrer" data-testid={`link-research-source-${agent.id}-${sourceIndex}`}>
                                        {source.title}<ArrowUpRight size={13} aria-hidden="true" />
                                      </a>
                                    </li>
                                  ))}
                                </ul>
                              ) : <p className="research-no-sources">目前沒有列出來源。</p>}
                            </details>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="research-no-agents" data-testid={`empty-research-agents-${selectedJob.id}`}>
                      <span className="research-agent-empty-mark">—</span>
                      <div><strong>尚無專家工作紀錄</strong><p>專家分派與分析完成後，工作脈絡會收錄於此。</p></div>
                    </div>
                  )}
                </section>
                <p className="research-disclaimer">資料以畫面所示時間為準；市場變動快速，操作前請核對最新行情。</p>
              </>
            ) : (
              <div className="research-detail-empty" data-testid="empty-research-selection">
                <span className="research-detail-empty-mark"><Search size={24} aria-hidden="true" /></span>
                <p className="research-eyebrow">研究紀錄</p>
                <h2>{jobs.length ? "選擇一筆研究" : "目前沒有研究紀錄"}</h2>
                <p>{jobs.length ? "選取左側項目，查看判讀和依據。" : "透過 CEO 提出研究問題後，結果會保存在這裡。"}</p>
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}

export default ResearchOfficePage;
