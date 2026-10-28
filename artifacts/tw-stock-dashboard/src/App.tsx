import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { motion } from "framer-motion";
import {
  calculateBudgetShareLimit,
  calculateRoundTripEstimate,
  TAIWAN_STOCK_BUY_COMMISSION_RATE,
} from "./lib/budget-sizing";
import {
  matchesBuyVerdictInputs,
  usesDifferentAnalysisVersion,
} from "./lib/buy-verdict-display";
import { evaluateChipExhaustion } from "./lib/chip-exhaustion";
import { splitAssistantAnswer } from "./lib/assistant-chat-format";
import {
  getStockQuoteDisplayStatus,
  getStockQuoteFallbackReason,
} from "./lib/stock-quote-display";
import { StockAiHistoricalValidation } from "./components/stock-ai-historical-validation";
import { StockAiScorecardDetails } from "./components/stock-ai-scorecard";
import {
  isTaipeiClosingSummaryHours,
  isTaipeiPremarketSummaryHours,
} from "./lib/market-summary-window";
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, useAuth, useClerk } from "@clerk/react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bookmark,
  BookmarkCheck,
  Briefcase,
  Calculator,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ChevronUp,
  Download,
  FlaskConical,
  Info,
  LayoutDashboard,
  LogIn,
  LogOut,
  MessageCircle,
  Moon,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Target,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ErrorBar,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  evaluateStockAiBuyPrice,
  askAssistantChat,
  askStockAiAssistant,
  useDeleteAccountStockAiConversation,
  useGetAccountStockAiConversation,
  useGetAccountResearchJobs,
  useGetFuturesAiDayStrategy,
  useGetMarketIntraday,
  useGetMarketHistory,
  useGetMarketOverview,
  useGetMarketSummary,
  useGetMarketAiDailySummary,
  getMarketAiDailySummary,
  useGetStockAiAssessment,
  useGetStockCatalog,
  useGetStockHistory,
  useGetStockResearchData,
  usePutAccountStockAiConversation,
  type FuturesAiDayStrategy,
  type MarketAiDailySummary,
  type MarketIntradayHistory,
  type MarketSummaryResponse,
  type StockAiConversationMessage,
  type StockAiAssessment,
  type StockResearchData,
} from "@workspace/api-client-react";
import { ErrorBoundary } from "@/components/error-boundary";
import { AccountWatchlistProvider, useAccountWatchlist, type WatchlistEntry } from "@/components/account-watchlist";
import { CardOrderWorkspace, useCardOrder } from "@/components/card-order-workspace";
import { DashboardLoginIntro } from "@/components/dashboard-login-intro";
import { StartupIntroGate } from "@/components/startup-intro";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/hooks/use-toast";
import { TooltipProvider } from "@/components/ui/tooltip";

import { Link, Route, Switch, Router as WouterRouter, useLocation } from "wouter";
import { AcceptInvitationPage, AdminUsersPage, SignInPage } from "@/pages/account";
import QuantLabPage from "@/pages/quant-lab";
import AiPicksPage from "@/pages/ai-picks";
import { ResearchOfficePage, type ResearchJob as ResearchOfficeJob } from "@/pages/research-office";
import SystemSettingsPage from "@/pages/system-settings";
import EtfSavingsPage from "@/pages/etf-savings";
import NotFound from "@/pages/not-found";

type Range = "1mo" | "3mo" | "6mo" | "1y";
type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number | null };
type CardId = "stock-search" | "market-index" | "market-analysis" | "stock-analysis" | "market-summary" | "market-intraday" | "market-history" | "futures-strategy" | "stock-metrics" | "research-data" | "ai-assessment" | "price-chart" | "volume-chart" | "calculator" | "technical-ledger";

const CARD_ORDER_STORAGE_KEY = "tw-stock-dashboard-card-layout-v1";
const CARD_LAYOUT_VERSION = 3;
const SELECTED_SYMBOL_STORAGE_KEY = "tw-stock-dashboard-selected-symbol";
const SELECTED_SYMBOL_CHANGE_EVENT = "tw-stock-dashboard:selected-symbol-change";
let selectedSymbolMemory = "2330";

function readSelectedSymbol() {
  try {
    const stored = window.localStorage.getItem(SELECTED_SYMBOL_STORAGE_KEY);
    if (stored) selectedSymbolMemory = stored;
  } catch { /* share the in-memory selection during this session */ }
  return selectedSymbolMemory;
}

function storeSelectedSymbol(symbol: string) {
  selectedSymbolMemory = symbol;
  try { window.localStorage.setItem(SELECTED_SYMBOL_STORAGE_KEY, symbol); } catch { /* route state is still updated in memory */ }
  window.dispatchEvent(new Event(SELECTED_SYMBOL_CHANGE_EVENT));
}
const DEFAULT_CARD_ORDER: CardId[] = [
  "stock-search",
  "market-index",
  "market-intraday",
  "market-analysis",
  "stock-analysis",
  "market-summary",
  "market-history",
  "futures-strategy",
  "stock-metrics",
  "research-data",
  "ai-assessment",
  "price-chart",
  "volume-chart",
  "calculator",
  "technical-ledger",
];

const CARD_DOCK_TITLES: Partial<Record<CardId, string>> = {
  "stock-search": "個股搜尋與報價",
  "market-index": "加權指數與市場行情",
  "market-intraday": "加權指數分時",
  "market-analysis": "台股大盤走勢",
  "market-summary": "大盤概況",
  "market-history": "大盤每日收盤",
  "futures-strategy": "臺指期日盤參考",
  "stock-metrics": "個股快速摘要",
  "research-data": "公司財報與投資人買賣",
  "ai-assessment": "AI 個股方向參考",
  "price-chart": "股價走勢",
  "volume-chart": "成交量",
  "technical-ledger": "股價計算明細",
};

function readCardLayout() {
  const fallback = { order: [...DEFAULT_CARD_ORDER], collapsed: {} as Partial<Record<CardId, boolean>> };
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(CARD_ORDER_STORAGE_KEY);
    if (!stored) return fallback;
    const parsed = JSON.parse(stored) as { version?: unknown; order?: unknown; collapsed?: unknown };
    const currentVersionOrder = parsed.version === CARD_LAYOUT_VERSION && Array.isArray(parsed.order)
      ? parsed.order.filter((id): id is CardId => DEFAULT_CARD_ORDER.includes(id as CardId))
      : [];
    const storedOrder = currentVersionOrder;
    const order = [...storedOrder, ...DEFAULT_CARD_ORDER.filter((id) => !storedOrder.includes(id))];
    const collapsed = parsed.collapsed && typeof parsed.collapsed === "object" ? parsed.collapsed as Partial<Record<CardId, boolean>> : {};
    return { order, collapsed };
  } catch {
    return fallback;
  }
}
type StockQuote = {
  name: string | null;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  source: string;
  asOf: string | null;
  available: boolean;
  error: string | null;
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

const LIVE_QUOTE_INTERVAL_MS = 5_000;
const LIVE_MARKET_INTERVAL_MS = 1_000;
const MARKET_SUMMARY_INTERVAL_MS = 15_000;

type MarketDailySummaryMode = "premarket" | "closing";

const CHART_COLORS = {
  rising: "#c84b31",
  falling: "#357b70",
  signal: "#d29a28",
  ink: "#233044",
  grid: "#d7dbe0",
};

const RANGES: { value: Range; label: string }[] = [
  { value: "1mo", label: "1 個月" },
  { value: "3mo", label: "3 個月" },
  { value: "6mo", label: "6 個月" },
  { value: "1y", label: "1 年" },
];

function formatNumber(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatCompact(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "無資料";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return typeof value === "string" ? value : "無資料";
  }
  return parsed.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "numeric", day: "numeric" });
}

function formatTime(value: string | null | undefined) {
  if (!value) return "無資料";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatTimeWithSeconds(value: string | null | undefined) {
  if (!value) return "無資料";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatClock(value: number | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function isTaiwanStockSessionOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const minuteOfDay = hour * 60 + minute;
  return (
    ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday ?? "") &&
    minuteOfDay >= 9 * 60 &&
    minuteOfDay < 13 * 60 + 30
  );
}

function formatChartDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(5, 10);
  return parsed.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" });
}

function parseError(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const message = (data as { error?: unknown; message?: unknown; detail?: unknown }).error
        ?? (data as { message?: unknown }).message
        ?? (data as { detail?: unknown }).detail;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  if (error instanceof Error) {
    return error.message.replace(/^HTTP \d{3} [^:]+:\s*/u, "").trim();
  }
  if (error && typeof error === "object" && "error" in error) return String((error as { error?: unknown }).error);
  return "行情來源未回傳可用資料。";
}

function getErrorMarkdownReport(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const reportMarkdown = (data as { reportMarkdown?: unknown }).reportMarkdown;
  return typeof reportMarkdown === "string" && reportMarkdown.trim()
    ? reportMarkdown
    : undefined;
}

function parseConversationSyncError(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object" && "error" in data) {
      const message = (data as { error?: unknown }).error;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return "對話同步失敗；目前頁面的新訊息尚未保存。";
}

function parseAiRequestError(error: unknown) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "AI 回覆逾時，已停止等待。請稍後重試。";
  }
  if (
    error instanceof Error &&
    error.name === "TypeError" &&
    /load failed|failed to fetch|networkerror/i.test(error.message)
  ) {
    return "與 AI 分析服務的連線中斷，請確認網路後重試。";
  }
  const message = parseError(error);
  if (/\b504\b|gateway timeout|AI 分析逾時/iu.test(message)) {
    return "AI 服務逾時，請稍後重試。";
  }
  if (/\b429\b|too many requests|AI 服務目前忙碌/iu.test(message)) {
    return "AI 服務目前忙碌，請稍後重試。";
  }
  if (/\b502\b|bad gateway|AI 備援服務目前無法/iu.test(message)) {
    return "目前沒有 AI 服務成功完成分析，請稍後重試。";
  }
  return message;
}

function calculateAverage(bars: Bar[], period: number) {
  return bars.map((bar, index) => {
    if (index + 1 < period) return null;
    const slice = bars.slice(index + 1 - period, index + 1);
    return slice.reduce((total, item) => total + item.close, 0) / period;
  });
}

function calculateRsi(bars: Bar[], period = 14) {
  if (bars.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = bars.length - period; index < bars.length; index += 1) {
    const difference = bars[index].close - bars[index - 1].close;
    if (difference >= 0) gains += difference;
    else losses += Math.abs(difference);
  }
  const averageGain = gains / period;
  const averageLoss = losses / period;
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function calculateAtr(bars: Bar[], period = 14) {
  if (bars.length <= period) return null;
  const ranges: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    ranges.push(Math.max(
      bars[index].high - bars[index].low,
      Math.abs(bars[index].high - bars[index - 1].close),
      Math.abs(bars[index].low - bars[index - 1].close),
    ));
  }
  const recent = ranges.slice(-period);
  return recent.reduce((total, value) => total + value, 0) / recent.length;
}

function exportCsv(filename: string, rows: Array<Record<string, string | number | null>>) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (value: string | number | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const body = [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function ButtonIcon({
  label,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={`button-${label.toLowerCase().replaceAll(" ", "-")}`}
      onClick={onClick}
      disabled={disabled}
      className="control-icon print-hidden"
    >
      {children}
    </button>
  );
}

function openDashboardPrintDialog() {
  const isFacebookInAppBrowser =
    typeof navigator !== "undefined" &&
    /FBAN|FBAV|FB_IAB/i.test(navigator.userAgent);

  if (isFacebookInAppBrowser) {
    toast({
      title: "請改用 Safari 列印",
      description: "Facebook 內建瀏覽器可能不支援列印。請從瀏覽器選單選「在 Safari 中開啟」，再按列印；也可在 Safari 的分享選單選「列印」。",
    });
    return;
  }

  if (typeof window.print !== "function") {
    toast({
      title: "此瀏覽器不支援列印",
      description: "請使用 Safari 或 Chrome 開啟頁面，再從瀏覽器選單列印或另存 PDF。",
    });
    return;
  }

  window.print();
}

function CsvButton({ filename, rows }: { filename: string; rows: Array<Record<string, string | number | null>> }) {
  return (
    <button
      type="button"
      onClick={() => exportCsv(filename, rows)}
      disabled={!rows.length}
      data-testid={`button-export-${filename.replace(".csv", "")}`}
      aria-label={`匯出 ${filename} CSV`}
      className="csv-button print-hidden"
      title={rows.length ? "匯出圖表資料 CSV" : "目前沒有可匯出的資料"}
    >
      <Download size={14} />
    </button>
  );
}

function WorkspaceCard({
  cardId,
  title,
  toolbarAction,
  scope,
  collapsed,
  onToggle,
  children,
}: {
  cardId: CardId;
  title: string;
  toolbarAction?: ReactNode;
  scope: CardId[];
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const cardOrder = useCardOrder(cardId);
  if (!scope.includes(cardId)) {
    throw new Error(`Workspace card "${cardId}" is outside its registered sorting group.`);
  }
  if (collapsed) return null;

  return (
    <motion.article
      layout="position"
      transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.7 }}
      className="workspace-card"
      style={{ order: cardOrder.orderIndex }}
      data-testid={`card-${cardId}`}
      data-card-id={cardId}
    >
      <div className="workspace-card-toolbar">
        <div className="card-order-controls" role="group" aria-label={`調整「${title}」順序`}>
          <button
            type="button"
            className="card-order-button"
            aria-label={`將「${title}」上移一格`}
            title="上移一格"
            onClick={() => cardOrder.moveBy(-1)}
            disabled={!cardOrder.canMoveUp}
            data-testid={`button-move-up-${cardId}`}
          >
            <ChevronUp size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="card-order-button"
            aria-label={`將「${title}」下移一格`}
            title="下移一格"
            onClick={() => cardOrder.moveBy(1)}
            disabled={!cardOrder.canMoveDown}
            data-testid={`button-move-down-${cardId}`}
          >
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="card-collapse-trigger"
          onClick={onToggle}
          aria-label={`收起「${title}」`}
          aria-expanded="true"
          aria-controls={`card-content-${cardId}`}
          data-testid={`button-toggle-${cardId}`}
        >
          <span>{title}</span>
          <ChevronUp size={15} />
        </button>
        {toolbarAction && (
          <div className="workspace-card-toolbar-action">{toolbarAction}</div>
        )}
      </div>
      <div
        id={`card-content-${cardId}`}
        className="workspace-card-content"
      >
        {children}
      </div>
    </motion.article>
  );
}

function Panel({
  title,
  eyebrow,
  action,
  children,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`glass-panel rounded-[5px] ${className}`}>
      <div className="panel-heading">
        <div>
          {eyebrow && <p className="section-eyebrow">{eyebrow}</p>}
          <h2 className="panel-title" data-testid={`text-panel-${title.toLowerCase().replaceAll(" ", "-")}`}>{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`skeleton-block ${className}`} aria-label="載入中" />;
}

function ProviderError({ message, onRetry, title = "行情來源暫時無法使用", markdownReport }: {
  message: string;
  onRetry: () => void;
  title?: string;
  markdownReport?: string;
}) {
  return (
    <div className="state-box state-error">
      <TriangleAlert size={18} />
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      <button type="button" className="text-button" onClick={onRetry} data-testid="button-retry-provider">重試</button>
      {markdownReport && (
        <details style={{ gridColumn: "1 / -1", width: "100%" }}>
          <summary>量化 Markdown 報告（AI 判讀暫缺）</summary>
          <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.65 }}>
            {markdownReport}
          </pre>
        </details>
      )}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="state-box state-empty">
      <BarChart3 size={18} />
      <div><strong>{title}</strong><p>{detail}</p></div>
    </div>
  );
}

function MarketPrice({ price, available }: { price: number | null; available: boolean }) {
  const previousPrice = useRef<number | null>(price);
  const [tickDirection, setTickDirection] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const previous = previousPrice.current;
    previousPrice.current = price;
    if (previous === null || price === null || previous === price) return undefined;

    setTickDirection(price > previous ? "up" : "down");
    const timeout = window.setTimeout(() => setTickDirection(null), 720);
    return () => window.clearTimeout(timeout);
  }, [price]);

  return (
    <div className={`quote-value ${tickDirection ? `quote-tick-${tickDirection}` : ""}`}>
      {available && price !== null ? formatNumber(price, 2) : "無即時報價"}
    </div>
  );
}

type MarketStripQuote = {
  key: string;
  name: string;
  ticker: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  source: string | null;
  asOf: string | null;
  available: boolean;
  error: string | null;
};

function MarketQuoteReadout({ quote }: { quote: MarketStripQuote }) {
  const rising = (quote.changePercent ?? 0) >= 0;
  const timeLabel = quote.source?.includes("收盤")
    ? "收盤"
    : quote.source?.includes("非交易時段更新")
      ? "更新"
      : "成交";
  const isDailyReportQuote = quote.source?.includes("TAIFEX 官方日行情") ?? false;
  return (
    <div className="market-quote" key={quote.key} data-testid={`status-market-quote-${quote.key}`}>
      <div className="quote-name">{quote.name} <span>{quote.ticker}</span></div>
      <MarketPrice price={quote.price} available={quote.available} />
      <div className={`quote-change ${quote.available ? rising ? "is-rising" : "is-falling" : ""}`}>
        {quote.available && (rising ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />)}
        {quote.available ? `${formatNumber(quote.change, 2)} / ${formatPercent(quote.changePercent)}` : quote.error?.includes("429") ? "行情來源暫時限流" : quote.error ?? "行情來源暫時無法提供"}
      </div>
      <div className="quote-source">
        {quote.source ?? "未提供來源"}
        {quote.asOf
          ? isDailyReportQuote
            ? ` · 交易日 ${formatDate(quote.asOf)} · 成交時間未提供`
            : ` · ${timeLabel} ${formatTimeWithSeconds(quote.asOf)}`
          : " · 無可用來源時間"}
      </div>
    </div>
  );
}

function UsMarketIndicator({
  quote,
  fallbackKey,
  fallbackName,
  fallbackTicker,
}: {
  quote: MarketStripQuote | undefined;
  fallbackKey: string;
  fallbackName: string;
  fallbackTicker: string;
}) {
  const changePercent = quote?.changePercent ?? null;
  const directionClass =
    changePercent === null
      ? ""
      : changePercent > 0
        ? "is-rising"
        : changePercent < 0
          ? "is-falling"
          : "is-neutral";

  return (
    <div
      className="market-us-indicator"
      data-testid={`status-market-quote-${quote?.key ?? fallbackKey}`}
    >
      <div className="market-us-indicator-name">
        <strong>{quote?.name ?? fallbackName}</strong>
        <span>{quote?.ticker ?? fallbackTicker}</span>
      </div>
      {quote?.available && changePercent !== null ? (
        <div className={`market-us-indicator-change ${directionClass}`}>
          {changePercent > 0 ? (
            <ArrowUpRight size={15} />
          ) : changePercent < 0 ? (
            <ArrowDownRight size={15} />
          ) : null}
          {formatPercent(changePercent)}
        </div>
      ) : (
        <div className="market-us-indicator-unavailable">
          {quote?.error?.includes("429")
            ? "行情來源暫時限流"
            : quote?.error ?? "行情來源目前沒有回傳報價"}
        </div>
      )}
      <small className="market-us-indicator-source">
        {quote?.source ?? "未提供來源"}
        {quote?.asOf
          ? ` · ${formatDate(quote.asOf)} ${formatTimeWithSeconds(quote.asOf)}`
          : quote?.source?.includes("資料日期")
            ? ""
            : " · 無來源時間"}
      </small>
    </div>
  );
}

function UsMarketIndicators({
  overview,
  loading,
}: {
  overview: { indices?: MarketStripQuote[] } | undefined;
  loading: boolean;
}) {
  const quotes = overview?.indices ?? [];
  if (loading || quotes.length === 0) return null;

  const tsmAdrQuote = quotes.find((quote) => quote.key === "us_tsm_adr");
  const soxQuote = quotes.find((quote) => quote.key === "us_sox");

  return (
    <section
      className="market-us-indicators-panel"
      aria-label="美股指標"
      data-testid="status-market-us-indicators"
    >
      <div className="market-us-indicators-heading">
        <div className="market-us-indicators-label">
          <strong>美股指標</strong>
          <small>台積電 ADR 與費城半導體指數</small>
        </div>
        <span>最新漲跌幅</span>
      </div>
      <div className="market-us-indicators">
        <UsMarketIndicator
          quote={tsmAdrQuote}
          fallbackKey="us_tsm_adr"
          fallbackName="台積電 ADR"
          fallbackTicker="TSM"
        />
        <UsMarketIndicator
          quote={soxQuote}
          fallbackKey="us_sox"
          fallbackName="費城半導體指數"
          fallbackTicker="SOX"
        />
      </div>
    </section>
  );
}

function FuturesSessionReadout({
  quote,
  sessionLabel,
}: {
  quote: MarketStripQuote | undefined;
  sessionLabel: "日盤" | "夜盤";
}) {
  if (!quote) {
    return (
      <div className="market-futures-session" data-testid={`status-market-quote-futures_${sessionLabel === "日盤" ? "day" : "night"}`}>
        <strong>{sessionLabel}</strong>
        <span>資料來源未回傳此時段報價</span>
      </div>
    );
  }
  const rising = (quote.changePercent ?? 0) >= 0;
  const isDailyReportQuote =
    quote.source?.includes("TAIFEX 官方日行情") ?? false;
  return (
    <div className="market-futures-session" data-testid={`status-market-quote-${quote.key}`}>
      <div className="market-futures-session-heading">
        <strong>{sessionLabel}</strong>
        <span>{quote.ticker}</span>
        <small>
          {quote.source ?? "未提供來源"}
          {quote.asOf
            ? isDailyReportQuote
              ? ` · 交易日 ${formatDate(quote.asOf)} · 成交時間未提供`
              : ` · ${formatTimeWithSeconds(quote.asOf)}`
            : ""}
        </small>
      </div>
      <div className="market-futures-session-values">
        <MarketPrice price={quote.price} available={quote.available} />
        <div className={`quote-change ${quote.available ? rising ? "is-rising" : "is-falling" : ""}`}>
          {quote.available && (rising ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />)}
          {quote.available ? `${formatNumber(quote.change, 2)} / ${formatPercent(quote.changePercent)}` : "行情資料暫不可用"}
        </div>
      </div>
    </div>
  );
}

function MarketStrip({
  overview,
  lastClose,
  previousClose,
  closeSource,
  closeAsOf,
  updatedAt,
  loading,
  error,
  onRetry,
}: {
  overview: { asOf?: string | null; indices?: MarketStripQuote[] } | undefined;
  lastClose?: number | null;
  previousClose?: number | null;
  closeSource?: string | null;
  closeAsOf?: string | null;
  updatedAt?: number;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const quotes = overview?.indices ?? [];
  const taiexQuote = quotes.find((quote) => quote.key === "taiex");
  const dayQuote = quotes.find((quote) => quote.key === "futures_day");
  const nightQuote = quotes.find((quote) => quote.key === "futures_night");
  const displayedTaiexQuote: MarketStripQuote | undefined =
    taiexQuote?.available || lastClose === null || lastClose === undefined
      ? taiexQuote
      : {
          key: "taiex",
          name: "加權指數",
          ticker: taiexQuote?.ticker ?? "^TWII",
          price: lastClose,
          change:
            previousClose !== null && previousClose !== undefined
              ? lastClose - previousClose
              : null,
          changePercent:
            previousClose !== null &&
            previousClose !== undefined &&
            previousClose > 0
              ? ((lastClose - previousClose) / previousClose) * 100
              : null,
          source: `${closeSource ?? "官方日線"} · 最近收盤價`,
          asOf: closeAsOf ?? null,
          available: true,
          error: null,
        };
  const quoteIsFresh = (quote: MarketStripQuote | undefined) => {
    if (
      !quote?.available ||
      !quote.asOf ||
      quote.source?.includes("盤後") ||
      quote.source?.includes("收盤") ||
      quote.source?.includes("非交易時段更新")
    ) return false;
    const age = Date.now() - new Date(quote.asOf).getTime();
    return age >= -60_000 && age <= 90_000;
  };
  const taiwanQuotes = [displayedTaiexQuote, dayQuote, nightQuote];
  const hasFreshQuote = taiwanQuotes.some(quoteIsFresh);
  const hasAnyQuote = taiwanQuotes.some(
    (quote) =>
      quote?.available === true && quote.price !== null && quote.asOf !== null,
  );
  const sessionState = (quote: MarketStripQuote | undefined) =>
    !quote?.available
      ? "無報價"
      : quote.source?.includes("TAIFEX 官方日行情")
        ? "最近收盤"
        : quoteIsFresh(quote)
          ? "即時"
          : "最後成交";
  return (
    <div className="market-strip" data-reveal>
      <div className="market-strip-main-row">
        <div className="market-strip-label">
          <span className={`live-dot ${hasFreshQuote ? "is-live" : "is-stale"}`} />
          <span>加權指數／臺指期</span>
          <small>日盤{sessionState(dayQuote)} · 夜盤{sessionState(nightQuote)} · 查詢 {formatClock(updatedAt)}{!hasFreshQuote && !hasAnyQuote ? " · 等待新成交" : ""}</small>
        </div>
        {loading ? (
          [0, 1].map((item) => <SkeletonBlock key={item} className="h-[62px] min-w-0 flex-1" />)
        ) : error ? (
          <div className="market-strip-error"><CircleAlert size={15} /> {parseError(error)} <button type="button" onClick={onRetry} data-testid="button-retry-market-strip">重試</button></div>
        ) : quotes.length === 0 ? (
          <div className="market-strip-error">行情來源目前沒有回傳報價。</div>
        ) : (
          <>
            {displayedTaiexQuote ? (
              <MarketQuoteReadout quote={displayedTaiexQuote} />
            ) : (
              <div className="market-strip-error">加權指數資料未回傳。</div>
            )}
            <div className="market-futures-quote" data-testid="status-market-quote-futures">
              <FuturesSessionReadout quote={dayQuote} sessionLabel="日盤" />
              <FuturesSessionReadout quote={nightQuote} sessionLabel="夜盤" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StockQuoteCard({
  symbol,
  quote,
  lastClose,
  lastCloseSource,
  loading,
  fetching,
  error,
  onRetry,
  canToggleWatchlist,
  isSaved,
  watchlistDisabled,
  watchlistSaving,
  isSignedIn,
  onToggleWatchlist,
}: {
  symbol: string;
  quote?: StockQuote;
  lastClose?: Bar;
  lastCloseSource?: string | null;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  canToggleWatchlist: boolean;
  isSaved: boolean;
  watchlistDisabled: boolean;
  watchlistSaving: boolean;
  isSignedIn: boolean;
  onToggleWatchlist: () => void;
}) {
  const quoteDisplayStatus = getStockQuoteDisplayStatus(
    quote,
    isTaiwanStockSessionOpen(),
  );
  const availableQuote =
    quoteDisplayStatus.available && quote ? quote : undefined;
  const isAvailable = availableQuote !== undefined;
  const hasLastClose = !isAvailable && lastClose !== undefined;
  const displayPrice = availableQuote?.price ?? lastClose?.close ?? null;
  const isDelayedLastTrade = quoteDisplayStatus.isDelayedLastTrade;
  const quoteFallbackReason = getStockQuoteFallbackReason(quote?.error);
  const isAfterHoursQuote =
    availableQuote?.source.includes("盤後最後成交") ?? false;
  const isQuoteUpdateOnly =
    availableQuote?.source.includes("報價更新時間") ?? false;
  const rising = (quote?.change ?? 0) >= 0;

  return (
    <section className="stock-quote-card glass-panel" data-reveal aria-live="polite" aria-atomic="true">
      <div className="stock-quote-heading">
        <div>
          <span className="stock-quote-eyebrow">個股報價</span>
          <span className="stock-quote-symbol">
            {symbol.replace(/\.(TW|TWO)$/i, "")}
            {quote?.name ? ` · ${quote.name}` : " · 台股"}
          </span>
        </div>
        <div className="stock-quote-heading-actions" aria-live="off">
          <span className={`stock-quote-state ${isDelayedLastTrade ? "delayed" : isAvailable ? "available" : "unavailable"}`}>
            <span className="stock-quote-state-dot" />
            {loading ? "查詢中" : fetching ? "更新中" : isAvailable ? (isAfterHoursQuote ? "盤後最後成交" : isDelayedLastTrade ? "最後成交（非即時）" : isQuoteUpdateOnly ? "最新報價" : "最新成交") : hasLastClose ? "最近收盤" : "歷史參考"}
          </span>
          {canToggleWatchlist && (
            <button
              type="button"
              className={`watchlist-save ${isSaved ? "is-saved" : ""}`}
              onClick={onToggleWatchlist}
              disabled={watchlistDisabled}
              data-testid="button-toggle-watchlist"
              aria-pressed={isSaved}
            >
              {isSaved ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
              {watchlistSaving ? "正在同步…" : isSaved ? "已存至自選" : isSignedIn ? "加入自選股" : "加入本機自選"}
            </button>
          )}
        </div>
      </div>
      <div className="stock-quote-main">
        <strong>{loading ? "···" : displayPrice !== null ? formatNumber(displayPrice, 2) : "暫無報價"}</strong>
        {availableQuote && availableQuote.change !== null ? (
          <span className={`stock-quote-change ${rising ? "is-rising" : "is-falling"}`}>
            {rising ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}
            {formatNumber(availableQuote.change, 2)} / {formatPercent(availableQuote.changePercent)}
          </span>
        ) : hasLastClose ? (
          <span className="stock-quote-change stock-quote-muted">非即時收盤價</span>
        ) : (
          <span className="stock-quote-change stock-quote-muted">成交變動未提供</span>
        )}
      </div>
      <div className="stock-quote-meta">
        {availableQuote
          ? isDelayedLastTrade
            ? `${availableQuote.source} · 最後成交 ${formatTimeWithSeconds(availableQuote.asOf ?? undefined)} · 非即時`
            : `${availableQuote.source} · 報價時間 ${formatTime(availableQuote.asOf ?? undefined)}`
          : loading
            ? "正在向交易所查詢最新成交資料"
            : hasLastClose
                ? `${lastCloseSource ?? "官方日線"} · 收盤 ${formatDate(lastClose.date)}${quoteFallbackReason ? ` · ${quoteFallbackReason}` : ""}`
              : quote?.error ?? "交易所目前未回傳可用的最新成交價"}
      </div>
      {error !== null && error !== undefined && (
        <button type="button" className="stock-quote-retry" onClick={onRetry}>
          <RefreshCw size={13} /> 重新查詢
        </button>
      )}
    </section>
  );
}

function PriceChart({ bars, symbol, dark, assessment }: {
  bars: Bar[];
  symbol: string;
  dark: boolean;
  assessment?: StockAiAssessment;
}) {
  const ma20 = calculateAverage(bars, 20);
  const ma60 = calculateAverage(bars, 60);
  const hasValidReference = assessment !== undefined &&
    Number.isFinite(assessment.referencePrice) && assessment.referencePrice > 0 &&
    (assessment.referenceType === "verified_trade" || assessment.referenceType === "official_daily_close");
  const validForecast = (hasValidReference ? assessment.forecastPath : [])
    .filter((item) =>
      Number.isInteger(item.day) && item.day >= 1 && item.day <= 5 &&
      Number.isFinite(item.lowPrice) && Number.isFinite(item.centralPrice) && Number.isFinite(item.highPrice) &&
      item.lowPrice > 0 && item.centralPrice > 0 && item.highPrice > 0 &&
      item.lowPrice <= item.centralPrice && item.centralPrice <= item.highPrice,
    )
    .slice()
    .sort((left, right) => left.day - right.day);
  const forecast = validForecast.length === 5 &&
    validForecast.every((item, index) => item.day === index + 1)
    ? validForecast
    : [];
  const scenarioPoints = forecast.map((item) => ({
    day: item.day,
    price: item.centralPrice,
    priceError: [item.centralPrice - item.lowPrice, item.highPrice - item.centralPrice],
    lowPrice: item.lowPrice,
    highPrice: item.highPrice,
  }));
  const scenarioPathPoints = hasValidReference && assessment
    ? [{ day: 0, price: assessment.referencePrice }, ...scenarioPoints]
    : scenarioPoints;
  const referencePoint = hasValidReference && assessment
    ? [{ day: 0, price: assessment.referencePrice }]
    : [];
  const forecastPriceValues = [
    ...(hasValidReference && assessment ? [assessment.referencePrice] : []),
    ...forecast.flatMap((item) => [item.lowPrice, item.centralPrice, item.highPrice]),
  ];
  const forecastMinPrice = forecastPriceValues.length ? Math.min(...forecastPriceValues) : 0;
  const forecastMaxPrice = forecastPriceValues.length ? Math.max(...forecastPriceValues) : 1;
  const forecastSpan = forecastMaxPrice - forecastMinPrice;
  const forecastPadding = forecastSpan > 0 ? forecastSpan * 0.12 : Math.max(forecastMaxPrice * 0.02, 1);
  const forecastPriceDomain: [number, number] = [
    Math.max(0, forecastMinPrice - forecastPadding),
    forecastMaxPrice + forecastPadding,
  ];
  const historyChartData = bars.map((bar, index) => ({
    ...bar,
    displayDate: formatChartDate(bar.date),
    ma20: ma20[index],
    ma60: ma60[index],
  }));
  type PriceChartPoint = {
    date: string;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    displayDate: string;
    ma20: number | null;
    ma60: number | null;
    forecastCentral: number | null;
  };
  const priceChartData: PriceChartPoint[] = historyChartData.map((bar) => ({
    ...bar,
    forecastCentral: null,
  }));
  const actualLastBar = bars.at(-1);
  if (forecast.length && hasValidReference && assessment) {
    if (assessment.referenceType === "verified_trade" && actualLastBar) {
      priceChartData.push({
        ...actualLastBar,
        close: null,
        displayDate: "即時",
        ma20: null,
        ma60: null,
        forecastCentral: assessment.referencePrice,
      });
    } else if (priceChartData.length > 0) {
      priceChartData[priceChartData.length - 1].forecastCentral =
        assessment.referencePrice;
    }
    for (const point of forecast) {
      priceChartData.push({
        date: `forecast-${point.day}`,
        open: null,
        high: null,
        low: null,
        close: null,
        volume: null,
        displayDate: `第 ${point.day} 天`,
        ma20: null,
        ma60: null,
        forecastCentral: point.centralPrice,
      });
    }
  }
  const rows = historyChartData.map((bar) => ({ date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, ma20: bar.ma20, ma60: bar.ma60 }));
  const latestBar = bars[bars.length - 1];
  const previousBar = bars[bars.length - 2];
  const dailyChange = latestBar && previousBar ? latestBar.close - previousBar.close : null;
  const dailyChangePercent =
    dailyChange !== null && previousBar && previousBar.close > 0
      ? (dailyChange / previousBar.close) * 100
      : null;
  const dailyDirection =
    dailyChange === null
      ? "unavailable"
      : dailyChange > 0
        ? "up"
        : dailyChange < 0
          ? "down"
          : "flat";
  const dailyDirectionLabel =
    dailyDirection === "up"
      ? "上漲"
      : dailyDirection === "down"
        ? "下跌"
        : dailyDirection === "flat"
          ? "平盤"
          : "資料不足";
  const aiDirectionLabels: Record<StockAiAssessment["biasLevel"], string> = {
    strong_bearish: "強下跌訊號",
    bearish: "下跌訊號",
    neutral: "無明確漲跌訊號",
    bullish: "上漲訊號",
    strong_bullish: "強上漲訊號",
    insufficient: "資料不足",
  };
  const aiDirection = assessment
    ? assessment.biasLevel === "strong_bullish" || assessment.biasLevel === "bullish"
      ? "up"
      : assessment.biasLevel === "strong_bearish" || assessment.biasLevel === "bearish"
        ? "down"
        : assessment.biasLevel === "neutral"
          ? "flat"
          : "unavailable"
    : "unavailable";
  const finalForecast = forecast.length === 5 ? forecast[4] : undefined;
  const forecastChange =
    assessment && hasValidReference && finalForecast
      ? finalForecast.centralPrice - assessment.referencePrice
      : null;
  const forecastChangePercent =
    forecastChange !== null && assessment && assessment.referencePrice > 0
      ? (forecastChange / assessment.referencePrice) * 100
      : null;
  const forecastDirection =
    forecastChange === null
      ? "unavailable"
      : forecastChange > 0
        ? "up"
        : forecastChange < 0
          ? "down"
          : "flat";
  const forecastDirectionLabel =
    forecastDirection === "up"
      ? "估計上漲"
      : forecastDirection === "down"
        ? "估計下跌"
        : forecastDirection === "flat"
          ? "估計持平"
          : "估計資料不足";
  const scenarioForecastColor =
    forecastDirection === "up"
      ? CHART_COLORS.rising
      : forecastDirection === "down"
        ? CHART_COLORS.falling
        : CHART_COLORS.signal;
  const formatSignedNumber = (value: number, digits = 2) =>
    `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatNumber(Math.abs(value), digits)}`;
  return (
    <Panel
      title="股價走勢"
      eyebrow={`${symbol} · 每日收盤與未來 5 日估計`}
      action={<CsvButton filename={`${symbol.toLowerCase()}-price-structure.csv`} rows={rows} />}
    >
      <div className="chart-legend">
        <span><i className="legend-line price-line" style={{ backgroundColor: dark ? "#d5dce3" : CHART_COLORS.ink }} /> 每日收盤價</span>
        <span><i className="legend-line signal-line" /> 20 日平均價</span>
        <span><i className="legend-line falling-line" /> 60 日平均價</span>
        {forecast.length > 0 && (
          <span>
            <i
              className="legend-line forecast-estimate-line"
              style={{ borderTopColor: scenarioForecastColor }}
            />{" "}
            AI 未來中間估計（情境）
          </span>
        )}
        {assessment?.action === "buy" &&
          assessment.pricePlanStatus === "available" &&
          assessment.entryPrice !== null &&
          assessment.stopLossPrice !== null &&
          assessment.takeProfitPrice !== null && (
            <>
              <span>
                <i className="legend-line entry-reference-line" /> AI 主觀勝率較佳買價
              </span>
              <span>
                <i
                  className="legend-line stop-reference-line"
                  style={{ borderTopColor: CHART_COLORS.falling }}
                />{" "}
                停損離場參考
              </span>
              <span>
                <i
                  className="legend-line target-reference-line"
                  style={{ borderTopColor: CHART_COLORS.rising }}
                />{" "}
                目標賣出參考
              </span>
            </>
          )}
        <span className="legend-note">交易所每日資料</span>
      </div>
      <div className="chart-direction-signals" data-testid="chart-direction-signals" aria-label="實際日線與未來估計方向">
        <div className={`chart-direction-card ${dailyDirection}`} data-testid="signal-actual-daily-change">
          <span>實際日線漲跌 · {latestBar ? formatChartDate(latestBar.date) : "日期不足"}</span>
          <strong>{dailyDirectionLabel}</strong>
          <small>
            {latestBar && previousBar && dailyChange !== null && dailyChangePercent !== null
              ? `收盤 ${formatNumber(latestBar.close, 2)} 元；較前一交易日 ${formatSignedNumber(dailyChange)} 元（${formatSignedNumber(dailyChangePercent, 3)}%）`
              : latestBar
                ? `最近收盤 ${formatNumber(latestBar.close, 2)} 元；缺少前一交易日收盤，無法計算漲跌。`
                : "沒有可用日線資料。"}
          </small>
        </div>
        <div className={`chart-direction-card ${aiDirection}`} data-testid="signal-ai-direction">
          <span>AI 預估方向 · 未來 1–5 個交易日</span>
          <strong>{assessment ? aiDirectionLabels[assessment.biasLevel] : "尚未產生判讀"}</strong>
          <small>
            {assessment
              ? `${assessment.summary}（判讀時間 ${formatTime(assessment.analyzedAt)}）`
              : "完成個股分析後顯示方向與依據。"}
          </small>
        </div>
        <div className={`chart-direction-card ${forecastDirection}`} data-testid="signal-five-day-estimate">
          <span>五日中間估計 · 相對參考價</span>
          <strong>{forecastDirectionLabel}</strong>
          <small>
            {assessment && finalForecast && forecastChange !== null && forecastChangePercent !== null
              ? `參考價 ${formatNumber(assessment.referencePrice, 2)} 元 → 第 5 日 ${formatNumber(finalForecast.centralPrice, 2)} 元；差 ${formatSignedNumber(forecastChange)} 元（${formatSignedNumber(forecastChangePercent, 3)}%）。估計情境，非保證。`
              : assessment?.forecastReason || "缺少有效參考價或完整五日估計，暫不標示方向。"}
          </small>
        </div>
      </div>
      <div className="chart-direction-note" data-testid="note-order-flow-limitation">
        <span>
          漲跌原理：有大量買進或成交量放大，不代表股價必漲；較直接的追價線索是買方持續以賣方掛價成交。本分析目前沒有五檔委託與逐筆成交方向資料，不會把它當成已觀察到的訊號。
        </span>
        <a
          href="https://edh.tw/articles/yFUcUaO"
          target="_blank"
          rel="noreferrer"
        >
          參考文章
        </a>
      </div>
      <div className="chart-wrap" data-testid="chart-stock-price">
        <ResponsiveContainer width="100%" height={310} debounce={0}>
          <LineChart data={priceChartData} margin={{ top: 24, right: 18, left: -16, bottom: 8 }}>
            <CartesianGrid stroke={dark ? "rgba(220,230,238,.1)" : CHART_COLORS.grid} strokeDasharray="2 4" />
            <XAxis dataKey="displayDate" tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={34} />
            <YAxis domain={["auto", "auto"]} tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 11 }} axisLine={false} tickLine={false} width={52} tickFormatter={(value) => formatNumber(value, 2)} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={{ background: dark ? "#202932" : "#fbfcfd", border: `1px solid ${dark ? "#3b4853" : "#d7dbe0"}`, borderRadius: 4, color: dark ? "#eef2f5" : "#233044", fontFamily: "Space Mono", fontSize: 11 }}
              labelFormatter={(label) => `日期 · ${label}`}
            />
            <Line type="monotone" dataKey="close" name="每日收盤價" stroke={dark ? "#d5dce3" : CHART_COLORS.ink} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="ma20" name="20 日平均價" stroke={CHART_COLORS.signal} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="ma60" name="60 日平均價" stroke={CHART_COLORS.falling} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {forecast.length > 0 && (
              <Line
                type="monotone"
                dataKey="forecastCentral"
                name="AI 未來中間估計"
                stroke={scenarioForecastColor}
                strokeWidth={2.5}
                strokeDasharray="6 4"
                dot={{ r: 3, fill: scenarioForecastColor, strokeWidth: 1 }}
                activeDot={{ r: 5 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
            <ReferenceLine y={hasValidReference && assessment ? assessment.referencePrice : bars[bars.length - 1]?.close} stroke={dark ? "#d5dce3" : CHART_COLORS.ink} strokeDasharray="3 3" strokeOpacity={0.45} />
            {assessment?.action === "buy" &&
              assessment.pricePlanStatus === "available" &&
              assessment.entryPrice !== null &&
              assessment.stopLossPrice !== null &&
              assessment.takeProfitPrice !== null && (
                <>
                <ReferenceLine
                  y={assessment.entryPrice}
                  stroke={CHART_COLORS.signal}
                  strokeDasharray="2 4"
                  label="AI 主觀勝率較佳買價"
                />
                <ReferenceLine
                  y={assessment.stopLossPrice}
                  stroke={CHART_COLORS.falling}
                  strokeDasharray="2 4"
                  label="停損離場參考"
                />
                <ReferenceLine
                  y={assessment.takeProfitPrice}
                  stroke={CHART_COLORS.rising}
                  strokeDasharray="2 4"
                  label="目標賣出參考"
                />
                </>
              )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="forecast-inline-summary" data-testid="text-ai-forecast-explanation">
        <strong>
          {forecast.length === 5
            ? `未來五日估計：${forecastDirectionLabel}`
            : "AI 未來走勢說明"}
        </strong>
        <p>
          {assessment?.forecastReason ||
            assessment?.summary ||
            "完成個股分析後會顯示未來走勢與估計依據。"}
        </p>
        {assessment?.action === "buy" &&
          assessment.pricePlanStatus === "available" &&
          assessment.entryPrice !== null &&
          assessment.stopLossPrice !== null &&
          assessment.takeProfitPrice !== null && (
            <p>
              {assessment.referenceType === "official_daily_close"
                ? "AI 主觀勝率較佳買價（次一交易日條件參考）"
                : "AI 主觀勝率較佳買價"}
              ：進場 {formatNumber(assessment.entryPrice, 2)} 元、停損{" "}
              {formatNumber(assessment.stopLossPrice, 2)} 元、目標賣出{" "}
              {formatNumber(assessment.takeProfitPrice, 2)} 元。
              {assessment.referenceType === "official_daily_close" &&
                " 開盤後先核對即時成交價；這不是盤後可成交價。"}
            </p>
          )}
      </div>
      <section className="forecast-path" data-testid="panel-ai-price-forecast">
        <div className="forecast-path-heading">
          <div><strong>未來 5 個交易日可能走勢</strong><small>每天一個估計，不代表一定會照這樣走。</small></div>
          <AiProviderBadge
            provider={assessment?.aiProvider}
            compact
            context="stock_assessment"
          />
        </div>
        {assessment ? <>
          {hasValidReference ? (
            <p className="forecast-reference">目前參考價：<strong>{formatNumber(assessment.referencePrice, 2)}</strong> 元 · {assessment.referenceType === "verified_trade" ? "最新成交" : "最近收盤"}</p>
          ) : (
            <p className="forecast-empty" data-testid="status-forecast-invalid-reference">目前缺少有效的參考價格，暫不顯示五日估計。</p>
          )}
          {hasValidReference && (forecast.length ? <>
            <div className="scenario-plot-legend" aria-label="價格估計圖圖例">
              <span><i className="scenario-dot reference" /> 目前價格</span>
              <span><i className="scenario-range" style={{ color: scenarioForecastColor }} /> 每日估計範圍</span>
              <span><i className="scenario-path-line" style={{ borderTopColor: scenarioForecastColor }} /> 中間估計方向</span>
            </div>
            <div className="scenario-plot" data-testid="chart-ai-scenario-path" role="img" aria-label={`未來五個交易日價格估計圖，中間估計${forecastDirectionLabel}，虛線連接每日估計，直線顯示估計範圍`}>
              <ResponsiveContainer width="100%" height={240} debounce={0}>
                <ScatterChart margin={{ top: 14, right: 18, bottom: 10, left: 0 }}>
                  <CartesianGrid stroke={dark ? "rgba(220,230,238,.1)" : CHART_COLORS.grid} strokeDasharray="2 4" />
                  <XAxis
                    type="number"
                    dataKey="day"
                    domain={[0, 5]}
                    ticks={[0, 1, 2, 3, 4, 5]}
                    tickFormatter={(day) => day === 0 ? "現在" : `第 ${day} 天`}
                    tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis type="number" dataKey="price" domain={forecastPriceDomain} tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 10 }} axisLine={false} tickLine={false} width={62} tickFormatter={(value) => formatNumber(value, 2)} />
                  <Tooltip
                    isAnimationActive={false}
                    contentStyle={{ background: dark ? "#202932" : "#fbfcfd", border: `1px solid ${dark ? "#3b4853" : "#d7dbe0"}`, borderRadius: 4, color: dark ? "#eef2f5" : "#233044", fontFamily: "Space Mono", fontSize: 11 }}
                    formatter={(value, name) => [formatNumber(Number(value), 2), String(name)]}
                    labelFormatter={(day) => Number(day) === 0 ? "目前價格" : `第 ${day} 個交易日`}
                  />
                  <Scatter
                    data={scenarioPathPoints}
                    dataKey="price"
                    name="中間估計"
                    fill={scenarioForecastColor}
                    line={{ stroke: scenarioForecastColor, strokeWidth: 2, strokeDasharray: "5 5" }}
                    lineType="joint"
                    isAnimationActive={false}
                  >
                    <ErrorBar dataKey="priceError" direction="y" width={7} stroke={scenarioForecastColor} strokeOpacity={0.55} strokeWidth={2} />
                  </Scatter>
                  <Scatter data={referencePoint} dataKey="price" name="目前價格" fill={CHART_COLORS.ink} isAnimationActive={false} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <p className="forecast-chart-note">直條表示當天估計的高低範圍；虛線只連接每日估計，不代表盤中走勢。</p>
            <div className="forecast-path-table" role="table" aria-label="未來五個交易日價格估計">
              <div className="forecast-path-row header" role="row"><span>交易日</span><span>偏低估計</span><span>中間估計</span><span>偏高估計</span></div>
              {forecast.map((item) => <div className="forecast-path-row" role="row" key={item.day} data-testid={`row-forecast-day-${item.day}`}>
                <strong>第 {item.day} 天</strong><span>{formatNumber(item.lowPrice, 2)}</span><span className="forecast-central-value">{formatNumber(item.centralPrice, 2)}</span><span>{formatNumber(item.highPrice, 2)}</span>
              </div>)}
            </div>
          </> : <p className="forecast-empty" data-testid="status-forecast-unavailable">{assessment.forecastReason || "目前資料不足，無法提供完整 5 日估計。"}</p>)}
          <small>分析時間 {formatTime(assessment.analyzedAt)} · 僅供參考，實際價格可能不同。</small>
        </> : <p className="forecast-empty" data-testid="status-forecast-loading">正在整理個股分析資料。</p>}
      </section>
    </Panel>
  );
}

function VolumeChart({ bars, symbol, dark }: { bars: Bar[]; symbol: string; dark: boolean }) {
  const chartData = bars.map((bar) => ({ ...bar, displayDate: formatChartDate(bar.date), lots: bar.volume === null ? null : bar.volume / 1000 }));
  const rows = chartData.map((bar) => ({ date: bar.date, volumeLots: bar.lots }));
  return (
    <Panel title="成交量" eyebrow="每天交易股數｜張" action={<CsvButton filename={`${symbol.toLowerCase()}-volume.csv`} rows={rows} />}>
      <div className="chart-legend">
        <span><i className="legend-dot signal-dot" /> 成交股數 ÷ 1,000</span>
        <span className="legend-note">TWSE / TPEx 回報資料</span>
      </div>
      <div className="chart-wrap chart-wrap-short" data-testid="chart-stock-volume">
        <ResponsiveContainer width="100%" height={190} debounce={0}>
          <AreaChart data={chartData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
            <defs><linearGradient id="volumeFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={CHART_COLORS.falling} stopOpacity={0.35} /><stop offset="100%" stopColor={CHART_COLORS.falling} stopOpacity={0.03} /></linearGradient></defs>
            <CartesianGrid stroke={dark ? "rgba(220,230,238,.1)" : CHART_COLORS.grid} strokeDasharray="2 4" />
            <XAxis dataKey="displayDate" tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={34} />
            <YAxis tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 11 }} axisLine={false} tickLine={false} width={48} tickFormatter={(value) => formatCompact(value)} />
            <Tooltip isAnimationActive={false} contentStyle={{ background: dark ? "#202932" : "#fbfcfd", border: `1px solid ${dark ? "#3b4853" : "#d7dbe0"}`, borderRadius: 4, color: dark ? "#eef2f5" : "#233044", fontFamily: "Space Mono", fontSize: 11 }} />
            <Area type="monotone" dataKey="lots" name="成交量（張）" stroke={CHART_COLORS.falling} fill="url(#volumeFill)" strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function SummaryPanel({
  summary,
  dailySummary,
  loading,
  error,
  onRetry,
}: {
  summary: MarketSummaryResponse | undefined;
  dailySummary: MarketAiDailySummary | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const statusLabel = summary?.status === "insufficient"
    ? "資料不足"
    : summary?.status === "bullish"
      ? "上漲訊號"
      : summary?.status === "bearish"
        ? "下跌訊號"
        : summary?.status === "neutral"
          ? "無明確漲跌訊號"
          : "無資料";
  const checklistLabel = summary?.checklist.conclusion === "bullish"
    ? "偏多"
    : summary?.checklist.conclusion === "bearish"
      ? "偏空"
      : summary?.checklist.conclusion === "insufficient" ? "資料不足" : "震盪";
  const signalLabel = (signal: string) => signal === "bullish"
    ? "偏多"
    : signal === "bearish" ? "偏空" : signal === "unavailable" ? "資料不足" : "震盪";
  return (
    <Panel title="大盤概況" eyebrow="依市場條件整理" className="summary-panel">
      {loading && !summary ? (
        <div className="summary-loading"><SkeletonBlock className="h-20 w-20 rounded-full" /><div className="flex-1 space-y-3"><SkeletonBlock className="h-4 w-1/3" /><SkeletonBlock className="h-8 w-2/3" /><SkeletonBlock className="h-3 w-full" /></div></div>
      ) : error && !summary ? (
        <ProviderError
          title="大盤分析暫時無法使用"
          message={parseError(error)}
          onRetry={onRetry}
        />
      ) : !summary ? (
        <EmptyState title="目前沒有大盤分析" detail="目前沒有足夠的大盤資料，請稍後再試。" />
      ) : (
        <>
          <div className="summary-top">
              <div className={`score-ring ${summary.status}`}><span>{summary.score ?? "—"}</span><small>項符合</small></div>
            <div className="summary-copy">
              <div className="status-row"><span className={`status-pill ${summary.status}`}><span className="status-pip" />{statusLabel}</span><span className="mono subtle">台灣加權指數 · {summary.ticker}</span></div>
              <p className="summary-headline">這是依股價條件整理的分數，不代表上漲機率或未來結果。</p>
              <div className="summary-metrics">
                <div><span>最新</span><strong>{formatNumber(summary.currentPrice, 2)}</strong></div>
                <div><span>當日漲跌</span><strong className={summary.changePercent >= 0 ? "rising" : "falling"}>{formatPercent(summary.changePercent)}</strong></div>
                <div><span>20 日平均價</span><strong>{formatNumber(summary.ma20, 2)}</strong></div>
                <div><span>60 日平均價</span><strong>{formatNumber(summary.ma60, 2)}</strong></div>
              </div>
            </div>
          </div>
          <section className="market-checklist" data-testid="market-direction-checklist">
            <div className="market-checklist-heading">
              <div><h3>盤中多空檢查表</h3><small>每 15 秒更新 · 日線資料日 {formatDate(summary.checklist.marketDate)} · 更新於 {formatTime(summary.checklist.analyzedAt)}</small></div>
              <span className={`status-pill ${summary.checklist.conclusion}`}>{checklistLabel}</span>
            </div>
            <p className="market-checklist-conclusion">{summary.checklist.conclusionText}</p>
            <div className="market-checklist-items">
              {summary.checklist.items.map((item) => (
                <div className="market-checklist-row" key={item.key} data-testid={`row-market-check-${item.key}`}>
                  {(() => {
                    const isEvents = item.key === "events";
                    const signal = item.signal;
                    const sources = isEvents ? item.sources ?? [] : [];
                    return <>
                  <span className={`factor-icon ${signal === "bullish" ? "pass" : signal === "bearish" ? "fail" : "unknown"}`}>
                    {signal === "bullish" ? <Check size={13} /> : signal === "bearish" ? "×" : "—"}
                  </span>
                  <div className="market-checklist-detail">
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                    {sources.length > 0 && <div className="market-checklist-event-sources">
                      {sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>)}
                    </div>}
                    <small>{item.source ?? (isEvents ? "搜尋來源未提供" : "來源資料不足")}{item.observedAt ? ` · ${formatTime(item.observedAt)}` : ""}</small>
                  </div>
                  <b className={`market-checklist-signal ${signal}`}>{isEvents ? sources.length ? "已找到" : item.source?.includes("暫不可用") ? "搜尋失敗" : "未找到" : signalLabel(signal)}</b>
                    </>;
                  })()}
                </div>
              ))}
            </div>
            <div className="market-scenarios">
              {summary.checklist.scenarios.map((scenario) => (
                <article key={scenario.label} className={`market-scenario scenario-${scenario.label}`}>
                  <strong>{scenario.label}</strong>
                  <p>{scenario.condition}</p>
                  <small>{scenario.implication}</small>
                </article>
              ))}
            </div>
          </section>
          <details className="market-factor-details">
            <summary>查看指數技術條件</summary>
            <div className="factor-list">
              {summary.factors.length === 0 ? <EmptyState title="沒有可查看的條件" detail="目前沒有足夠的大盤資料可以比較。" /> : summary.factors.map((factor) => (
                <div className="factor-row" key={factor.key} data-testid={`row-market-factor-${factor.key}`}>
                  <span className={`factor-icon ${factor.passed === true ? "pass" : factor.passed === false ? "fail" : "unknown"}`}>{factor.passed === true ? <Check size={13} /> : factor.passed === false ? "×" : "—"}</span>
                  <span className="factor-label">{factor.label}</span>
                  <span className="factor-value">{factor.passed === true ? "符合" : factor.passed === false ? "未符合" : "資料不足"}</span>
                </div>
              ))}
            </div>
          </details>
          <div className="source-line"><Info size={13} /> 資料來源：{summary.source} · 更新時間 {formatTime(summary.asOf)} · 這些條件僅供參考，不能保證未來漲跌。</div>
        </>
      )}
    </Panel>
  );
}

function MarketPremarketSummaryCard({
  summary,
  loading,
  error,
  onRetry,
  mode,
}: {
  summary: MarketAiDailySummary | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  mode: MarketDailySummaryMode;
}) {
  const marketDateLabel = summary?.marketDate.slice(0, 10);
  const newsSources = summary?.newsSources ?? [];
  const isClosing = mode === "closing";
  const summaryLines = summary?.summary
    ?.split(/\n+/u)
    .map((line) => line.replace(/^📈\s*/u, "").replace(/^📊\s*/u, "").trim())
    .filter(Boolean) ?? [];
  return (
    <section className={`market-ai-daily-summary premarket-summary-card${isClosing ? " closing-summary-card" : ""}`} data-testid={isClosing ? "panel-market-ai-closing-summary" : "panel-market-ai-daily-summary"} aria-live="polite">
      <div className="market-ai-daily-summary-heading">
        <strong><Sparkles size={15} aria-hidden="true" /> AI 今日{isClosing ? "盤後總結" : "盤前摘要"}</strong>
        <div>
          {marketDateLabel && <span className="market-ai-daily-date">技術面截至 {marketDateLabel}</span>}
          <AiProviderBadge
            provider={summary?.aiProvider}
            compact
            state={
              loading && !summary
                ? "loading"
                : summary?.status === "unavailable" || Boolean(error)
                  ? "unavailable"
                  : "idle"
            }
          />
        </div>
      </div>
      {loading && !summary ? (
        <div className="market-ai-daily-loading">
          <SkeletonBlock className="h-3 w-full" />
          <SkeletonBlock className="h-3 w-4/5" />
        </div>
      ) : error && !summary ? (
        <div className="market-ai-daily-unavailable">
          <p>{parseError(error)}</p>
          <button type="button" onClick={onRetry} data-testid="button-retry-market-ai-summary">重試</button>
        </div>
      ) : summary?.status === "available" && summary.summary ? (
        <div className="market-ai-daily-text">
          {summaryLines.map((line, index) => {
            const labelEnd = line.search(/[：｜]/u);
            return (
              <p
                className={`market-ai-daily-line${index === 0 ? " is-lead" : ""}`}
                key={`${index}-${line.slice(0, 24)}`}
              >
                {labelEnd >= 0 ? (
                  <>
                    <strong>{line.slice(0, labelEnd + 1)}</strong>
                    {line.slice(labelEnd + 1)}
                  </>
                ) : line}
              </p>
            );
          })}
        </div>
      ) : (
        <div className="market-ai-daily-unavailable">
          <p>{summary?.error ?? `AI 盤${isClosing ? "後總結" : "前摘要"}目前無法使用，稍後可以重試。`}</p>
          <button type="button" onClick={onRetry} data-testid={isClosing ? "button-retry-market-ai-closing-summary" : "button-retry-market-ai-summary"}>重試</button>
        </div>
      )}
      {summary?.newsSearchStatus === "searched" && newsSources.length > 0 ? (
        <div className="premarket-news-sources">
          <span>台股／國際消息線索（搜尋摘要未核實）</span>
          {newsSources.slice(0, 5).map((source) => (
            <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
          ))}
        </div>
      ) : (
        <div className="premarket-news-status">
          {summary?.newsSearchStatus === "unavailable"
            ? "消息搜尋暫時無法使用，摘要不會補猜新聞內容。"
            : summary?.newsSearchStatus === "no_results"
              ? "目前沒有找到近期消息摘要。"
              : "正在搜尋近期市場消息…"}
        </div>
      )}
      <small>
        {summary
          ? `行情來源：${summary.source} · 最新行情時間 ${summary.quoteAsOf ? formatTime(summary.quoteAsOf) : "無"} · 技術資料日 ${marketDateLabel ?? "無"}${summary.analyzedAt ? ` · 分析時間 ${formatTime(summary.analyzedAt)}` : ""}。盤外數值代表最近可取得行情。`
          : "整合最新可取得行情、官方日線技術面與近期消息搜尋；盤外數值不代表即時成交。"}
      </small>
    </section>
  );
}

type AiProviderId =
  | "openai"
  | "1min_ai"
  | "agnes_ai"
  | "groq"
  | "ollama"
  | "openrouter"
  | "gemini"
  | "nvidia_nim"
  | "rule_based"
  | null
  | undefined;
const AI_ACTION_TIMEOUT_MS = 75_000;

function AiProviderBadge({
  provider,
  compact = false,
  state = "idle",
  context = "default",
}: {
  provider: AiProviderId;
  compact?: boolean;
  state?: "idle" | "loading" | "unavailable";
  context?: "default" | "stock_assessment";
}) {
  const labels = {
    openai: "OpenAI",
    "1min_ai": "1min.ai",
    agnes_ai: "Agnes AI",
    groq: "Groq Free",
    ollama: "Ollama",
    openrouter: "OpenRouter",
    gemini: "Gemini Flash-Lite",
    nvidia_nim: "NVIDIA NIM",
    rule_based: "固定規則",
  } as const;

  return (
    <span
      className={`ai-provider-badge${compact ? " is-compact" : ""}`}
      title={
        provider === "rule_based"
          ? context === "stock_assessment"
            ? "AI 未完成；此備援只整理可驗證行情，不提供方向預測或個股價位"
            : "由伺服器使用固定的台股單位規則回答，未呼叫 AI"
          : provider
          ? "此 AI 結果實際使用的服務"
          : state === "loading"
            ? "AI 分析正在處理"
            : state === "unavailable"
              ? "目前沒有 AI 服務成功完成分析"
              : "尚未執行 AI 分析"
      }
    >
      {provider === "rule_based"
        ? context === "stock_assessment"
          ? "規則備援"
          : "規則換算"
        : provider
        ? `AI：${labels[provider]}`
        : state === "loading"
          ? "AI：分析中"
          : state === "unavailable"
            ? "AI：未完成"
            : "AI：尚未呼叫"}
    </span>
  );
}

function SemicircleSentimentGauge({
  level,
  label,
}: {
  level: StockAiAssessment["biasLevel"];
  label: string;
}) {
  const needleAngles: Record<StockAiAssessment["biasLevel"], number> = {
    strong_bearish: -90,
    bearish: -45,
    neutral: 0,
    bullish: 45,
    strong_bullish: 90,
    insufficient: 0,
  };
  const angle = needleAngles[level];
  return (
    <div
      className={`sentiment-gauge ${level}`}
      role="img"
      aria-label={`AI 方向參考：${label}`}
      data-testid="gauge-ai-sentiment"
    >
      <svg viewBox="0 0 240 154" aria-hidden="true">
        <defs>
          <linearGradient id="sentimentGaugeGradient" x1="18" y1="124" x2="222" y2="124" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="hsl(var(--secondary-foreground))" />
            <stop offset="50%" stopColor="hsl(39 76% 48%)" />
            <stop offset="100%" stopColor="hsl(var(--primary))" />
          </linearGradient>
        </defs>
        <path className="sentiment-gauge-track" d="M 18 124 A 102 102 0 0 1 222 124" />
        <path className="sentiment-gauge-arc" d="M 18 124 A 102 102 0 0 1 222 124" />
        <g className="sentiment-gauge-needle" transform={`rotate(${angle} 120 124)`}>
          <line x1="120" y1="124" x2="120" y2="43" />
        </g>
        <circle className="sentiment-gauge-pivot" cx="120" cy="124" r="7" />
        <text className="sentiment-gauge-label" x="17" y="151" textAnchor="start">較弱</text>
        <text className="sentiment-gauge-label" x="120" y="151" textAnchor="middle">中性</text>
        <text className="sentiment-gauge-label" x="223" y="151" textAnchor="end">較強</text>
      </svg>
    </div>
  );
}

const MAX_SAVED_ASSISTANT_MESSAGES = 50;

type AssistantChatMessage = StockAiConversationMessage & { isError?: boolean };

function renderAssistantAnswer(content: string) {
  const sections = splitAssistantAnswer(content);
  if (sections.length === 1 && sections[0]?.label === null) return <p>{content}</p>;
  return (
    <div className="stock-ai-chat-answer-sections">
      {sections.map((section, index) => {
        const isConclusion =
          index === 0 && ["方向結論", "方向判斷"].includes(section.label ?? "");
        return (
          <section
            className={`stock-ai-chat-answer-section${isConclusion ? " is-conclusion" : ""}`}
            key={`${section.label ?? "answer"}-${index}`}
            aria-label={section.label ?? undefined}
          >
            {section.label && <strong>{section.label}</strong>}
            <p>{section.body}</p>
          </section>
        );
      })}
    </div>
  );
}

function shouldUseStockAiAssistant(
  question: string,
  symbol: string,
  messages: AssistantChatMessage[],
): boolean {
  const normalizedQuestion = question.trim().toUpperCase();
  const normalizedSymbol = normalizeTaiwanStockSymbol(symbol);
  const mentionsSelectedSymbol =
    normalizedSymbol.length > 0 && normalizedQuestion.includes(normalizedSymbol);
  const isEtfDistributionQuestion =
    /(配息|除息|發放|收益分配|現金股利|股利)/u.test(question);
  if (isEtfDistributionQuestion) return false;

  const isEducationalQuestion =
    /(什麼是|何謂|意思|基本概念|怎麼運作|如何運作|怎麼買(?:入)?股票|如何買(?:入)?股票|怎麼挑選|如何挑選)/u.test(
      question,
    );
  if (isEducationalQuestion && !mentionsSelectedSymbol) return false;

  const isActionQuestion =
    /(要不要(買|賣)|該不該(買|賣)|是否.{0,6}(買|賣)|可不可以.{0,4}(買|賣|加碼|減碼)|能不能.{0,4}(買|賣|加碼|減碼)|可以.{0,3}買|現在.{0,4}買|適合.{0,3}(買|賣)|值得.{0,3}買|買進|買入|加碼|減碼|賣出|出場|續抱|持有|持倉|停損|停利|獲利了結|操作建議|怎麼操作|如何操作|怎麼做)/u.test(
      question,
    );
  const namesStockContext =
    /(這檔|這支|這家公司|該股|選定標的|目前選定|個股|股票|ETF|股價|現價|成交價|收盤價|行情|走勢|趨勢)/u.test(
      question,
    );
  const asksForStockAnalysis =
    /(分析|判斷|方向|風險|值得|未來|明天|價格|多少|如何|怎麼|原因|產品|營收|獲利)/u.test(
      question,
    );
  const hasStockConversationContext = messages.some(
    (message) => message.role === "assistant" && message.context,
  );
  const isStockFollowUp =
    hasStockConversationContext &&
    /(那|所以|如果|這樣|它|此時|剛才|前面|上述)/u.test(question) &&
    /(風險|價格|價位|方向|走勢|趨勢|買|賣|持有|加碼|減碼|停損|停利|目標|如何|怎麼|呢)/u.test(
      question,
    );

  return (
    mentionsSelectedSymbol ||
    isActionQuestion ||
    (namesStockContext && asksForStockAnalysis) ||
    isStockFollowUp
  );
}

type FloatingAssistantReply =
  | Awaited<ReturnType<typeof askAssistantChat>>
  | Awaited<ReturnType<typeof askStockAiAssistant>>;

function getPersistableAssistantMessages(
  messages: AssistantChatMessage[],
): StockAiConversationMessage[] {
  const persisted: StockAiConversationMessage[] = [];
  for (const message of messages) {
    if (message.isError) {
      if (persisted[persisted.length - 1]?.role === "user") persisted.pop();
      continue;
    }
    const persistedMessage = { ...message };
    delete persistedMessage.isError;
    persisted.push(persistedMessage);
  }
  return persisted.slice(-MAX_SAVED_ASSISTANT_MESSAGES);
}

function FloatingStockAiAssistant() {
  const [location] = useLocation();
  const { isLoaded, isSignedIn: authIsSignedIn, userId } = useAuth();
  const queryClient = useQueryClient();
  const isSignedIn = isLoaded && authIsSignedIn === true && Boolean(userId);
  const currentUserId = userId ?? null;
  const isAvailable =
    location === "/" ||
    location === "/watchlist" ||
    location === "/portfolio";
  const conversationSymbol = "MARKET";
  const [isOpen, setIsOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const activeUserId = useRef(currentUserId);
  const previousUserId = useRef<string | null>(null);
  const hydratedConversationKey = useRef("");
  activeUserId.current = currentUserId;
  const conversationQueryKey = useMemo(
    () => ["account-ceo-ai-conversation", currentUserId ?? "signed-out", conversationSymbol] as const,
    [conversationSymbol, currentUserId],
  );
  const conversationQuery = useGetAccountStockAiConversation(
    { symbol: conversationSymbol },
    {
      query: {
        queryKey: conversationQueryKey,
        enabled: isSignedIn && isAvailable,
        retry: false,
        staleTime: 0,
        refetchOnMount: "always",
        refetchOnWindowFocus: false,
      },
      request: { credentials: "include" },
    },
  );
  const saveConversationMutation = usePutAccountStockAiConversation({
    request: { credentials: "include" },
  });
  const deleteConversationMutation = useDeleteAccountStockAiConversation({
    request: { credentials: "include" },
  });
  const mutation = useMutation<
    FloatingAssistantReply,
    Error,
    Parameters<typeof askAssistantChat>[0]
  >({
    mutationFn: (data: Parameters<typeof askAssistantChat>[0]) =>
      askAssistantChat(data, { signal: AbortSignal.timeout(AI_ACTION_TIMEOUT_MS) }),
  });
  const latestAiProvider = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.aiProvider)
    ?.aiProvider;

  useLayoutEffect(() => {
    const previous = previousUserId.current;
    if (previous !== currentUserId) {
      setMessages([]);
      setQuestion("");
      mutation.reset();
      saveConversationMutation.reset();
      deleteConversationMutation.reset();
      hydratedConversationKey.current = "";
      if (previous) {
        queryClient.removeQueries({
          queryKey: ["account-ceo-ai-conversation", previous],
        });
      }
    }
    previousUserId.current = currentUserId;
  }, [
    currentUserId,
    deleteConversationMutation.reset,
    mutation.reset,
    queryClient,
    saveConversationMutation.reset,
  ]);

  const conversationIdentityKey = `${currentUserId ?? "signed-out"}:${conversationSymbol}`;
  useEffect(() => {
    if (
      !isSignedIn ||
      conversationQuery.isFetching ||
      hydratedConversationKey.current === conversationIdentityKey
    ) {
      return;
    }

    if (conversationQuery.isSuccess || conversationQuery.isError) {
      if (conversationQuery.data?.symbol === conversationSymbol) {
        setMessages(conversationQuery.data.messages);
      }
      hydratedConversationKey.current = conversationIdentityKey;
    }
  }, [
    conversationSymbol,
    conversationIdentityKey,
    conversationQuery.data,
    conversationQuery.isError,
    conversationQuery.isFetching,
    conversationQuery.isSuccess,
    isSignedIn,
  ]);

  useEffect(() => {
    if (!isAvailable) setIsOpen(false);
  }, [isAvailable]);

  useEffect(() => {
    if (isOpen) textareaRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      launcherRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen]);

  useLayoutEffect(() => {
    if (isOpen) messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [isOpen, messages, mutation.isPending]);

  const conversationSyncStatus = !isLoaded
    ? "正在確認登入狀態…"
    : !isSignedIn
      ? "登入帳號後可跨裝置同步 CEO 對話。"
      : conversationQuery.isFetching
        ? "正在載入帳號對話…"
        : deleteConversationMutation.isPending
          ? "正在刪除已保存的對話…"
          : saveConversationMutation.isPending
            ? "正在同步對話…"
            : deleteConversationMutation.isError
              ? parseConversationSyncError(deleteConversationMutation.error)
              : saveConversationMutation.isError
                ? parseConversationSyncError(saveConversationMutation.error)
                : conversationQuery.isError
                  ? parseConversationSyncError(conversationQuery.error)
                  : saveConversationMutation.isSuccess
                    ? "對話已同步 · 最多保留最近 50 則訊息"
                    : "帳號同步已就緒 · 最多保留最近 50 則訊息";

  const submitQuestion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (
      !trimmedQuestion ||
      mutation.isPending ||
      saveConversationMutation.isPending ||
      deleteConversationMutation.isPending ||
      conversationQuery.isFetching
    ) {
      return;
    }

    const submittedUserId = isSignedIn ? currentUserId : null;
    const submittedQueryKey = [
      "account-ceo-ai-conversation",
      submittedUserId ?? "signed-out",
      conversationSymbol,
    ] as const;
    const userMessage: AssistantChatMessage = {
      role: "user",
      content: trimmedQuestion,
    };
    const history = getPersistableAssistantMessages(messages)
      .slice(-6)
      .map(({ role, content }) => ({ role, content: content.slice(0, 1000) }));
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    mutation.mutate(
      { question: trimmedQuestion, history },
      {
        onSuccess: (reply) => {
          if (activeUserId.current !== submittedUserId) {
            return;
          }
          const assistantMessage: AssistantChatMessage =
            "citedFacts" in reply
              ? {
                  role: "assistant",
                  content: reply.answer,
                  aiProvider: reply.aiProvider,
                  citedFacts: reply.citedFacts,
                  context: reply.context,
                  disclaimer: reply.disclaimer,
                }
              : {
                  role: "assistant",
                  content: reply.answer,
                  aiProvider: reply.aiProvider,
                  sources: reply.sources,
                  searchStatus: reply.searchStatus,
                };
          const nextMessages = [
            ...getPersistableAssistantMessages(messages),
            userMessage,
            assistantMessage,
          ].slice(-MAX_SAVED_ASSISTANT_MESSAGES);
          setMessages(nextMessages);
          if (submittedUserId) {
            saveConversationMutation.reset();
            saveConversationMutation.mutate(
              {
                data: {
                  symbol: conversationSymbol,
                  messages: nextMessages,
                },
              },
              {
                onSuccess: (savedConversation) => {
                  queryClient.setQueryData(submittedQueryKey, savedConversation);
                },
              },
            );
          }
        },
        onError: (error) => {
          if (activeUserId.current !== submittedUserId) {
            return;
          }
          setMessages((current) => [
            ...current,
            {
              role: "assistant",
              content: parseAiRequestError(error),
              isError: true,
            },
          ]);
          if (submittedUserId) {
            const unansweredMessages = [
              ...getPersistableAssistantMessages(messages),
              userMessage,
            ].slice(-MAX_SAVED_ASSISTANT_MESSAGES);
            saveConversationMutation.reset();
            saveConversationMutation.mutate(
              {
                data: {
                  symbol: conversationSymbol,
                  messages: unansweredMessages,
                },
              },
              {
                onSuccess: (savedConversation) => {
                  queryClient.setQueryData(submittedQueryKey, savedConversation);
                },
              },
            );
          }
        },
      },
    );
  };

  const clearConversation = () => {
    if (
      mutation.isPending ||
      saveConversationMutation.isPending ||
      deleteConversationMutation.isPending ||
      conversationQuery.isFetching
    ) {
      return;
    }

    if (!isSignedIn || !currentUserId) {
      setMessages([]);
      mutation.reset();
      return;
    }

    deleteConversationMutation.mutate(
      { params: { symbol: conversationSymbol } },
      {
        onSuccess: () => {
          setMessages([]);
          mutation.reset();
          saveConversationMutation.reset();
          queryClient.setQueryData(conversationQueryKey, {
            symbol: conversationSymbol,
            messages: [],
          });
        },
      },
    );
  };

  if (!isAvailable) return null;

  return (
    <div className="stock-ai-chat-floating">
      {isOpen && (
        <section
          className="stock-ai-chat-panel"
          id="stock-ai-assistant-panel"
          role="dialog"
          aria-label="投資研究部 CEO 對話"
          data-testid="panel-stock-ai-assistant"
        >
          <div className="stock-ai-chat-heading">
            <div>
              <h3><Sparkles size={15} /> 投資研究部 CEO</h3>
              <p>可直接詢問台股大盤、產業、ETF 或個股；CEO 會依問題整理資料並附上可用來源。</p>
              <small
                className={`stock-ai-chat-sync-status${conversationQuery.isError || saveConversationMutation.isError || deleteConversationMutation.isError ? " is-error" : ""}`}
                role="status"
              >
                {conversationSyncStatus}
              </small>
            </div>
            <div className="stock-ai-chat-header-actions">
              <AiProviderBadge provider={latestAiProvider} compact />
              {messages.length > 0 && (
                <button
                  type="button"
                  className="stock-ai-chat-icon-button"
                  aria-label="清除對話"
                  title={isSignedIn ? "刪除帳號中保存的對話" : "清除本頁對話"}
                  disabled={mutation.isPending || saveConversationMutation.isPending || deleteConversationMutation.isPending || conversationQuery.isFetching}
                  onClick={clearConversation}
                  data-testid="button-clear-stock-ai-chat"
                >
                  <RefreshCw size={14} />
                </button>
              )}
              <button
                type="button"
                className="stock-ai-chat-icon-button"
                aria-label="關閉 CEO 對話"
                onClick={() => {
                  setIsOpen(false);
                  launcherRef.current?.focus();
                }}
                data-testid="button-close-stock-ai-assistant"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="stock-ai-chat-messages" role="log" aria-live="polite" aria-relevant="additions text">
            {messages.length === 0 ? (
            <p className="stock-ai-chat-empty">你好，我是投資研究部 CEO。可以自然詢問台股大盤、產業、ETF、個股或一般投資研究；我會依問題選用研究資料，並標示可用來源與限制。</p>
            ) : messages.map((message, index) => (
              <article className={`stock-ai-chat-message ${message.role} ${message.isError ? "is-error" : ""}`} key={`${message.role}-${index}`}>
                <span className="stock-ai-chat-role">{message.role === "user" ? "你" : "CEO"}</span>
                {message.role === "assistant"
                  ? renderAssistantAnswer(message.content)
                  : <p>{message.content}</p>}
                {(message.citedFacts?.length || message.sources?.length || message.searchStatus || message.context || message.disclaimer) && (
                  <details className="stock-ai-chat-evidence">
                    <summary>查看參考資料</summary>
                    {message.searchStatus && (
                      <p className="stock-ai-chat-search-status">
                        {message.searchStatus === "searched"
                          ? "已搜尋網頁；以下列出可查證來源。"
                          : message.searchStatus === "unavailable"
                            ? "本次網頁搜尋無法使用，最新資訊可能未經查證。"
                            : "這題不需要搜尋網頁。"}
                      </p>
                    )}
                    {message.citedFacts && message.citedFacts.length > 0 && (
                      <ul className="stock-ai-chat-facts">
                        {message.citedFacts.map((fact, factIndex) => <li key={`${factIndex}-${fact}`}>{fact}</li>)}
                      </ul>
                    )}
                    {message.sources && message.sources.length > 0 && (
                      <ul className="stock-ai-chat-source-links">
                        {message.sources.map((source) => (
                          <li key={source.url}>
                            <a href={source.url} target="_blank" rel="noopener noreferrer">
                              {source.title}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {message.context && (
                      <>
                        <div className="stock-ai-chat-context">
                          <span>個股價格 {formatTime(message.context.quoteAsOf)}</span>
                          <span>大盤價格 {formatTime(message.context.marketAsOf)}</span>
                          <span>AI 分析 {formatTime(message.context.analysisAsOf)}</span>
                        </div>
                        <div className="stock-ai-chat-coverage">
                          <span>股價分析 {message.context.coverage.technical === "available" ? "可用" : "無資料"}</span>
                          <span>大盤資料 {message.context.coverage.market === "available" ? "可用" : "無資料"}</span>
                          <span>財報 {message.context.coverage.fundamentals === "available" ? "可用" : "未提供"}</span>
                          <span>大型投資人買賣 {message.context.coverage.institutional === "available" ? "可用" : "未提供"}</span>
                        </div>
                        {message.context.sources.length > 0 && (
                          <small className="stock-ai-chat-sources">來源：{message.context.sources.join(" · ")}</small>
                        )}
                      </>
                    )}
                    {message.disclaimer && <small className="stock-ai-chat-disclaimer">{message.disclaimer}</small>}
                  </details>
                )}
              </article>
            ))}
            {mutation.isPending && (
              <p className="stock-ai-chat-pending" role="status" aria-live="polite">
                <RefreshCw size={14} className="spin" aria-hidden="true" />
                <span>CEO 正在整理問題與可查證資料，請稍候…</span>
              </p>
            )}
            <div ref={messageEndRef} />
          </div>
          <form className="stock-ai-chat-form" onSubmit={submitQuestion}>
            <label htmlFor="stock-ai-question-global">輸入問題</label>
            <textarea
              ref={textareaRef}
              id="stock-ai-question-global"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="例如：今天台股盤勢如何？或比較 6223 與同產業個股"
              maxLength={1000}
              rows={2}
              data-testid="input-stock-ai-question"
            />
            <div className="stock-ai-chat-form-footer">
              <small>{question.length}/1000 · 最新資訊會列出來源，投資資訊不保證未來表現</small>
              <button type="submit" disabled={!question.trim() || mutation.isPending || saveConversationMutation.isPending || deleteConversationMutation.isPending || conversationQuery.isFetching} data-testid="button-ask-stock-ai">
                <ArrowUpRight size={14} />
                {mutation.isPending ? "整理中" : saveConversationMutation.isPending ? "同步中" : deleteConversationMutation.isPending ? "刪除中" : "交給 CEO"}
              </button>
            </div>
          </form>
        </section>
      )}
      <button
        ref={launcherRef}
        type="button"
        className={`stock-ai-chat-launcher ${isOpen ? "is-open" : ""}`}
        aria-label={isOpen ? "關閉投資研究部 CEO" : "開啟投資研究部 CEO"}
        aria-expanded={isOpen}
        aria-controls={isOpen ? "stock-ai-assistant-panel" : undefined}
        onClick={() => setIsOpen((open) => !open)}
        data-testid="button-open-stock-ai-assistant"
      >
        {isOpen ? <X size={21} /> : <MessageCircle size={21} />}
        {!isOpen && <span>CEO</span>}
      </button>
    </div>
  );
}

function formatResearchAmount(value: number | null): string {
  return value === null ? "—" : formatNumber(value, 0);
}

function formatInstitutionalShares(value: number | null): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${formatNumber(value, 0)} 股`;
}

function getStockReferenceDate(assessment: StockAiAssessment): string {
  const dailyTradeDate =
    assessment.source.match(/交易日\s+(\d{4}-\d{2}-\d{2})/u)?.[1];
  return dailyTradeDate ?? formatDate(assessment.quoteAsOf);
}

function ChipExhaustionIndicator({
  bars,
  institutional,
}: {
  bars: Bar[];
  institutional: StockResearchData["institutional"];
}) {
  const signal = evaluateChipExhaustion(bars, institutional);
  return (
    <section
      className={`chip-exhaustion chip-exhaustion-${signal.status}`}
      data-testid="panel-chip-exhaustion"
      role="status"
      aria-label={`買賣力道示意：${signal.label}`}
    >
      <div className="chip-exhaustion-header">
        <span className="chip-exhaustion-lamp" aria-hidden="true" />
        <div>
          <strong>{signal.label}</strong>
          <small>買賣力道示意 · 非即時籌碼</small>
        </div>
      </div>
      <p>{signal.explanation}</p>
      {signal.details && (
        <small className="chip-exhaustion-details" data-testid="text-chip-exhaustion-details">
          {formatDate(signal.details.date)} · 近 5 日{" "}
          {signal.details.return5dPercent > 0 ? "+" : ""}
          {formatNumber(signal.details.return5dPercent, 2)}% · 今日成交量為前 20 日均量{" "}
          {formatNumber(signal.details.volumeRatio20, 2)} 倍 · 投資機構合計{" "}
          {formatInstitutionalShares(signal.details.institutionalNetShares)}
        </small>
      )}
      <small className="chip-exhaustion-note">
        只在日線與官方投資機構資料日期相同時顯示。這是依價格、成交量和當日買賣資料做的簡化推估，未經回測，不代表實際持倉、即時委託或已驗證的買賣訊號。
      </small>
    </section>
  );
}

function StockResearchDataPanel({
  data,
  bars,
  loading,
  error,
  onRetry,
}: {
  data?: StockResearchData;
  bars: Bar[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (!data && loading) {
    return (
      <Panel title="公司財報與投資人買賣" eyebrow="官方資料">
        <SkeletonBlock className="h-[300px]" />
      </Panel>
    );
  }
  if (!data && error) {
    return (
      <Panel title="公司財報與投資人買賣" eyebrow="官方資料">
        <ProviderError
          message={parseError(error)}
          onRetry={onRetry}
          title="AI 分析暫時無法完成"
        />
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title="公司財報與投資人買賣" eyebrow="官方資料">
        <EmptyState
          title="目前沒有公司或投資人資料"
          detail="請確認股票代碼正確，或稍後再試。"
        />
      </Panel>
    );
  }

  const { fundamentals, institutional } = data;
  const period =
    fundamentals.fiscalYear !== null && fundamentals.quarter !== null
      ? `${fundamentals.fiscalYear} 年第 ${fundamentals.quarter} 季`
      : "期間未提供";
  const incomeMetrics = [
    { label: "營收", value: formatResearchAmount(fundamentals.revenueThousandTwd), note: "新台幣千元" },
    { label: "營業獲利", value: formatResearchAmount(fundamentals.operatingIncomeThousandTwd), note: "新台幣千元" },
    { label: "稅後淨利", value: formatResearchAmount(fundamentals.netIncomeThousandTwd), note: "新台幣千元" },
    { label: "每股盈餘", value: fundamentals.epsTwd === null ? "—" : formatNumber(fundamentals.epsTwd, 2), note: "元／股" },
  ];
  const balanceMetrics = [
    { label: "公司資產", value: formatResearchAmount(fundamentals.assetsThousandTwd), note: "新台幣千元" },
    { label: "公司負債", value: formatResearchAmount(fundamentals.liabilitiesThousandTwd), note: "新台幣千元" },
    { label: "股東權益", value: formatResearchAmount(fundamentals.equityThousandTwd), note: "新台幣千元" },
  ];
  const institutionalMetrics = [
    { label: "外資", value: formatInstitutionalShares(institutional.foreignNetShares) },
    { label: "投信（基金）", value: formatInstitutionalShares(institutional.investmentTrustNetShares) },
    { label: "自營商（券商）", value: formatInstitutionalShares(institutional.dealerNetShares) },
    { label: "大型投資人合計", value: formatInstitutionalShares(institutional.totalNetShares) },
  ];

  return (
    <Panel title="公司財報與投資人買賣" eyebrow="官方資料">
      <div className="research-data-section">
        <div className="research-data-heading">
          <div>
            <h3>公司資料｜{period}</h3>
            <p>公布日期 {formatDate(fundamentals.filedAt)}</p>
          </div>
          <span className={`research-data-status ${fundamentals.status}`}>
            {fundamentals.status === "available" ? "有資料" : "未提供"}
          </span>
        </div>
        <h4 className="research-data-subheading">收入與獲利｜今年累計</h4>
        <div className="metric-grid research-data-metrics">
          {incomeMetrics.map((metric) => (
            <MetricCard
              key={metric.label}
              label={metric.label}
              value={metric.value}
              note={metric.note}
              testId={`metric-research-${metric.label}`}
            />
          ))}
        </div>
        <h4 className="research-data-subheading">資產與負債｜季末數字</h4>
        <div className="metric-grid research-data-metrics">
          {balanceMetrics.map((metric) => (
            <MetricCard
              key={metric.label}
              label={metric.label}
              value={metric.value}
              note={metric.note}
              testId={`metric-research-${metric.label}`}
            />
          ))}
        </div>
        <div className="source-line">
          <Info size={13} />
          {fundamentals.source ?? "官方財報"} · 財報期間 {period} · 公布日期 {formatDate(fundamentals.filedAt)}
        </div>
        {fundamentals.reason && <p className="research-data-reason">{fundamentals.reason}</p>}
        <p className="research-data-note">
          收入、獲利與每股盈餘是今年累計；資產與負債是季末數字。金額單位為新台幣千元，每股盈餘單位為元；「—」表示沒有資料。
        </p>
      </div>

      <div className="research-data-section institutional-section">
        <div className="research-data-heading">
          <div>
            <h3>大型投資人最近買賣日</h3>
            <p>資料日期 {formatDate(institutional.observedAt)}</p>
          </div>
          <span className={`research-data-status ${institutional.status}`}>
            {institutional.status === "available" ? "有資料" : "未提供"}
          </span>
        </div>
        <div className="metric-grid research-data-metrics institutional-metrics">
          {institutionalMetrics.map((metric) => (
            <MetricCard
              key={metric.label}
              label={metric.label}
              value={metric.value}
              note="正數為買進，負數為賣出"
              testId={`metric-institutional-${metric.label}`}
            />
          ))}
        </div>
        <div className="source-line">
          <Info size={13} />
          {institutional.source ?? "官方買賣資料"} · 資料日期 {formatDate(institutional.observedAt)}
        </div>
        {institutional.reason && <p className="research-data-reason">{institutional.reason}</p>}
        <p className="research-data-note">
          投資機構資料包含外國投資者、基金公司，以及證券公司用自有資金交易的部分。單位為股，正數代表買進多於賣出，負數則相反；資料每日更新，不是即時數字。
        </p>
        <ChipExhaustionIndicator bars={bars} institutional={institutional} />
      </div>
    </Panel>
  );
}

function FuturesAiDayStrategyPanel({
  strategy,
  loading,
  refreshing,
  error,
  onRetry,
}: {
  strategy: FuturesAiDayStrategy | undefined;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const actionLabels: Record<FuturesAiDayStrategy["action"], string> = {
    long: "價格較可能上漲；符合條件才買進期貨",
    short: "價格較可能下跌；符合條件才賣出期貨",
    wait: "現在先不交易；按下方條件再評估",
    insufficient: "資料不足，現在不交易",
  };
  const statusLabels: Record<FuturesAiDayStrategy["status"], string> = {
    available: "AI 日盤參考",
    waiting_for_day_session: "等待日盤行情",
    insufficient_data: "資料不足",
  };

  return (
    <div className="futures-ai-strategy">
      <div className="futures-strategy-toolbar">
        <span>台指期是大盤期貨；只看日盤，不建議留到隔天</span>
        <AiProviderBadge provider={strategy?.aiProvider} compact />
        <button
          type="button"
          className="ai-refresh-button"
          onClick={onRetry}
          disabled={refreshing}
          data-testid="button-refresh-futures-strategy"
        >
          <RefreshCw size={13} className={refreshing ? "spin" : ""} />
          更新分析
        </button>
      </div>
      {loading ? (
        <div className="futures-strategy-loading">
          <SkeletonBlock className="h-12 w-1/3" />
          <SkeletonBlock className="h-10 w-full" />
          <SkeletonBlock className="h-10 w-full" />
        </div>
       ) : error ? (
        <ProviderError
          message={parseAiRequestError(error)}
          onRetry={onRetry}
          title="AI 分析暫時無法完成"
        />
      ) : !strategy ? (
        <EmptyState title="目前沒有臺指期分析" detail="暫時沒有可用的日盤價格，請稍後再試。" />
      ) : (
        <>
          <div className={`futures-strategy-verdict action-${strategy.action}`}>
            <div>
              <span>{statusLabels[strategy.status]}</span>
              <strong>{actionLabels[strategy.action]}</strong>
            </div>
            <p>{strategy.summary}</p>
          </div>
          <div className="futures-strategy-conditions">
            <div>
              <span>什麼情況再考慮買賣</span>
              <p>{strategy.entryCondition}</p>
            </div>
            <div>
              <span>什麼情況取消這個想法</span>
              <p>{strategy.invalidationCondition}</p>
            </div>
            <div>
              <span>風險提醒</span>
              <p>{strategy.riskNote}</p>
            </div>
          </div>
          <div className="futures-strategy-snapshots" aria-label="參考市場價格">
            {[
              ["臺指期日盤", strategy.dayQuote],
              ["臺指期夜盤", strategy.nightQuote],
              ["加權指數", strategy.taiexQuote],
            ].map(([label, quote]) => {
              const item = quote as FuturesAiDayStrategy["dayQuote"];
              const isDayFuturesQuote = label === "臺指期日盤";
              return (
                <div key={label as string}>
                  <span>{isDayFuturesQuote ? "臺指期日盤 · 行情參考" : label as string}</span>
                  <strong>{item.available && item.price !== null ? formatNumber(item.price, 2) : "暫無報價"}</strong>
                  <small>
                    {item.source ?? "來源未提供"}
                    {item.asOf ? ` · ${formatTimeWithSeconds(item.asOf)}` : ""}
                    {isDayFuturesQuote ? " · 不是買進建議" : ""}
                  </small>
                </div>
              );
            })}
          </div>
          <p className="futures-strategy-limits">
            <Info size={13} />
            目前資料不足以估算精確買進或停損價；這裡只顯示行情參考，不是進場建議。
          </p>
          <div className="source-line">
            <Info size={13} />
            分析時間 {formatTime(strategy.analyzedAt)} · {strategy.disclaimer}
          </div>
        </>
      )}
    </div>
  );
}

function StockAiAssessmentPanel({
  assessment,
  loading,
  refreshing,
  error,
  onRetry,
}: {
  assessment: StockAiAssessment | undefined;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const usingOfficialClose =
    assessment?.source.includes("最近收盤價（非即時") ?? false;
  const biasLabels: Record<StockAiAssessment["biasLevel"], string> = {
    strong_bearish: "明顯偏空",
    bearish: "偏空",
    neutral: "方向不明",
    bullish: "偏多",
    strong_bullish: "明顯偏多",
    insufficient: "資料不足",
  };
  const marketInfluenceLabels: Record<StockAiAssessment["marketInfluence"], string> = {
    supportive: "大盤有利",
    mixed: "大盤分歧",
    headwind: "大盤拖累",
    unavailable: "大盤資料不足",
  };
  const marketInfluenceLabel =
    assessment?.aiProvider === "rule_based" &&
    assessment.marketSummary.startsWith("已取得大盤資料：")
      ? "已取得大盤資料"
      : assessment
        ? marketInfluenceLabels[assessment.marketInfluence]
        : "";
  const smcAnalysis = assessment?.smcAnalysis;
  const granvilleAnalysis = assessment?.granvilleAnalysis;
  const granvilleCandidateCount =
    granvilleAnalysis?.signals.filter((signal) => signal.status === "candidate")
      .length ?? 0;
  const granvilleContextualCount =
    granvilleAnalysis?.signals.filter((signal) => signal.status === "contextual")
      .length ?? 0;
  const granvilleTrendLabels: Record<
    StockAiAssessment["granvilleAnalysis"]["averageTrend"],
    string
  > = {
    rising: "上升",
    flat: "走平",
    falling: "下彎",
    insufficient: "資料不足",
  };
  const granvilleRuleLabels: Record<
    StockAiAssessment["granvilleAnalysis"]["signals"][number]["id"],
    string
  > = {
    buy_breakout: "突破走平或上升的平均價",
    buy_retest: "回到上升平均價附近後收回",
    buy_false_breakdown: "跌到平均價下方後重新站回",
    buy_rebound: "低於下彎平均價的距離",
    sell_breakdown: "收盤跌破走平或下彎平均價",
    sell_resistance: "反彈至下彎平均價附近後回落",
    sell_false_breakout: "站上後又跌回下彎平均價下方",
    sell_overextension: "高於平均價的距離",
  };
  const granvilleStatusLabels: Record<
    StockAiAssessment["granvilleAnalysis"]["signals"][number]["status"],
    string
  > = {
    candidate: "候選情境",
    contextual: "需整體判讀",
    not_detected: "尚未符合",
    insufficient: "資料不足",
  };
  const smcStructureLabels: Record<
    StockAiAssessment["smcAnalysis"]["structure"],
    string
  > = {
    bullish: "高低點逐步走高",
    bearish: "高低點逐步走低",
    range: "高低點方向不一致",
    developing: "結構仍在形成",
    insufficient: "資料不足",
  };
  const smcBreakLabels: Record<
    NonNullable<StockAiAssessment["smcAnalysis"]["latestBreak"]["kind"]>,
    string
  > = {
    bullish_bos: "收盤突破前高，延續上行結構（BOS）",
    bearish_bos: "收盤跌破前低，延續下行結構（BOS）",
    bullish_choch: "收盤突破前高，原下行結構可能改變（CHoCH）",
    bearish_choch: "收盤跌破前低，原上行結構可能改變（CHoCH）",
    bullish_break: "收盤突破已確認前高，趨勢分類尚不明",
    bearish_break: "收盤跌破已確認前低，趨勢分類尚不明",
  };
  const formatSmcPrice = (price: number | null) =>
    price === null
      ? "—"
      : `${price.toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 元`;
  const formatSmcDate = (date: string | Date | null) => {
    if (!date) return "日期不明";
    const parsedDate = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(parsedDate.getTime())) return "日期不明";
    return parsedDate.toLocaleDateString("zh-TW", {
          timeZone: "Asia/Taipei",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
  };
  const smcZoneRows = smcAnalysis
    ? [
        ...smcAnalysis.candidateOrderBlocks.map((zone) => ({
          key: `ob-${zone.date}-${zone.direction}`,
          title: `候選${zone.direction === "bullish" ? "上行" : "下行"}訂單區`,
          date: formatSmcDate(zone.date),
          range: `${formatSmcPrice(zone.lower)}–${formatSmcPrice(zone.upper)}`,
          status: zone.status === "retested" ? "曾回測" : "尚未回測",
        })),
        ...smcAnalysis.fairValueGaps.map((zone) => ({
          key: `fvg-${zone.date}-${zone.direction}`,
          title: `${zone.direction === "bullish" ? "上行" : "下行"}失衡區（FVG）`,
          date: formatSmcDate(zone.date),
          range: `${formatSmcPrice(zone.lower)}–${formatSmcPrice(zone.upper)}`,
          status:
            zone.status === "open"
              ? "尚未回到區間"
              : zone.status === "partially_filled"
                ? "曾進入區間"
                : "區間已完全穿越",
        })),
      ]
    : [];
  const confidenceLabel = assessment?.confidence === "high"
    ? "高"
    : assessment?.confidence === "medium"
      ? "中"
      : assessment?.confidence === "low"
        ? "低"
        : "不適用";
  const hasCompleteBuyPlan = Boolean(
    assessment?.action === "buy" &&
      assessment.direction === "bullish" &&
      assessment.pricePlanStatus === "available" &&
      assessment.entryPrice !== null &&
      Boolean(assessment.entryReason) &&
      assessment.stopLossPrice !== null &&
      Boolean(assessment.stopLossReason) &&
      assessment.takeProfitPrice !== null &&
      Boolean(assessment.takeProfitReason) &&
      assessment.stopLossPrice < assessment.entryPrice &&
      assessment.entryPrice < assessment.takeProfitPrice,
  );
  const actionLabel = !assessment
    ? "資料不足"
    : usingOfficialClose
      ? assessment.action === "buy"
        ? hasCompleteBuyPlan
          ? `明日核價 · AI 主觀勝率較佳買價 ${formatNumber(assessment.entryPrice, 2)} 元`
          : "現在先不買"
        : assessment.action === "hold"
          ? "續抱，不加碼"
          : assessment.action === "sell"
            ? "持有者減碼"
            : assessment.action === "insufficient"
              ? "資料不足，先不動"
              : "先不買"
      : assessment.action === "buy" && hasCompleteBuyPlan
        ? `AI 主觀勝率較佳買價 ${formatNumber(assessment.entryPrice, 2)} 元`
        : assessment.action === "hold"
          ? "續抱，不加碼"
          : assessment.action === "sell"
            ? "持有者減碼"
            : assessment.action === "insufficient"
              ? "資料不足，先不動"
              : "先不買";
  const actionContext = !assessment
    ? "等待個股 AI 分析完成後再判斷。"
    : usingOfficialClose
      ? assessment.action === "buy"
        ? hasCompleteBuyPlan
          ? `依 ${getStockReferenceDate(assessment)} 收盤資料估算。AI 主觀勝率較佳買價為 ${formatNumber(assessment.entryPrice, 2)} 元；明天先核對即時價，條件未轉弱再分批進場。`
          : "方向偏多，但缺少完整價位方案；現在先不買，明天核對即時行情再判斷。"
        : assessment.action === "hold"
          ? "未持有：先不買。已持有：續抱、不加碼。"
          : assessment.action === "sell"
            ? "未持有：不買。已持有：考慮減碼或退出；不是放空訊號。"
            : assessment.action === "insufficient"
              ? "資料不足，先不買賣；行情資料補齊後再判斷。"
              : "現在先不買；明天用最新成交價和走勢重新判斷。"
      : assessment.action === "buy" && hasCompleteBuyPlan
        ? assessment.referenceType === "verified_trade" &&
          assessment.entryPrice !== null &&
          assessment.referencePrice > assessment.entryPrice
          ? `現價 ${formatNumber(assessment.referencePrice, 2)} 元高於 AI 主觀勝率較佳買價 ${formatNumber(assessment.entryPrice, 2)} 元；先別追，回到該價附近且條件仍成立再分批進。`
          : `AI 主觀勝率較佳買價 ${formatNumber(assessment.entryPrice, 2)} 元；確認行情條件仍成立，再按方案分批進場。`
        : assessment.action === "buy"
          ? "買進方案缺少可驗證價位，現在先不買。"
          : assessment.action === "hold"
            ? "未持有：先不買。已持有：續抱、不加碼。"
            : assessment.action === "sell"
              ? "未持有：不買。已持有：考慮減碼或退出；不是放空訊號。"
              : assessment.action === "wait"
                ? assessment.actionReferencePrice !== null &&
                  assessment.actionReferenceLabel
                  ? `現在先不買；股價到 ${assessment.actionReferenceLabel} ${formatNumber(assessment.actionReferencePrice, 2)} 元附近，再核對行情重判。`
                  : "現在先不買；等短線方向和行情條件明確再判斷。"
                : "資料不足，先不買賣；等行情資料補齊再判斷。";

  return (
    <Panel
      title="個股短線結論"
      eyebrow="大盤＋個股證據 · 未來 1–5 個交易日"
      className="ai-assessment-panel"
      action={
        <div className="ai-panel-actions">
          <AiProviderBadge
            provider={assessment?.aiProvider}
            compact
            context="stock_assessment"
            state={
              !assessment && loading
                ? "loading"
                : !assessment && error
                  ? "unavailable"
                  : "idle"
            }
          />
          <button
            type="button"
            className="ai-refresh-button"
            onClick={onRetry}
            disabled={loading || refreshing}
            data-testid="button-refresh-ai-assessment"
          >
            <RefreshCw size={13} className={loading || refreshing ? "spin" : ""} />
            {refreshing ? "更新中" : "更新分析"}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="ai-assessment-loading">
          <SkeletonBlock className="h-14 w-28" />
          <div className="flex-1 space-y-3">
            <SkeletonBlock className="h-4 w-2/3" />
            <SkeletonBlock className="h-3 w-full" />
            <SkeletonBlock className="h-3 w-4/5" />
          </div>
        </div>
      ) : error ? (
        <ProviderError
          message={parseError(error)}
          onRetry={onRetry}
          title="AI 個股判讀暫時無法完成"
          markdownReport={getErrorMarkdownReport(error)}
        />
      ) : !assessment ? (
        <EmptyState title="目前沒有 AI 分析" detail="尚未取得足夠的行情與分析資料。" />
      ) : (
        <>
          {refreshing && (
            <div className="ai-refreshing-status" role="status" aria-live="polite" data-testid="status-ai-assessment-refreshing">
              <RefreshCw size={13} className="spin" />
              正在依最新可用行情更新分析；目前仍顯示上一筆完成結果。
            </div>
          )}
          <div className="ai-assessment-top">
            <div className={`sentiment-dashboard ${assessment.biasLevel}`}>
              <div className="sentiment-dashboard-heading">
                <Sparkles size={14} />
                <span>AI 方向參考</span>
              </div>
              <strong className="sentiment-value">{biasLabels[assessment.biasLevel]}</strong>
              <SemicircleSentimentGauge level={assessment.biasLevel} label={biasLabels[assessment.biasLevel]} />
              <small>僅供參考，不是上漲機率</small>
            </div>
            <div className="ai-assessment-copy">
              <div className="ai-status-row">
                <span className="ai-action-label">{actionLabel}</span>
                <span className="ai-confidence">線索一致度：{confidenceLabel}（不是勝率）</span>
                {usingOfficialClose && (
                  <span className="ai-confidence">
                    分析基準：最近官方收盤價（不是即時價格） · 交易日{" "}
                    {getStockReferenceDate(assessment)}
                  </span>
                )}
                {!usingOfficialClose && (
                  <span className="ai-confidence">
                    分析基準：已驗證盤中成交 · 報價時間{" "}
                    {formatTimeWithSeconds(assessment.quoteAsOf)}
                  </span>
                )}
              </div>
              <p className="ai-summary-plain" data-testid="text-ai-action">
                {actionContext}
              </p>
              <span className={`ai-market-pill ${assessment.marketInfluence}`}>
                {marketInfluenceLabel}
              </span>
            </div>
          </div>
          <StockAiHistoricalValidation symbol={assessment.symbol} />
          <StockAiScorecardDetails assessment={assessment} />
          <div className="ai-systematic-method-note" data-testid="note-ai-systematic-method">
            <div>
                <strong>怎麼判斷</strong>
              <p>
                  先比大盤、個股近 5／20／60 日和量價，再看可用的財報與法人資料。線索打架就不硬猜；信心代表線索一致程度，不是勝率。
              </p>
            </div>
            <a
              href="https://www.aminext.blog/post/behavioral-economics-stock-market-investing"
              target="_blank"
              rel="noreferrer"
            >
              行為經濟學來源
            </a>
          </div>
          <details className="ai-detail-disclosure">
            <summary>
              <span>看關鍵數據和風險</span>
              <small>{assessment.signals.length} 項支持線索 · {assessment.risks.length} 項反向風險</small>
            </summary>
            <div className="ai-detail-narrative">
              <strong>方向理由</strong>
              <p>{assessment.summary}</p>
              <strong>操作方式</strong>
              <p>{assessment.actionText}</p>
            </div>
            <div className={`ai-market-context ${assessment.marketInfluence}`}>
              <span>{marketInfluenceLabel}</span>
              <p>{assessment.marketSummary}</p>
            </div>
            <section
              className="smc-analysis-card"
              aria-label="SMC 日線結構觀察"
              data-testid="smc-analysis"
            >
              <div className="smc-analysis-head">
                <div>
                  <strong>SMC 日線觀察</strong>
                  <small>
                    官方日線至 {formatSmcDate(smcAnalysis?.sourceDate ?? null)} ·{" "}
                    {smcAnalysis?.barsUsed ?? 0} 根 K 棒
                  </small>
                </div>
                <span
                  className={`smc-structure-tag ${smcAnalysis?.structure ?? "insufficient"}`}
                >
                  {smcAnalysis
                    ? smcStructureLabels[smcAnalysis.structure]
                    : "資料不足"}
                </span>
              </div>
              <div className="smc-analysis-grid">
                <div>
                  <span>最近已確認波段高點</span>
                  <p>
                    {formatSmcPrice(smcAnalysis?.swingHigh.price ?? null)}
                    {smcAnalysis?.swingHigh.date
                      ? ` · ${formatSmcDate(smcAnalysis.swingHigh.date)}`
                      : ""}
                  </p>
                </div>
                <div>
                  <span>最近已確認波段低點</span>
                  <p>
                    {formatSmcPrice(smcAnalysis?.swingLow.price ?? null)}
                    {smcAnalysis?.swingLow.date
                      ? ` · ${formatSmcDate(smcAnalysis.swingLow.date)}`
                      : ""}
                  </p>
                </div>
                <div className="smc-analysis-wide">
                  <span>最近結構事件</span>
                  <p>
                    {smcAnalysis?.latestBreak.kind
                      ? `${smcBreakLabels[smcAnalysis.latestBreak.kind]} · ${formatSmcDate(smcAnalysis.latestBreak.date)} · ${formatSmcPrice(smcAnalysis.latestBreak.level)}`
                      : "近期沒有收盤突破已確認的波段高低點。"}
                  </p>
                </div>
                <div className="smc-analysis-wide">
                  <span>掃過前高低後收回</span>
                  <p>
                    {smcAnalysis?.liquiditySweeps.length
                      ? smcAnalysis.liquiditySweeps
                          .map((sweep) =>
                            `${formatSmcDate(sweep.date)} ${sweep.side === "buy_side" ? "上方前高" : "下方前低"} ${formatSmcPrice(sweep.level)}`
                          )
                          .join("；")
                      : "近期沒有偵測到符合條件的掃過後收回。"}
                  </p>
                </div>
                <div className="smc-analysis-wide">
                  <span>相近高低點候選區</span>
                  <p>
                    {smcAnalysis?.liquidityPools.length
                      ? smcAnalysis.liquidityPools
                          .map(
                            (pool) =>
                              `${pool.side === "buy_side" ? "相近高點" : "相近低點"} ${formatSmcPrice(pool.lower)}–${formatSmcPrice(pool.upper)}（${pool.touches} 次）`
                          )
                          .join("；")
                      : "目前沒有符合相近高低點條件的候選區。"}
                  </p>
                </div>
              </div>
              <div className="smc-zone-list">
                <span>候選訂單區與失衡區</span>
                {smcZoneRows.length ? (
                  <ul>
                    {smcZoneRows.map((zone) => (
                      <li key={zone.key}>
                        <strong>{zone.title}</strong>
                        <span>{zone.range}</span>
                        <small>{zone.date} · {zone.status}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>近期沒有可列出的候選區域。</p>
                )}
              </div>
              <p className="smc-analysis-note">
                {smcAnalysis?.notes ??
                  "SMC 日線資料不足，不能據此產生結構判讀。"}
              </p>
            </section>
            <section
              className="smc-analysis-card granville-analysis-card"
              aria-label="葛蘭碧八大法則均線觀察"
              data-testid="granville-analysis"
            >
              <div className="smc-analysis-head granville-analysis-head">
                <div>
                  <strong>葛蘭碧八大法則觀察</strong>
                  <small>
                    20 日平均價 · 官方日線至{" "}
                    {formatSmcDate(granvilleAnalysis?.sourceDate ?? null)}
                  </small>
                </div>
                <span className="granville-candidate-count">
                  {granvilleCandidateCount} 個明確候選
                </span>
              </div>
              <div className="granville-metrics">
                <div>
                  <span>最近收盤價</span>
                  <strong>
                    {formatSmcPrice(granvilleAnalysis?.latestClose ?? null)}
                  </strong>
                </div>
                <div>
                  <span>20 日平均價</span>
                  <strong>
                    {formatSmcPrice(granvilleAnalysis?.movingAverage ?? null)}
                  </strong>
                </div>
                <div>
                  <span>平均價近 5 日方向</span>
                  <strong>
                    {granvilleAnalysis
                      ? granvilleTrendLabels[granvilleAnalysis.averageTrend]
                      : "資料不足"}
                  </strong>
                  <small>
                    {typeof granvilleAnalysis?.slopePercent5d === "number"
                      ? `${formatNumber(granvilleAnalysis.slopePercent5d, 3)}%`
                      : "斜率資料不足"}
                  </small>
                </div>
              </div>
              <div className="granville-signal-grid">
                {granvilleAnalysis?.signals.map((signal) => (
                  <div
                    key={signal.id}
                    className={`granville-signal ${signal.direction} ${signal.status}`}
                    data-testid={`granville-signal-${signal.id}`}
                  >
                    <div className="granville-signal-head">
                      <strong>{granvilleRuleLabels[signal.id]}</strong>
                      <span className={`granville-signal-status ${signal.status}`}>
                        {granvilleStatusLabels[signal.status]}
                      </span>
                    </div>
                    <p>{signal.explanation}</p>
                  </div>
                ))}
              </div>
              <p className="granville-analysis-note">
                明確候選只標記日線穿越或觸及後收回；「接近／遠離」會列出實際距離，不設固定門檻。這些不是自動買賣指令或已驗證的獲利策略，需和較長期走勢、大盤及成交資料一起看。
              </p>
              <details className="granville-method">
                <summary data-testid="summary-granville-method">
                  計算方式與來源
                </summary>
                <p>{granvilleAnalysis?.methodNote ?? "均線資料不足，暫無法計算。"}</p>
                <a
                  href="https://learningpa.cc/blog10/"
                  target="_blank"
                  rel="noreferrer"
                  data-testid="link-granville-source"
                >
                  來源文章：學吧 LearningPa《葛蘭碧八大法則》
                </a>
              </details>
            </section>
            <div className="ai-detail-grid">
              <div>
                <h4>有利線索</h4>
                {assessment.signals.length ? (
                  <ul>{assessment.signals.map((signal, index) => <li key={`${index}-${signal}`}>{signal}</li>)}</ul>
                ) : <p className="ai-empty-list">沒有額外支持因素。</p>}
              </div>
              <div>
                <h4>主要風險</h4>
                {assessment.risks.length ? (
                  <ul>{assessment.risks.map((risk, index) => <li key={`${index}-${risk}`}>{risk}</li>)}</ul>
                ) : <p className="ai-empty-list">沒有額外風險說明。</p>}
              </div>
            </div>
            <div className="ai-detail-grid stock-web-research">
              <div>
                <h4>近期網路搜尋補充</h4>
                <p>
                  {assessment.webResearch.status === "searched"
                    ? "以下是 DuckDuckGo 搜尋摘要，可能不完整，尚未核對完整網頁。"
                    : assessment.webResearch.status === "no_results"
                      ? "DuckDuckGo 沒有找到可用結果，近期消息未納入判讀。"
                      : "DuckDuckGo 搜尋暫時不可用，近期消息未納入判讀。"}
                </p>
                {assessment.webResearch.searchedAt && (
                  <small>搜尋時間：{formatTime(assessment.webResearch.searchedAt)}</small>
                )}
              </div>
              <div>
                <h4>來源（點擊核對原文）</h4>
                {assessment.webResearch.sources.length ? (
                  <ul>
                    {assessment.webResearch.sources.map((source, index) => (
                      <li key={`${source.url}-${index}`}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                        {source.snippet && <small>{source.snippet}</small>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ai-empty-list">沒有可列出的搜尋來源。</p>
                )}
              </div>
            </div>
            <div className="source-line">
              <Info size={13} />
              報價：{assessment.source} · 報價時間 {formatTime(assessment.quoteAsOf)} · AI 更新 {formatTime(assessment.analyzedAt)} · {assessment.disclaimer}
            </div>
          </details>
        </>
      )}
    </Panel>
  );
}

function MetricCard({ label, value, note, accent = "ink", testId }: { label: string; value: string; note: string; accent?: "ink" | "rising" | "falling" | "signal"; testId: string }) {
  return (
    <div className="metric-card" data-testid={testId}>
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${accent}`}>{value}</div>
      <div className="metric-note">{note}</div>
    </div>
  );
}

function DecisionCalculator({ latestPrice, atr, currency, symbol, priceBasis, assessment }: {
  latestPrice: number | null;
  atr: number | null;
  currency: string | null;
  symbol: string;
  priceBasis: string;
  assessment?: StockAiAssessment;
}) {
  const [buyPrice, setBuyPrice] = useState("");
  const [plannedShares, setPlannedShares] = useState("");
  const [investmentLimit, setInvestmentLimit] = useState("");
  const [target, setTarget] = useState("");
  const [stop, setStop] = useState("");
  const [costBasis, setCostBasis] = useState("");
  const [shares, setShares] = useState("");
  const buyPriceVerdictMutation = useMutation({
    mutationFn: (data: Parameters<typeof evaluateStockAiBuyPrice>[0]) =>
      evaluateStockAiBuyPrice(data, { signal: AbortSignal.timeout(AI_ACTION_TIMEOUT_MS) }),
  });
  const assistantMutation = useMutation({
    mutationFn: (data: Parameters<typeof askStockAiAssistant>[0]) =>
      askStockAiAssistant(data, { signal: AbortSignal.timeout(AI_ACTION_TIMEOUT_MS) }),
  });
  const latestSymbolRef = useRef(symbol.replace(/\.(TW|TWO)$/i, ""));
  latestSymbolRef.current = symbol.replace(/\.(TW|TWO)$/i, "");
  const previousSymbol = useRef(symbol);
  const manuallyEditedPlan = useRef(false);
  const aiSeededPlanKey = useRef<string | null>(null);

  useEffect(() => {
    if (previousSymbol.current !== symbol) {
      previousSymbol.current = symbol;
      manuallyEditedPlan.current = false;
      aiSeededPlanKey.current = null;
      setBuyPrice("");
      setPlannedShares("");
      setTarget("");
      setStop("");
      setCostBasis("");
      setShares("");
      buyPriceVerdictMutation.reset();
      assistantMutation.reset();
    }
  }, [symbol]);

  useEffect(() => {
    const hasCompletePlan =
      assessment?.action === "buy" &&
      assessment.pricePlanStatus === "available" &&
      assessment.entryPrice !== null &&
      assessment.stopLossPrice !== null &&
      assessment.takeProfitPrice !== null;
    if (manuallyEditedPlan.current) return;

    if (
      hasCompletePlan &&
      assessment?.entryPrice !== null &&
      assessment?.stopLossPrice !== null &&
      assessment?.takeProfitPrice !== null
    ) {
      const planKey = `${assessment.symbol}:${assessment.analyzedAt}`;
      if (aiSeededPlanKey.current !== planKey) {
        setBuyPrice(assessment.entryPrice.toFixed(2));
        setStop(assessment.stopLossPrice.toFixed(2));
        setTarget(assessment.takeProfitPrice.toFixed(2));
        aiSeededPlanKey.current = planKey;
      }
    } else if (aiSeededPlanKey.current !== null) {
      setBuyPrice("");
      setStop("");
      setTarget("");
      aiSeededPlanKey.current = null;
    }
  }, [assessment]);

  const values = {
    buy: Number(buyPrice),
    plannedShares: Number(plannedShares),
    target: Number(target),
    stop: Number(stop),
    basis: Number(costBasis),
    shares: Number(shares),
  };
  const isValidPlannedShares =
    Number.isSafeInteger(values.plannedShares) && values.plannedShares >= 1;
  const budget =
    values.buy > 0 && isValidPlannedShares
      ? values.buy * values.plannedShares
      : null;
  const budgetShareLimit = calculateBudgetShareLimit(
    Number(investmentLimit),
    values.buy,
  );
  const estimatedBudgetSpend =
    budgetShareLimit !== null && budgetShareLimit > 0 && values.buy > 0
      ? budgetShareLimit *
        values.buy *
        (1 + TAIWAN_STOCK_BUY_COMMISSION_RATE)
      : null;
  const targetRoundTripEstimate = calculateRoundTripEstimate(
    values.buy,
    values.target,
    values.plannedShares,
  );
  const stopRoundTripEstimate = calculateRoundTripEstimate(
    values.buy,
    values.stop,
    values.plannedShares,
  );
  const reward = values.target > values.buy ? values.target - values.buy : null;
  const risk = values.stop > 0 && values.buy > values.stop ? values.buy - values.stop : null;
  const rewardRisk = reward !== null && risk !== null && risk > 0 ? reward / risk : null;
  const unrealized = values.basis > 0 && values.shares > 0 && latestPrice !== null ? (latestPrice - values.basis) * values.shares : null;
  const accentCurrency = currency ?? "TWD";
  const normalizedSymbol = symbol.replace(/\.(TW|TWO)$/i, "");
  const isOfficialCloseReference =
    assessment?.referenceType === "official_daily_close";
  const calculatorReferencePrice =
    isOfficialCloseReference && assessment
      ? assessment.referencePrice
      : latestPrice;
  const canEvaluateBuyPrice =
    Boolean(assessment) &&
    Number.isFinite(values.buy) &&
    values.buy > 0;
  const canAskPosition = Boolean(assessment) && Number.isSafeInteger(values.shares) && values.shares > 0 && Number.isFinite(values.basis) && values.basis > 0;
  const positionActionLabels: Record<string, string> = {
    add: "建議加碼",
    hold: "續抱",
    no_add: "續抱，不加碼",
    reduce: "減碼",
    take_profit: "停利",
    stop_loss: "停損",
    exit: "退出持股",
    wait: "先等待",
    insufficient: "資料不足，先不加碼",
  };
  const buyVerdictMatchesCurrentInput = matchesBuyVerdictInputs(
    buyPriceVerdictMutation.data,
    symbol,
    values.buy,
  );
  const buyVerdictAnalysisDiffersFromDisplayed =
    Boolean(buyPriceVerdictMutation.data && assessment) &&
    usesDifferentAnalysisVersion(
      buyPriceVerdictMutation.data?.analysisAsOf,
      assessment?.analyzedAt,
    );
  const matchingBuyVerdict =
    buyVerdictMatchesCurrentInput
      ? buyPriceVerdictMutation.data
      : undefined;
  const buyVerdictMismatchMessage =
    !buyPriceVerdictMutation.data ||
    buyPriceVerdictMutation.isPending ||
    buyPriceVerdictMutation.isError ||
    matchingBuyVerdict
      ? ""
      : "這份結果對應的股票或買進價與目前欄位不同，請重新檢查。";
  const evaluateBuyPrice = () => {
    if (!canEvaluateBuyPrice) return;
    buyPriceVerdictMutation.mutate({
      symbol,
      plannedBuyPrice: values.buy,
    });
  };
  const askPositionSuggestion = () => {
    if (!canAskPosition) return;
    assistantMutation.mutate({
      symbol,
      question: `我目前持有 ${values.shares} 股（台股 1 張 = 1,000 股；此欄填的是股數，不是張數），平均成本為每股 ${values.basis.toFixed(2)} 元。請依目前個股判讀與我的成本，明確選擇最適合的持倉動作：加碼、續抱、不加碼、減碼、停利、停損、退出、等待或資料不足；操作答案只填在 positionAction 欄位，answer 只用一到兩句說明可核對的行情與原因，不要重複任何操作指示。若資料不足，請指出缺少什麼；不要虛構價位或停利停損門檻。加碼必須符合有效買進方案；收盤後只能建議下一交易日確認行情後再評估。收盤後請以最近官方收盤價和個股近 5 日、20 日表現判斷並標明收盤日。`,
    }, { onSuccess: (reply) => {
      if (reply.symbol.replace(/\.(TW|TWO)$/i, "") !== latestSymbolRef.current) assistantMutation.reset();
    } });
  };
  const applyAiPricePlan = () => {
    if (
      assessment?.action !== "buy" ||
      assessment?.pricePlanStatus !== "available" ||
      assessment.entryPrice === null ||
      assessment.stopLossPrice === null ||
      assessment.takeProfitPrice === null
    ) {
      return;
    }
    setBuyPrice(assessment.entryPrice.toFixed(2));
    setStop(assessment.stopLossPrice.toFixed(2));
    setTarget(assessment.takeProfitPrice.toFixed(2));
    manuallyEditedPlan.current = false;
    aiSeededPlanKey.current = `${assessment.symbol}:${assessment.analyzedAt}`;
    buyPriceVerdictMutation.reset();
  };
  const applyBudgetShareLimit = () => {
    if (budgetShareLimit === null || budgetShareLimit < 1) return;
    setPlannedShares(String(budgetShareLimit));
  };
  const hasCompleteAiPricePlan =
    assessment?.action === "buy" &&
    assessment?.direction === "bullish" &&
    assessment?.pricePlanStatus === "available" &&
    assessment.entryPrice !== null &&
    Boolean(assessment.entryReason) &&
    assessment.stopLossPrice !== null &&
    Boolean(assessment.stopLossReason) &&
    assessment.takeProfitPrice !== null &&
    Boolean(assessment.takeProfitReason) &&
    assessment.stopLossPrice < assessment.entryPrice &&
    assessment.entryPrice < assessment.takeProfitPrice;
  const validatedAiPlan =
    hasCompleteAiPricePlan && assessment ? assessment : undefined;
  const validatedEntryPrice = validatedAiPlan?.entryPrice ?? null;
  const canUseAggressiveEntryTier = Boolean(
    validatedAiPlan &&
      validatedEntryPrice !== null &&
      validatedAiPlan.biasLevel === "strong_bullish" &&
      validatedAiPlan.referencePrice <= validatedEntryPrice,
  );
  const entryTierOnePrice = validatedAiPlan && validatedEntryPrice !== null
    ? canUseAggressiveEntryTier
      ? validatedAiPlan.referencePrice
      : validatedEntryPrice
    : null;
  const supportObservationPrice =
    validatedAiPlan?.tradeScenarios.supportPrice ?? null;
  const entryTierTwoPrice =
    validatedAiPlan &&
    validatedEntryPrice !== null &&
    supportObservationPrice !== null &&
    supportObservationPrice < validatedEntryPrice
      ? supportObservationPrice
      : null;
  const suggestedEntryRange =
    entryTierOnePrice !== null && entryTierTwoPrice !== null
      ? `${formatNumber(Math.min(entryTierOnePrice, entryTierTwoPrice), 2)} ~ ${formatNumber(Math.max(entryTierOnePrice, entryTierTwoPrice), 2)} 元`
      : entryTierOnePrice !== null
        ? `${formatNumber(entryTierOnePrice, 2)} 元`
        : null;
  const volumePriceEvidence = assessment?.scorecard.items
    .filter((item) => item.id === "volume-breakout" || item.id === "obv-trend")
    .map((item) => item.note)
    .filter(Boolean)
    .join(" ");
  const closeConclusion = validatedAiPlan
    ? {
        label: "🟢 建議逢低買入",
        detail: "僅供下一交易日條件參考；開盤後先核對即時成交價，條件仍成立才考慮進場。",
        tone: "positive",
      }
    : assessment?.action === "sell" ||
        assessment?.biasLevel === "bearish" ||
        assessment?.biasLevel === "strong_bearish"
      ? {
          label: "🔴 暫緩買進",
          detail: "目前判讀偏弱，先不要把觀察價當成進場訊號；等走勢與量價條件改善後再評估。",
          tone: "negative",
        }
      : {
          label: "🟡 逢低佈局觀望",
          detail: "目前沒有完整有效的買進計畫；先觀察回測支撐與量價變化，不預設買進價。",
          tone: "cautious",
        };
  const confidenceLabel = assessment?.confidence === "high"
    ? "高"
    : assessment?.confidence === "medium"
      ? "中"
      : assessment?.confidence === "low"
        ? "低"
        : "不適用";
  return (
    <Panel title="交易試算" eyebrow={`${symbol} · 投入金額與風險`} className="calculator-panel">
      <div className="calculator-intro"><Calculator size={18} /><span>盤中優先依近期可驗證的成交價判讀；盤後以最近官方收盤價檢查你輸入的買進價，作為下一交易日的條件參考。開盤後仍要用最新成交價重新核對。下方只做試算，不會替你買賣股票。</span></div>
      <div className="calculator-quote-reference" data-testid="text-calculator-current-quote">
        <span>{isOfficialCloseReference ? "最近官方收盤參考" : "盤中成交參考"}</span>
        <strong>{calculatorReferencePrice === null ? "—" : formatNumber(calculatorReferencePrice, 2)}</strong>
        <small>
          {isOfficialCloseReference && assessment
            ? `${formatDate(assessment.quoteAsOf)} 官方收盤價；盤後成交不作為 AI 判讀基準。`
            : `${priceBasis}；用來估算目前持有損益，不會自動填入買進價。`}
        </small>
      </div>
      {assessment && (
        <div className="ai-price-plan" data-testid="panel-ai-price-plan">
          <div className="ai-price-plan-head">
            <div>
              <strong>AI 進場策略與風控</strong>
              <p>{assessment.pricePlanMessage}</p>
            </div>
            {hasCompleteAiPricePlan && (
              <button
                type="button"
                className="ai-plan-apply"
                onClick={applyAiPricePlan}
                data-testid="button-apply-ai-price-plan"
              >
                套用至試算
              </button>
            )}
          </div>
          <div className="ai-trade-plan-fields" data-testid="panel-ai-trade-plan-fields">
            <section className="ai-trade-plan-field ai-trade-plan-range">
              <span>AI 建議買進價格區間</span>
              <strong>{suggestedEntryRange ?? "暫不提供有效買進區間"}</strong>
              <small>
                {validatedAiPlan
                  ? entryTierTwoPrice !== null
                    ? `T1 ${canUseAggressiveEntryTier ? "進取現價" : "AI 主要進場參考"} ${formatNumber(entryTierOnePrice!, 2)} 元 · T2 20 日低點觀察 ${formatNumber(entryTierTwoPrice, 2)} 元。兩者是不同情境，區間內價格不代表都適合買進。`
                    : `T1 ${canUseAggressiveEntryTier ? "進取現價" : "AI 主要進場參考"} ${formatNumber(entryTierOnePrice!, 2)} 元；目前沒有低於 AI 進場價的有效 20 日支撐參考，故不補造第二階買價。`
                  : "本次沒有通過完整價位檢查的買進方案；支撐觀察位不會代替買進建議。"}
              </small>
            </section>
            <section className="ai-trade-plan-field">
              <span>最佳進場策略</span>
              <strong>
                {validatedAiPlan
                  ? canUseAggressiveEntryTier
                    ? "動能偏強，可參考現價；條件轉弱或高於計畫價就不追"
                    : "等待回到 AI 進場參考附近，再確認條件後分批"
                  : assessment.actionText}
              </strong>
              {validatedAiPlan && <small>{validatedAiPlan.entryReason}</small>}
              <small className="ai-trade-plan-volume">
                量價參考：{volumePriceEvidence || "本次沒有足夠資料可列出成交量線索。"}
              </small>
            </section>
            {isOfficialCloseReference && (
              <section
                className={`ai-trade-plan-field ai-trade-plan-conclusion ${closeConclusion.tone}`}
                data-testid="panel-ai-close-conclusion"
              >
                <span>收盤後買進結論</span>
                <strong>{closeConclusion.label}</strong>
                <small>{closeConclusion.detail}</small>
              </section>
            )}
            <section className="ai-trade-plan-field">
              <span>核心防守價位</span>
              <strong>
                {validatedAiPlan
                  ? `停損 ${formatNumber(validatedAiPlan.stopLossPrice, 2)} 元 · 目標 ${formatNumber(validatedAiPlan.takeProfitPrice, 2)} 元`
                  : "停損與目標價暫不提供"}
              </strong>
              <small>
                {validatedAiPlan
                  ? `${validatedAiPlan.stopLossReason} ${validatedAiPlan.takeProfitReason}`
                  : "避免用未通過檢查的價位當作執行依據。"}
              </small>
            </section>
          </div>
          {hasCompleteAiPricePlan ? (
            <>
              <div className="ai-entry-confidence" data-testid="panel-ai-entry-confidence">
                <div className="ai-entry-confidence-heading">
                  <div>
                  <strong>AI 條件一致度</strong>
                  <small>分析線索是否一致，不是勝率</small>
                  </div>
                  <span className={`ai-entry-confidence-value ${assessment.confidence}`}>
                    {confidenceLabel}
                  </span>
                </div>
                {assessment.confidence !== "not_applicable" && (
                  <div
                    className={`ai-entry-confidence-scale ${assessment.confidence}`}
                    role="img"
                    aria-label={`AI 條件一致度：${confidenceLabel}`}
                  >
                    <span />
                    <span />
                    <span />
                  </div>
                )}
                <small className="ai-entry-confidence-note">
                  AI 價位是主觀估計，未經統計校準；20 日低點只是技術觀察，不代表買進訊號或保證獲利。
                </small>
              </div>
              <div className="ai-stop-discipline" data-testid="text-ai-stop-discipline">
                <div><TriangleAlert size={14} /><strong>先想好可承受的損失</strong></div>
                <p>
                  參考停損價為 <strong>{formatNumber(assessment.stopLossPrice, 2)} 元</strong>。
                  買進前先確認能承受多少損失；若價格到達停損位置，請依原先計畫處理。價格不保證能成交。
                </p>
              </div>
            </>
          ) : (
            <p className="ai-price-plan-empty">
              {isOfficialCloseReference
                ? "目前沒有完整且通過檢查的價位方案；收盤價不是下一交易日成交價，開盤後請用最新行情重新評估。"
                : "這次 AI 沒有提供買進價；不要把觀察價格或最新成交價當成買進建議。"}
            </p>
          )}
          {assessment.action !== "buy" &&
            assessment.actionReferencePrice !== null &&
            assessment.actionReferenceLabel &&
            assessment.actionReferenceReason && (
              <div className="ai-price-plan-reference" data-testid="panel-ai-reference-price">
               <span>AI 建議重新檢查的價格（不是買進價）</span>
                <strong>
                  {assessment.actionReferenceLabel} · {formatNumber(assessment.actionReferencePrice, 2)} 元
                </strong>
                <small>{assessment.actionReferenceReason}</small>
              </div>
            )}
        </div>
      )}
      <div className="form-grid">
        <label>預計買進價<input data-testid="input-buy-price" inputMode="decimal" value={buyPrice} onChange={(event) => { manuallyEditedPlan.current = true; buyPriceVerdictMutation.reset(); setBuyPrice(event.target.value); }} placeholder="等待 AI 預估，或手動輸入" /></label>
        <label>預計買進股數<input data-testid="input-buy-shares" type="number" min={1} step={1} inputMode="numeric" value={plannedShares} onChange={(event) => setPlannedShares(event.target.value)} placeholder="依預算試算後調整" /></label>
        <label>目標賣出價<input data-testid="input-target-price" inputMode="decimal" value={target} onChange={(event) => { manuallyEditedPlan.current = true; setTarget(event.target.value); }} placeholder="選填" /></label>
        <label>停損價（預計離場價）<input data-testid="input-stop-price" inputMode="decimal" value={stop} onChange={(event) => { manuallyEditedPlan.current = true; setStop(event.target.value); }} placeholder="選填" /></label>
        <label>單次投入上限（元）<input data-testid="input-investment-limit" type="number" min={1} step={1000} inputMode="decimal" value={investmentLimit} onChange={(event) => setInvestmentLimit(event.target.value)} placeholder="輸入你的預算上限" /><small>系統不會替你預設投入金額。</small></label>
      </div>
      <p className="calculator-input-guidance" data-testid="text-calculator-input-guidance">
        填入買進價與股數即可試算整筆金額及目標／停損損益；要依預算換算股數，請填入投入上限後套用股數上限。
      </p>
      <div
        className="budget-share-estimate"
        data-testid="panel-budget-share-estimate"
        aria-live="polite"
      >
        <div>
          <span>依預算最多可買</span>
          <strong>
            {budgetShareLimit === null
              ? "輸入預算與買進價"
              : budgetShareLimit === 0
                ? "預算不足 1 股"
                : `${formatNumber(budgetShareLimit, 0)} 股`}
          </strong>
          <small>
            {estimatedBudgetSpend === null
              ? "用你的預算上限和每股價格換算股數。"
              : `估計投入 ${accentCurrency} ${formatNumber(estimatedBudgetSpend, 0)}，含標準手續費估算。`}
          </small>
        </div>
        <button
          type="button"
          className="ai-plan-apply"
          onClick={applyBudgetShareLimit}
          disabled={budgetShareLimit === null || budgetShareLimit < 1}
          data-testid="button-apply-budget-share-limit"
        >
          套用股數上限
        </button>
      </div>
      <small className="budget-share-fee-note">
        股數只按你輸入的預算與價格換算，不代表 AI 建議買進。費用依 0.1425% 買進手續費估算，未含券商最低手續費或折扣；實際費用以券商下單頁為準。
      </small>
      <div className="buy-verdict-actions">
        <button
          type="button"
          className="ai-plan-apply"
          onClick={evaluateBuyPrice}
          disabled={!canEvaluateBuyPrice || buyPriceVerdictMutation.isPending}
          data-testid="button-evaluate-buy-price"
        >
          {buyPriceVerdictMutation.isPending
            ? <RefreshCw size={13} className="spin" />
            : <Sparkles size={13} />}
          AI 幫我檢查這個價格
        </button>
        <small>
          {buyPriceVerdictMutation.isPending
            ? "正在比對價格基準與 AI 分析；備用服務可能需要較長時間。"
            : isOfficialCloseReference
              ? "目前 AI 分析以官方收盤價為基準；送出後會優先採用新鮮、可驗證的盤中成交價，若無法取得則明確標示收盤參考。"
            : !assessment
              ? "等待個股 AI 分析完成後即可判斷。"
              : "送出你輸入的價位，盤中依近期可驗證成交、盤後依官方收盤價與 AI 分析判斷；不會送出交易。"}
        </small>
      </div>
      {isOfficialCloseReference && (
        <div
          className="buy-verdict-notice"
          role="status"
          data-testid="notice-buy-price-official-close"
        >
          <strong>盤後也可用官方收盤價檢查方案</strong>
          <p>
            收盤價只供下一交易日規劃參考，不是即時或可直接成交的價格。開盤後請用最新成交價重新核對；若盤中取得不到新鮮成交，結果會標明仍以收盤價為基準。
          </p>
        </div>
      )}
      {buyPriceVerdictMutation.isError &&
        (
        <div className="buy-verdict-error" role="alert" data-testid="error-buy-price-verdict">
          {parseAiRequestError(buyPriceVerdictMutation.error)}
          <AiProviderBadge provider={null} compact state="unavailable" />
        </div>
      )}
      {buyVerdictMismatchMessage && (
        <div
          className="buy-verdict-error"
          role="status"
          data-testid="notice-buy-verdict-mismatch"
        >
          {buyVerdictMismatchMessage}{" "}
          <button
            type="button"
            className="text-button"
            onClick={evaluateBuyPrice}
            disabled={!canEvaluateBuyPrice}
            data-testid="button-retry-buy-price-verdict"
          >
            重新檢查
          </button>
        </div>
      )}
      {!buyPriceVerdictMutation.isPending && matchingBuyVerdict && (
        <div
          className={`buy-verdict ${matchingBuyVerdict.verdict === "buy" ? "is-buy" : "is-no-buy"}`}
          data-testid="result-buy-price-verdict"
        >
          <div className="buy-verdict-heading">
            <div className="buy-verdict-meta">
              <span>AI 判斷此價位</span>
              <AiProviderBadge provider={matchingBuyVerdict.aiProvider} compact />
            </div>
            <strong>
              {matchingBuyVerdict.verdict === "buy"
                ? "可考慮買進（有條件）"
                : "不建議買進"}
            </strong>
          </div>
          <p>{matchingBuyVerdict.reason}</p>
          <small>
            預估買進 {formatNumber(matchingBuyVerdict.plannedBuyPrice, 2)} 元 ·
            本次估價基準 {formatNumber(matchingBuyVerdict.currentPrice, 2)} 元 ·
            報價 {formatTime(matchingBuyVerdict.quoteAsOf)} · AI 分析 {formatTime(matchingBuyVerdict.analyzedAt)}
          </small>
          {buyVerdictAnalysisDiffersFromDisplayed && (
            <small data-testid="notice-verdict-analysis-version">
              本次價格檢查使用的 AI 分析時間與頁面上方不同，請以本次檢查列出的時間為準。
            </small>
          )}
          <small>{matchingBuyVerdict.disclaimer}</small>
        </div>
      )}
      <div className="calc-results">
        <div><span>預估投入金額</span><strong>{budget === null ? "—" : `${accentCurrency} ${formatNumber(budget * (1 + TAIWAN_STOCK_BUY_COMMISSION_RATE), 0)}`}</strong><small>{budget === null ? !Number.isFinite(values.buy) || values.buy <= 0 ? "請輸入有效買進價" : plannedShares.trim() === "" ? "請輸入股數，或填入預算後套用股數上限" : !isValidPlannedShares ? "股數需為 1 股以上的整數" : "請確認買進價與股數" : `${formatNumber(values.plannedShares, 0)} 股，含標準手續費估算${budgetShareLimit !== null && values.plannedShares > budgetShareLimit ? "；超過預算股數上限" : ""}`}</small></div>
        <div><span>可能獲利差額</span><strong className={reward !== null ? "rising" : ""}>{reward === null ? "—" : `${formatNumber(reward, 2)} / 股`}</strong><small>{target ? "每股目標賣出價差，未扣費用" : "請輸入目標賣出價"}</small></div>
        <div><span>目標／停損價差比</span><strong className={rewardRisk !== null ? "signal" : ""}>{rewardRisk === null ? "—" : `${rewardRisk.toFixed(2)} : 1`}</strong><small>{risk === null ? "請設定目標賣出價與停損價" : `每股可能損失 ${formatNumber(risk, 2)} 元；價差比未計費用`}</small></div>
      </div>
      <div className="calc-results trade-simulation-results" data-testid="panel-trade-simulation">
        <div>
          <span>目標價賣出試算</span>
          <strong className={targetRoundTripEstimate ? targetRoundTripEstimate.estimatedProfitLossBeforeTax >= 0 ? "rising" : "falling" : ""}>
            {targetRoundTripEstimate
              ? `${targetRoundTripEstimate.estimatedProfitLossBeforeTax >= 0 ? "+" : ""}${accentCurrency} ${formatNumber(targetRoundTripEstimate.estimatedProfitLossBeforeTax, 0)}`
              : "輸入買進價、目標賣出價與股數"}
          </strong>
          <small>
            {targetRoundTripEstimate
              ? `${formatNumber(values.plannedShares, 0)} 股 · 賣出扣手續費估計收款 ${formatNumber(targetRoundTripEstimate.estimatedSellProceeds, 0)} 元 · 未扣證交稅`
              : "依你輸入的股數估算整筆損益"}
          </small>
        </div>
        <div>
          <span>停損價賣出試算</span>
          <strong className={stopRoundTripEstimate ? stopRoundTripEstimate.estimatedProfitLossBeforeTax >= 0 ? "rising" : "falling" : ""}>
            {stopRoundTripEstimate
              ? `${stopRoundTripEstimate.estimatedProfitLossBeforeTax >= 0 ? "+" : ""}${accentCurrency} ${formatNumber(stopRoundTripEstimate.estimatedProfitLossBeforeTax, 0)}`
              : "輸入買進價、停損價與股數"}
          </strong>
          <small>
            {stopRoundTripEstimate
              ? `${formatNumber(values.plannedShares, 0)} 股 · 賣出扣手續費估計收款 ${formatNumber(stopRoundTripEstimate.estimatedSellProceeds, 0)} 元 · 未扣證交稅`
              : "依你輸入的股數估算整筆損益"}
          </small>
        </div>
      </div>
      <div className="calc-divider" />
      <div className="optional-heading"><span>選填｜目前持有情形</span><span>輸入平均成本與持有股數</span></div>
      <div className="form-grid two">
        <label>持有成本<input data-testid="input-cost-basis" inputMode="decimal" value={costBasis} onChange={(event) => setCostBasis(event.target.value)} placeholder="平均成本" /></label>
        <label>持有股數（股）<input data-testid="input-shares" inputMode="numeric" value={shares} onChange={(event) => setShares(event.target.value)} placeholder="股數，如 1000" /><small>台股 1 張 = 1,000 股；持有 1 張請輸入 1000。</small></label>
      </div>
      <div className="position-assistant">
        <button type="button" className="ai-plan-apply" onClick={askPositionSuggestion} disabled={!canAskPosition || assistantMutation.isPending} data-testid="button-ask-position-ai">
          {assistantMutation.isPending ? <RefreshCw size={13} className="spin" /> : <Sparkles size={13} />}
          AI 幫我判斷持倉下一步
        </button>
        {!assessment
          ? <small>等待個股 AI 分析完成後即可詢問。</small>
          : !canAskPosition && <small>輸入有效的持有股數與平均成本後即可詢問。</small>}
        {assistantMutation.isPending && <AiProviderBadge provider={null} compact state="loading" />}
        {assistantMutation.isError && <AiProviderBadge provider={null} compact state="unavailable" />}
      </div>
      {assistantMutation.isPending && <div className="position-ai-state" role="status" data-testid="status-position-ai-loading"><SkeletonBlock className="h-12" /><span>正在整理行情並嘗試 Gemini；若無法回覆，會依序切換 OpenRouter Free、Groq Free 等備援模型，最長等待約 75 秒。</span></div>}
      {assistantMutation.isError && <div className="position-ai-error" role="alert" data-testid="error-position-ai">{parseAiRequestError(assistantMutation.error)} <button type="button" className="text-button" onClick={askPositionSuggestion} data-testid="button-retry-position-ai">重試</button></div>}
      {assistantMutation.data?.symbol.replace(/\.(TW|TWO)$/i, "") === normalizedSymbol && !assistantMutation.isPending && !assistantMutation.isError && (
        <section className="position-ai-reply" data-testid="panel-position-ai-reply">
          <div className="position-ai-reply-head">
            <strong>持倉操作建議</strong>
            <AiProviderBadge provider={assistantMutation.data.aiProvider} compact />
          </div>
          <strong className="position-ai-action" data-testid="text-position-ai-action">
            {positionActionLabels[assistantMutation.data.positionAction] ?? "資料不足，先不加碼"}
          </strong>
          <p className="position-ai-answer">{assistantMutation.data.answer}</p>
          <div className="position-ai-context">
            <strong>參考資料</strong>
            {assistantMutation.data.citedFacts.length ? <ul>{assistantMutation.data.citedFacts.map((fact, index) => <li key={`${index}-${fact}`}>{fact}</li>)}</ul> : <p>回覆未列出可引用事實。</p>}
            <strong>資料來源與日期</strong>
            <p>個股價格 {formatTime(assistantMutation.data.context.quoteAsOf)} · AI 分析 {formatTime(assistantMutation.data.context.analysisAsOf)} · 大盤 {formatTime(assistantMutation.data.context.marketAsOf)}</p>
            <p>{assistantMutation.data.context.sources.join(" · ") || "未回傳來源清單"}</p>
            <small>股價資料：{assistantMutation.data.context.coverage.technical === "available" ? "有" : "未提供"} · 大盤資料：{assistantMutation.data.context.coverage.market === "available" ? "有" : "未提供"} · 財報：{assistantMutation.data.context.coverage.fundamentals === "available" ? "有" : "未提供"} · 大型投資人買賣：{assistantMutation.data.context.coverage.institutional === "available" ? "有" : "未提供"}</small>
          </div>
          <small>{assistantMutation.data.disclaimer}</small>
          <small>這是資料整理與情境參考，不會替你交易，也不是個人化投資建議。</small>
        </section>
      )}
      <div className={`pl-result ${unrealized === null ? "muted" : unrealized >= 0 ? "rising" : "falling"}`}>
        <span>目前持有損益估算</span><strong>{unrealized === null ? "—" : `${unrealized >= 0 ? "+" : ""}${accentCurrency} ${formatNumber(unrealized, 0)}`}</strong><small>{unrealized === null ? "請輸入平均成本與持有股數" : `依${priceBasis} ${formatNumber(latestPrice, 2)} 試算`}</small>
      </div>
      <div className="risk-caveat"><TriangleAlert size={14} /><span>出場情境已按買賣雙邊各 0.1425% 估算手續費，但未計證交稅、券商最低手續費或折扣；目前持有損益未扣費用。實際成交可能因滑價或跳空不同，停損價不保證能成交。試算不是投資建議。</span></div>
      {atr !== null && <div className="atr-hint"><Target size={14} /> 近 14 個交易日平均每日波動：<strong>{formatNumber(atr, 2)}</strong> 元。這不是停損價或目標價。</div>}
    </Panel>
  );
}

function StockSnapshot({ bars, symbol, currency, source, asOf, quote }: { bars: Bar[]; symbol: string; currency: string | null; source: string; asOf: string; quote?: StockQuote }) {
  const latest = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const closes = bars.map((bar) => bar.close);
  const ma20 = calculateAverage(bars, 20).at(-1) ?? null;
  const ma60 = calculateAverage(bars, 60).at(-1) ?? null;
  const ma120 = calculateAverage(bars, 120).at(-1) ?? null;
  const rsi = calculateRsi(bars);
  const atr = calculateAtr(bars);
  const recent = bars.slice(-20);
  const support = recent.length ? Math.min(...recent.map((bar) => bar.low)) : null;
  const resistance = recent.length ? Math.max(...recent.map((bar) => bar.high)) : null;
  const historicalChange = latest && previous ? latest.close - previous.close : null;
  const historicalChangePercent = latest && previous && historicalChange !== null ? (historicalChange / previous.close) * 100 : null;
  const currentPrice = quote?.available && quote.price !== null ? quote.price : latest?.close ?? null;
  const dayChange = quote?.available ? quote.change : historicalChange;
  const dayChangePercent = quote?.available ? quote.changePercent : historicalChangePercent;
  const trend = ma20 !== null && ma60 !== null ? (ma20 > ma60 ? "近期較強" : "近期較弱") : "資料不足";
  const insufficient = bars.length < 20;
  return {
    latest, closes, ma20, ma60, ma120, rsi, atr, support, resistance, dayChange, dayChangePercent, currentPrice, quote, trend, insufficient, currency, symbol, source, asOf,
  };
}

function normalizeTaiwanStockSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.(?:TW|TWO)$/, "");
}

function Dashboard() {
  const [, setLocation] = useLocation();
  const [symbolInput, setSymbolInput] = useState(readSelectedSymbol);
  const [selectedSymbol, setSelectedSymbol] = useState(readSelectedSymbol);
  const [stockSuggestionsOpen, setStockSuggestionsOpen] = useState(false);
  const {
    entries: watchlist,
    setEntries: setWatchlist,
    isSignedIn,
    canEdit: watchlistCanEdit,
    isSaving: watchlistSaving,
    isRefreshing: watchlistRefreshing,
    retryProfile,
    accountError,
    saveError,
    maxWatchlistItems,
  } = useAccountWatchlist();
  const [range, setRange] = useState<Range>("6mo");
  const [marketRange, setMarketRange] = useState<Range>("6mo");
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      const savedTheme = window.localStorage.getItem("tw-stock-dashboard-theme");
      if (savedTheme) return savedTheme === "dark";
    } catch {
      // Keep the in-memory toggle available when browser storage is disabled.
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(5 * 60 * 1000);
  const [refreshMenu, setRefreshMenu] = useState(false);
  const [isSpinning, setIsSpinning] = useState(false);
  const refreshRef = useRef<HTMLDivElement>(null);
  const initialCardLayout = useMemo(readCardLayout, []);
  const [cardOrder, setCardOrder] = useState<CardId[]>(initialCardLayout.order);
  const [collapsedCards, setCollapsedCards] = useState<Partial<Record<CardId, boolean>>>(initialCardLayout.collapsed);

  useEffect(() => {
    try {
      window.localStorage.setItem(CARD_ORDER_STORAGE_KEY, JSON.stringify({ version: CARD_LAYOUT_VERSION, order: cardOrder, collapsed: collapsedCards }));
    } catch {
      // The workspace remains usable for this session when storage is unavailable.
    }
  }, [cardOrder, collapsedCards]);

  const toggleCard = (cardId: CardId) => {
    setCollapsedCards((current) => ({ ...current, [cardId]: !current[cardId] }));
  };

  const restoreCard = (cardId: CardId) => {
    const parentCardId =
      cardId === "market-summary" || cardId === "market-history" || cardId === "futures-strategy"
        ? "market-analysis"
        : cardId === "stock-metrics" ||
            cardId === "research-data" ||
            cardId === "ai-assessment" ||
            cardId === "price-chart" ||
            cardId === "volume-chart" ||
            cardId === "technical-ledger"
          ? "stock-analysis"
          : null;
    setCollapsedCards((current) => ({
      ...current,
      [cardId]: false,
      ...(parentCardId ? { [parentCardId]: false } : {}),
      ...(cardId === "market-analysis" &&
      ["market-summary", "market-history", "futures-strategy"].every(
        (childCardId) => current[childCardId as CardId] === true,
      )
        ? {
            "market-summary": false,
            "market-history": false,
            "futures-strategy": false,
          }
        : {}),
    }));
  };

  const updateScopedCardOrder = (scope: CardId[], scopedOrder: string[]) => {
    setCardOrder((current) => {
      let nextIndex = 0;
      return current.map((cardId) =>
        scope.includes(cardId)
          ? (scopedOrder[nextIndex++] as CardId)
          : cardId,
      );
    });
  };

  const renderWorkspaceCard = (
    cardId: CardId,
    title: string,
    scope: CardId[],
    children: ReactNode,
    toolbarAction?: ReactNode,
  ) => {
    return (
      <WorkspaceCard
        key={cardId}
        cardId={cardId}
        title={title}
        toolbarAction={toolbarAction}
        scope={scope}
        collapsed={collapsedCards[cardId] === true}
        onToggle={() => toggleCard(cardId)}
      >
        {children}
      </WorkspaceCard>
    );
  };

  const overviewQuery = useGetMarketOverview({
    query: {
      queryKey: ["/api/market/overview"],
      staleTime: 0,
      refetchInterval: LIVE_MARKET_INTERVAL_MS,
      refetchIntervalInBackground: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  });
  const futuresDayStrategyQuery = useGetFuturesAiDayStrategy({
    query: {
      enabled: isSignedIn,
      queryKey: ["/api/futures/ai-day-strategy"],
      staleTime: 60_000,
      refetchInterval: 3 * 60_000,
      refetchIntervalInBackground: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      retry: false,
    },
  });
  const summaryQuery = useGetMarketSummary({
    query: {
      enabled: isSignedIn,
      queryKey: ["/api/market/summary"],
      staleTime: 0,
      refetchInterval: MARKET_SUMMARY_INTERVAL_MS,
      refetchIntervalInBackground: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  });
  const [dashboardIntroDismissed, setDashboardIntroDismissed] = useState(false);
  const [isPremarketSummaryHours, setIsPremarketSummaryHours] = useState(isTaipeiPremarketSummaryHours);
  const [isClosingSummaryHours, setIsClosingSummaryHours] = useState(isTaipeiClosingSummaryHours);
  useEffect(() => {
    const updateWindow = () => {
      setIsPremarketSummaryHours(isTaipeiPremarketSummaryHours());
      setIsClosingSummaryHours(isTaipeiClosingSummaryHours());
    };
    updateWindow();
    const timer = window.setInterval(updateWindow, 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const dailySummaryMode: MarketDailySummaryMode = isClosingSummaryHours ? "closing" : "premarket";
  const marketAiDailySummaryQuery = useGetMarketAiDailySummary(
    { mode: dailySummaryMode },
    {
      query: {
      enabled: isSignedIn && (isPremarketSummaryHours || isClosingSummaryHours),
      queryKey: ["/api/market/ai-daily-summary", dailySummaryMode],
      queryFn: ({ signal }) => getMarketAiDailySummary(
        { mode: dailySummaryMode },
        { signal },
      ),
      staleTime: 30 * 60_000,
      refetchInterval: 30 * 60_000,
      refetchIntervalInBackground: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      retry: false,
      },
    },
  );
  const marketIntradayQuery = useGetMarketIntraday({
    query: {
      queryKey: ["/api/market/intraday"],
      staleTime: 10_000,
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      retry: false,
    },
  });
  const marketHistoryQuery = useGetMarketHistory({ range: marketRange });
  const stockCatalogQuery = useGetStockCatalog({
    query: {
      queryKey: ["/api/stocks/catalog"],
      enabled: isSignedIn,
      staleTime: 6 * 60 * 60 * 1000,
        retry: 1,
        retryDelay: 1_000,
    },
  });
  const stockCatalogSuggestions = useMemo(() => {
    const search = symbolInput.trim().toLocaleLowerCase();
    if (!search) return [];
    return (stockCatalogQuery.data?.instruments ?? [])
      .filter((instrument) =>
        [instrument.symbol, instrument.ticker, instrument.name].some((value) =>
          value.toLocaleLowerCase().includes(search),
        ),
      )
      .slice(0, 8);
  }, [stockCatalogQuery.data?.instruments, symbolInput]);
  const stockCatalogCodePrefixMatches = useMemo(() => {
    const search = symbolInput.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(search)) return [];
    return (stockCatalogQuery.data?.instruments ?? []).filter((instrument) =>
      instrument.symbol.toUpperCase().startsWith(search),
    );
  }, [stockCatalogQuery.data?.instruments, symbolInput]);
  const stockHistoryQuery = useGetStockHistory(
    { symbol: selectedSymbol, range },
    {
      query: {
        queryKey: [
          "/api/stocks/history",
          { symbol: selectedSymbol, range },
        ],
        enabled: isSignedIn,
        staleTime: 0,
        refetchInterval: LIVE_QUOTE_INTERVAL_MS,
        refetchIntervalInBackground: false,
        refetchOnMount: "always",
        refetchOnWindowFocus: "always",
      },
    },
  );
  const researchParams = {
    symbol: selectedSymbol.replace(/\.(TW|TWO)$/i, ""),
    ...(stockHistoryQuery.data?.ticker
      ? { ticker: stockHistoryQuery.data.ticker }
      : {}),
  };
  const stockResearchDataQuery = useGetStockResearchData(researchParams, {
    query: {
      queryKey: ["/api/stocks/research-data", researchParams],
      enabled: isSignedIn,
      staleTime: 30 * 60 * 1000,
      retry: false,
    },
  });
  const stockAiAssessmentQuery = useGetStockAiAssessment(
    { symbol: selectedSymbol },
    {
      query: {
        retry: false,
        queryKey: ["/api/stocks/ai-assessment", { symbol: selectedSymbol }] as const,
        enabled: isSignedIn,
        staleTime: 60_000,
      },
    },
  );
  const rawStockAiAssessment = stockAiAssessmentQuery.data;
  const taiwanStockSessionOpen = isTaiwanStockSessionOpen();
  const latestStockQuote = stockHistoryQuery.data?.quote;
  const latestStockQuoteAgeMs = latestStockQuote?.asOf
    ? Date.now() - Date.parse(latestStockQuote.asOf)
    : Number.POSITIVE_INFINITY;
  const hasFreshIntradayStockQuote = Boolean(
    latestStockQuote?.available &&
      latestStockQuote.price !== null &&
      latestStockQuote.asOf &&
      (latestStockQuote.source.includes("成交時間") ||
        latestStockQuote.source.includes("報價更新時間")) &&
      !latestStockQuote.source.includes("盤後最後成交") &&
      latestStockQuoteAgeMs >= -60_000 &&
      latestStockQuoteAgeMs <= 90_000,
  );
  const aiAssessmentQuoteAgeMs = rawStockAiAssessment?.quoteAsOf
    ? Date.now() - Date.parse(rawStockAiAssessment.quoteAsOf)
    : Number.POSITIVE_INFINITY;
  const aiAssessmentNeedsLiveQuote = Boolean(
    taiwanStockSessionOpen &&
      rawStockAiAssessment &&
      (rawStockAiAssessment.referenceType !== "verified_trade" ||
        !Number.isFinite(aiAssessmentQuoteAgeMs) ||
        aiAssessmentQuoteAgeMs < -60_000 ||
        aiAssessmentQuoteAgeMs > 90_000),
  );
  const visibleStockAiAssessment =
    rawStockAiAssessment &&
    normalizeTaiwanStockSymbol(rawStockAiAssessment.symbol) ===
      normalizeTaiwanStockSymbol(selectedSymbol)
      && !aiAssessmentNeedsLiveQuote
      ? rawStockAiAssessment
      : undefined;
  const automaticAiRefreshTimes = useRef(new Map<string, number>());
  const [isRefreshingAiForLiveQuote, setIsRefreshingAiForLiveQuote] =
    useState(false);

  useEffect(() => {
    if (
      !isSignedIn ||
      !taiwanStockSessionOpen ||
      !hasFreshIntradayStockQuote ||
      !(
        aiAssessmentNeedsLiveQuote ||
        (!rawStockAiAssessment && stockAiAssessmentQuery.isError)
      ) ||
      stockAiAssessmentQuery.isFetching
    ) {
      return;
    }

    const now = Date.now();
    const lastRefreshAt =
      automaticAiRefreshTimes.current.get(selectedSymbol) ?? 0;
    if (now - lastRefreshAt < 60_000) return;

    automaticAiRefreshTimes.current.set(selectedSymbol, now);
    if (automaticAiRefreshTimes.current.size > 100) {
      const oldestSymbol = automaticAiRefreshTimes.current.keys().next().value;
      if (oldestSymbol) automaticAiRefreshTimes.current.delete(oldestSymbol);
    }

    setIsRefreshingAiForLiveQuote(true);
    void stockAiAssessmentQuery.refetch().finally(() => {
      setIsRefreshingAiForLiveQuote(false);
    });
  }, [
    aiAssessmentNeedsLiveQuote,
    hasFreshIntradayStockQuote,
    isSignedIn,
    rawStockAiAssessment,
    selectedSymbol,
    stockAiAssessmentQuery.isError,
    stockAiAssessmentQuery.isFetching,
    stockAiAssessmentQuery.refetch,
    stockHistoryQuery.dataUpdatedAt,
    taiwanStockSessionOpen,
  ]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    try {
      window.localStorage.setItem("tw-stock-dashboard-theme", isDark ? "dark" : "light");
    } catch {
      // Theme changes still work for the current session without local storage.
    }
  }, [isDark]);

  useEffect(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const showAll = () => targets.forEach((target) => target.classList.add("is-visible"));
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      typeof IntersectionObserver === "undefined"
    ) {
      showAll();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -32px 0px" },
    );
    targets
      .filter((target) => !target.classList.contains("is-visible"))
      .forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [
    overviewQuery.data,
    summaryQuery.data,
    marketIntradayQuery.data,
    marketHistoryQuery.data,
    stockHistoryQuery.data,
    stockResearchDataQuery.data,
    stockAiAssessmentQuery.data,
    collapsedCards,
    cardOrder,
  ]);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (refreshRef.current && !refreshRef.current.contains(event.target as Node)) setRefreshMenu(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, []);

  useEffect(() => {
    if (!autoRefresh || !isSignedIn) return undefined;
    const timer = window.setInterval(() => {
      void Promise.all([overviewQuery.refetch(), summaryQuery.refetch(), marketIntradayQuery.refetch(), marketHistoryQuery.refetch(), stockHistoryQuery.refetch()]);
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [autoRefresh, isSignedIn, refreshInterval, marketIntradayQuery.refetch, marketHistoryQuery.refetch, overviewQuery.refetch, stockHistoryQuery.refetch, summaryQuery.refetch]);

  const fetching = overviewQuery.isFetching || summaryQuery.isFetching || marketIntradayQuery.isFetching || marketHistoryQuery.isFetching || stockHistoryQuery.isFetching || stockAiAssessmentQuery.isFetching;
  const stockBars = stockHistoryQuery.data?.bars ?? [];
  const marketBars = marketHistoryQuery.data?.bars ?? [];
  const stock = useMemo(() => stockBars.length ? StockSnapshot({
    bars: stockBars,
    symbol: stockHistoryQuery.data?.ticker ?? selectedSymbol,
    currency: stockHistoryQuery.data?.currency ?? "TWD",
    source: stockHistoryQuery.data?.source ?? "交易所資料",
    asOf: stockHistoryQuery.data?.asOf ?? "",
    quote: stockHistoryQuery.data?.quote,
  }) : null, [stockBars, stockHistoryQuery.data, selectedSymbol]);

  const handleRefresh = async () => {
    setIsSpinning(true);
    await Promise.all([overviewQuery.refetch(), summaryQuery.refetch(), marketIntradayQuery.refetch(), marketHistoryQuery.refetch(), stockHistoryQuery.refetch(), stockResearchDataQuery.refetch(), stockAiAssessmentQuery.refetch()]);
    window.setTimeout(() => setIsSpinning(false), 650);
  };

  const applySymbol = (event: FormEvent) => {
    event.preventDefault();
    const query = symbolInput.trim();
    const exactMatch = (stockCatalogQuery.data?.instruments ?? []).find(
      (instrument) =>
        instrument.symbol.toLocaleLowerCase() === query.toLocaleLowerCase() ||
        instrument.ticker.toLocaleLowerCase() === query.toLocaleLowerCase() ||
        instrument.name.toLocaleLowerCase() === query.toLocaleLowerCase(),
    );
    const uniqueCodePrefixMatch =
      stockCatalogCodePrefixMatches.length === 1
        ? stockCatalogCodePrefixMatches[0]
        : undefined;
    const nameMatch =
      !/^[A-Z0-9.^=-]+$/i.test(query) ? stockCatalogSuggestions[0] : undefined;
    const match = exactMatch ?? uniqueCodePrefixMatch ?? nameMatch;
    if (match) {
      setSelectedSymbol(match.ticker);
      setSymbolInput(match.symbol);
      storeSelectedSymbol(match.ticker);
      setStockSuggestionsOpen(false);
      return;
    }
    if (stockCatalogCodePrefixMatches.length > 1) {
      setStockSuggestionsOpen(true);
      return;
    }

    const cleaned = query.toUpperCase().replace(/[^A-Z0-9.^=-]/g, "");
    if (cleaned) {
      setSelectedSymbol(cleaned);
      setSymbolInput(cleaned);
      storeSelectedSymbol(cleaned);
    }
    setStockSuggestionsOpen(false);
  };
  const normalizedSelected = selectedSymbol.replace(/\.(TW|TWO)$/i, "");
  const isSaved = watchlist.some((entry) => entry.symbol.replace(/\.(TW|TWO)$/i, "") === normalizedSelected);
  const canSaveSelected = /^[A-Z0-9]{2,6}(?:\.(?:TW|TWO))?$/.test(selectedSymbol.toUpperCase());
  const toggleWatchlist = () => {
    if (!watchlistCanEdit || watchlistSaving) return;
    if (!isSaved && (watchlist.length >= maxWatchlistItems || !canSaveSelected)) return;
    const next = isSaved
      ? watchlist.filter((entry) => entry.symbol.replace(/\.(TW|TWO)$/i, "") !== normalizedSelected)
      : [...watchlist, { symbol: selectedSymbol, name: stockHistoryQuery.data?.quote.name ?? selectedSymbol }];
    setWatchlist(next);
  };

  const lastUpdated = overviewQuery.data?.asOf ?? null;
  const darkGrid = isDark;
  const marketChartRows = marketBars.map((bar) => ({ date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }));
  const stockError = stockHistoryQuery.isError && !stockHistoryQuery.data ? parseError(stockHistoryQuery.error) : null;
  const dashboardSectionScope: CardId[] = ["stock-search", "market-index", "market-intraday", "market-analysis", "stock-analysis"];
  const marketCardScope: CardId[] = ["market-summary", "market-history", "futures-strategy"];
  const marketSummaryCollapsed = collapsedCards["market-summary"] === true;
  const allMarketCardsCollapsed = marketCardScope.every(
    (cardId) => collapsedCards[cardId] === true,
  );
  const stockCardScope: CardId[] = ["stock-metrics", "research-data", "ai-assessment", "price-chart", "volume-chart", "technical-ledger"];
  const collapsedCardIds = cardOrder.filter(
    (cardId) =>
      collapsedCards[cardId] === true &&
      (cardId === "stock-analysis" || CARD_DOCK_TITLES[cardId] !== undefined),
  );

  if (!isSignedIn) {
    return (
      <div className="app-shell terminal-grid public-market-shell" data-testid="view-public-market">
        <PageNavigation active="dashboard" />
        <header className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark"><Activity size={17} /></div>
            <div>
              <div className="brand-name">台股市場觀測</div>
              <div className="brand-sub">公開大盤行情</div>
            </div>
          </div>
          <div className="topbar-actions print-hidden">
            <button
              type="button"
              className="control-icon"
              onClick={() => setIsDark((dark) => !dark)}
              aria-label={isDark ? "切換淺色模式" : "切換深色模式"}
              data-testid="button-public-theme-toggle"
            >
              {isDark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </header>

        <main className="dashboard-main public-market-main">
          <section className="public-market-welcome">
            <div>
              <p className="section-eyebrow">PUBLIC MARKET VIEW / 01</p>
              <h1 data-testid="text-public-market-title">先看大盤，再進一步分析。</h1>
              <p className="lede">訪客可查看大盤數字；登入後開啟個股分析、自選清單與交易試算。</p>
            </div>
            <Link href="/sign-in" className="public-market-sign-in" data-testid="link-public-market-sign-in">
              <LogIn size={16} />
              登入查看完整分析
            </Link>
          </section>

          <section className="public-market-index-card glass-panel" aria-labelledby="public-market-index-title" data-testid="panel-public-market-indices">
            <div className="public-market-index-heading">
              <div>
                <p className="section-eyebrow">MARKET INDICES / 01</p>
                <h2 id="public-market-index-title">大盤數字</h2>
              </div>
              <span>加權指數與臺指期 · 僅供行情參考</span>
            </div>
            <MarketStrip
              overview={overviewQuery.data}
              lastClose={marketHistoryQuery.data?.bars.at(-1)?.close}
              previousClose={marketHistoryQuery.data?.bars.at(-2)?.close}
              closeSource={marketHistoryQuery.data?.source}
              closeAsOf={marketHistoryQuery.data?.asOf}
              updatedAt={overviewQuery.dataUpdatedAt}
              loading={overviewQuery.isLoading}
              error={overviewQuery.isError && !overviewQuery.data ? overviewQuery.error : null}
              onRetry={() => {
                void overviewQuery.refetch();
                void marketHistoryQuery.refetch();
              }}
            />
          </section>

          <footer className="public-market-footer">
            <span>市場行情來自公開資料來源，實際交易請以券商報價為準。</span>
            <span>登入後可查看個股研究與私人自選清單。</span>
          </footer>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell terminal-grid">
      <PageNavigation active="dashboard" />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Activity size={17} /></div>
          <div><div className="brand-name">台股走勢與個股分析</div><div className="brand-sub">台股資料與分析工具</div></div>
        </div>
        <div className="topbar-actions print-hidden">
          <div className="refresh-group" ref={refreshRef}>
            <button type="button" className="refresh-main" onClick={() => void handleRefresh()} disabled={fetching} data-testid="button-refresh-data">
              <RefreshCw size={14} className={isSpinning || fetching ? "spin" : ""} /> 重新整理
            </button>
            <button type="button" className="refresh-chevron" onClick={() => setRefreshMenu((open) => !open)} aria-label="重新整理設定" data-testid="button-refresh-settings"><ChevronDown size={14} /></button>
            {refreshMenu && (
              <div className="refresh-menu">
                <div className="refresh-menu-title">自動更新</div>
                <label className="switch-row"><span>啟用定時更新</span><input data-testid="switch-auto-refresh" type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /><span className="switch-track"><span /></span></label>
                <div className="refresh-menu-title interval-title">更新間隔</div>
                {[{ label: "每 5 分鐘", value: 5 * 60 * 1000 }, { label: "每 15 分鐘", value: 15 * 60 * 1000 }, { label: "每小時", value: 60 * 60 * 1000 }].map((option) => (
                  <button type="button" key={option.value} className={`interval-option ${refreshInterval === option.value ? "selected" : ""}`} onClick={() => { setRefreshInterval(option.value); setAutoRefresh(true); setRefreshMenu(false); }} data-testid={`button-refresh-${option.value}`}>
                    <span>{option.label}</span>{refreshInterval === option.value && <Check size={14} />}
                  </button>
                ))}
                <p className="refresh-note">大盤每秒、個股每 5 秒查詢；數值只在來源有新成交時更新。</p>
              </div>
            )}
          </div>
          <ButtonIcon label="列印或匯出 PDF" onClick={openDashboardPrintDialog}><Printer size={15} /></ButtonIcon>
          <ButtonIcon label={isDark ? "切換淺色模式" : "切換深色模式"} onClick={() => setIsDark((dark) => !dark)}><span>{isDark ? <Sun size={15} /> : <Moon size={15} />}</span></ButtonIcon>
        </div>
      </header>

      <main className="dashboard-main">
        <div className={`headline-row${collapsedCardIds.length ? " has-collapsed-cards" : ""}`} data-reveal>
          <div className="headline-copy">
            <p className="section-eyebrow">台股分析 / 01</p>
            <DashboardLoginIntro onDismiss={() => setDashboardIntroDismissed(true)} />
            <div className="freshness-row">
              <span className="freshness-dot" /> <span data-testid="text-last-refresh">最近行情時間 {lastUpdated ? formatTime(lastUpdated) : "等待來源時間"}</span>
              <span className="source-badge">證交所與櫃買中心行情</span>
              <span className="source-badge muted-badge">公開財報與投資人每日買賣資料</span>
            </div>
          </div>
          {collapsedCardIds.length > 0 && (
            <aside className="collapsed-card-dock" aria-label="已收起的功能卡片">
              <div className="collapsed-card-dock-heading">
                <strong>已收起</strong>
                <span>點選標題即可展開</span>
              </div>
              <div className="collapsed-card-dock-list">
                {collapsedCardIds.map((cardId) => {
                  const title =
                    cardId === "stock-analysis"
                      ? `${selectedSymbol} 個股走勢`
                      : CARD_DOCK_TITLES[cardId] ?? cardId;
                  return (
                    <button
                      key={cardId}
                      type="button"
                      className="collapsed-card-button"
                      onClick={() => restoreCard(cardId)}
                      aria-label={`展開「${title}」`}
                      title={`展開「${title}」`}
                      data-testid={`button-restore-card-${cardId}`}
                    >
                      <span>{title}</span>
                      <ChevronDown size={13} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
        {dashboardIntroDismissed && (isPremarketSummaryHours || isClosingSummaryHours) && (
          <MarketPremarketSummaryCard
            summary={marketAiDailySummaryQuery.data}
            loading={marketAiDailySummaryQuery.isLoading}
            error={marketAiDailySummaryQuery.isError && !marketAiDailySummaryQuery.data ? marketAiDailySummaryQuery.error : null}
            onRetry={() => void marketAiDailySummaryQuery.refetch()}
            mode={dailySummaryMode}
          />
        )}

        <CardOrderWorkspace
          storageKey={`${CARD_ORDER_STORAGE_KEY}:dashboard`}
          cardIds={dashboardSectionScope}
          order={cardOrder.filter((id) => dashboardSectionScope.includes(id))}
          onOrderChange={(order) => updateScopedCardOrder(dashboardSectionScope, order)}
          className="dashboard-workspace"
        >
          {renderWorkspaceCard("stock-search", "個股搜尋與報價", dashboardSectionScope, (
            <div className="search-quote-stack">
              <form
                className="symbol-search"
                onSubmit={applySymbol}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setStockSuggestionsOpen(false);
                  }
                }}
              >
                <label htmlFor="symbol-input">股票或 ETF（指數型基金）代碼或名稱</label>
                <div className="symbol-search-control">
                  <div className="search-input-wrap">
                    <Search size={16} />
                    <input
                      id="symbol-input"
                      data-testid="input-symbol-search"
                      value={symbolInput}
                      onFocus={() => setStockSuggestionsOpen(Boolean(symbolInput.trim()))}
                      onChange={(event) => {
                        setSymbolInput(event.target.value);
                        setStockSuggestionsOpen(true);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setStockSuggestionsOpen(false);
                      }}
                      placeholder="輸入代碼或名稱，例如 2330、台積電"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={stockSuggestionsOpen && Boolean(symbolInput.trim())}
                      aria-controls="stock-catalog-suggestions"
                      autoComplete="off"
                    />
                    <button type="submit" data-testid="button-search-symbol">查詢</button>
                  </div>
                  {stockSuggestionsOpen && symbolInput.trim() && (
                    <div
                      id="stock-catalog-suggestions"
                      className="stock-catalog-suggestions"
                      role="listbox"
                      aria-label="官方上市櫃證券搜尋結果"
                    >
                      {stockCatalogQuery.isLoading ? (
                        <div className="stock-catalog-message" role="status">正在載入官方證券清單…</div>
                      ) : stockCatalogQuery.isError ? (
                        <div className="stock-catalog-message" role="status">
                          官方證券清單暫時無法載入；仍可直接輸入代號查詢。
                          <button type="button" onClick={() => void stockCatalogQuery.refetch()}>重試</button>
                        </div>
                      ) : stockCatalogSuggestions.length ? (
                        <>
                        {stockCatalogCodePrefixMatches.length > 1 && (
                          <div className="stock-catalog-message" role="status">
                            這個代號前綴有多個結果，請選擇完整代號。
                          </div>
                        )}
                        {stockCatalogSuggestions.map((instrument) => (
                          <button
                            key={instrument.ticker}
                            type="button"
                            role="option"
                            aria-selected={instrument.ticker === selectedSymbol}
                            className="stock-catalog-option"
                            data-testid={`option-stock-${instrument.ticker}`}
                            onClick={() => {
                              setSelectedSymbol(instrument.ticker);
                              setSymbolInput(instrument.symbol);
                              storeSelectedSymbol(instrument.ticker);
                              setStockSuggestionsOpen(false);
                            }}
                          >
                            <span className="stock-catalog-option-main">
                              <strong>{instrument.symbol}</strong>
                              <span>{instrument.name}</span>
                            </span>
                            <span className="stock-catalog-exchange">{instrument.exchangeName}</span>
                          </button>
                        ))}
                        </>
                      ) : (
                        <div className="stock-catalog-message" role="status">
                          沒有符合的上市／上櫃證券。下市或下櫃代號不在目前清單中；也可直接查詢代號。
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <span>
                  依 TWSE 與 TPEx 官方清單搜尋；資料日 {stockCatalogQuery.data?.asOf ?? "載入後顯示"}。
                  下市、下櫃或沒有官方日線的代號會明確顯示無資料。
                </span>
              </form>
              <StockQuoteCard
                symbol={selectedSymbol}
                quote={stockHistoryQuery.data?.quote}
                lastClose={stockHistoryQuery.data?.bars.at(-1)}
                lastCloseSource={stockHistoryQuery.data?.source}
                loading={stockHistoryQuery.isLoading}
                fetching={stockHistoryQuery.isFetching}
                error={stockHistoryQuery.isError ? stockHistoryQuery.error : null}
                onRetry={() => void stockHistoryQuery.refetch()}
                canToggleWatchlist={stock !== null && !stockError}
                isSaved={isSaved}
                watchlistDisabled={
                  !watchlistCanEdit ||
                  watchlistSaving ||
                  (!isSaved && (!canSaveSelected || watchlist.length >= maxWatchlistItems))
                }
                watchlistSaving={watchlistSaving}
                isSignedIn={isSignedIn}
                onToggleWatchlist={toggleWatchlist}
              />
            </div>
          ))}

          {renderWorkspaceCard("market-index", "加權指數與市場行情", dashboardSectionScope, (
            <div className="market-index-workspace-content">
              <MarketStrip
                overview={overviewQuery.data}
                lastClose={marketHistoryQuery.data?.bars.at(-1)?.close}
                previousClose={marketHistoryQuery.data?.bars.at(-2)?.close}
                closeSource={marketHistoryQuery.data?.source}
                closeAsOf={marketHistoryQuery.data?.asOf}
                updatedAt={overviewQuery.dataUpdatedAt}
                loading={overviewQuery.isLoading}
                error={overviewQuery.isError && !overviewQuery.data ? overviewQuery.error : null}
                onRetry={() => void overviewQuery.refetch()}
              />
              {isSignedIn && (
                <UsMarketIndicators
                  overview={overviewQuery.data}
                  loading={overviewQuery.isLoading}
                />
              )}
            </div>
          ))}

          {renderWorkspaceCard("market-intraday", "加權指數分時", dashboardSectionScope, (
            <Panel
              title="加權指數分時"
              eyebrow={marketIntradayQuery.data
                ? `${marketIntradayQuery.data.date} · ${marketIntradayQuery.data.sessionType === "historical" ? "最近交易日分時" : "09:00 起至最新分鐘"}`
                : "台灣加權指數 · 09:00 起至最新分鐘"}
              action={<span className="intraday-refresh-label">{marketIntradayQuery.isFetching ? "更新中" : "每 15 秒更新"}</span>}
            >
              {!marketIntradayQuery.data && marketIntradayQuery.isLoading ? (
                <SkeletonBlock className="chart-skeleton" />
              ) : marketIntradayQuery.isError && !marketIntradayQuery.data ? (
                <ProviderError message={parseError(marketIntradayQuery.error)} onRetry={() => void marketIntradayQuery.refetch()} />
              ) : !marketIntradayQuery.data || marketIntradayQuery.data.bars.length === 0 ? (
                <EmptyState title="目前沒有可用的分時資料" detail="取得從 09:00 開始的完整一分鐘走勢後，圖表會顯示在這裡。" />
              ) : (
                <>
                  <MarketIntradayChart data={marketIntradayQuery.data} dark={darkGrid} />
                  <div className="source-line">
                    <Info size={13} /> 資料來源：{marketIntradayQuery.data.source} · 資料時間 {formatTime(marketIntradayQuery.data.asOf)} · {marketIntradayQuery.data.bars.length} 根一分鐘 K 線
                  </div>
                </>
              )}
            </Panel>
          ))}

        {!allMarketCardsCollapsed && renderWorkspaceCard("market-analysis", "02 台股大盤走勢", dashboardSectionScope, (
          <div className="market-grid card-workspace" data-reveal>
            <CardOrderWorkspace
              storageKey={`${CARD_ORDER_STORAGE_KEY}:market`}
              cardIds={marketCardScope}
              order={cardOrder.filter((id) => marketCardScope.includes(id))}
              onOrderChange={(order) => updateScopedCardOrder(marketCardScope, order)}
              className="card-order-workspace-layer"
            >
          {renderWorkspaceCard("market-summary", "大盤概況", marketCardScope, (
            <SummaryPanel
              summary={summaryQuery.data}
              dailySummary={marketAiDailySummaryQuery.data}
              loading={summaryQuery.isLoading}
              error={summaryQuery.isError && !summaryQuery.data ? summaryQuery.error : null}
              onRetry={() => void summaryQuery.refetch()}
            />
          ))}
          {renderWorkspaceCard("market-history", "大盤每日收盤", marketCardScope, (
            <Panel title="大盤每日收盤" eyebrow={`${marketHistoryQuery.data?.ticker ?? "台灣加權指數"} · ${marketHistoryQuery.data?.range ?? marketRange}`} action={<CsvButton filename="taiex-daily-range.csv" rows={marketChartRows} />}>
              {!marketHistoryQuery.data && marketHistoryQuery.isLoading ? <SkeletonBlock className="chart-skeleton" /> : marketHistoryQuery.isError && !marketHistoryQuery.data ? <ProviderError message={parseError(marketHistoryQuery.error)} onRetry={() => void marketHistoryQuery.refetch()} /> : marketBars.length === 0 ? <EmptyState title="目前沒有大盤歷史資料" detail="這段期間沒有可用的大盤每日價格。" /> : (
                <div className={`chart-wrap market-chart ${marketSummaryCollapsed ? "market-chart-compact" : ""}`} data-testid="chart-market-history">
                  <MarketHistoryChart bars={marketBars} dark={darkGrid} compact={marketSummaryCollapsed} />
                </div>
              )}
              {marketBars.length > 0 && <div className="source-line"><Info size={13} /> 資料來源：{marketHistoryQuery.data?.source ?? "TWSE Open Data"} · 更新時間 {formatTime(marketHistoryQuery.data?.asOf)}</div>}
            </Panel>
          ))}
          {renderWorkspaceCard("futures-strategy", "臺指期日盤參考", marketCardScope, (
            <FuturesAiDayStrategyPanel
              strategy={futuresDayStrategyQuery.data}
              loading={futuresDayStrategyQuery.isLoading}
              refreshing={futuresDayStrategyQuery.isFetching}
              error={futuresDayStrategyQuery.isError && !futuresDayStrategyQuery.data ? futuresDayStrategyQuery.error : null}
              onRetry={() => void futuresDayStrategyQuery.refetch()}
            />
          ))}
            </CardOrderWorkspace>
          </div>
        ), (
          <div className="range-control"><span>期間</span>{RANGES.map((item) => <button type="button" key={item.value} className={marketRange === item.value ? "active" : ""} onClick={() => setMarketRange(item.value)} data-testid={`button-market-range-${item.value}`}>{item.label}</button>)}</div>
        ))}

        {renderWorkspaceCard("stock-analysis", `03 ${selectedSymbol} 個股走勢`, dashboardSectionScope, (
          <div className="stock-analysis-content">
        {!stockBars.length && (stockHistoryQuery.isLoading || stockHistoryQuery.isFetching) ? (
          <div className="stock-grid" data-reveal><SkeletonBlock className="chart-skeleton large" /><div className="side-stack"><SkeletonBlock className="h-[250px]" /><SkeletonBlock className="h-[220px]" /></div></div>
        ) : stockError ? (
          <ProviderError message={stockError} onRetry={() => void stockHistoryQuery.refetch()} />
        ) : !stock ? (
          <EmptyState title="目前沒有個股歷史資料" detail={`交易所沒有提供 ${selectedSymbol} 的有效每日價格；此畫面不會填入虛構行情。`} />
        ) : (
          <>
            <div className="instrument-head" data-reveal>
              <div><span className="instrument-ticker">{stock.symbol}</span><span className="instrument-source">{stock.source} · {stock.currency ?? "新台幣"} · 每日資料更新 {formatTime(stock.asOf)}</span></div>
            </div>
            {(accountError || saveError) && (
              <div className="notice-strip" role="status" data-testid="status-watchlist-sync-error">
                <CircleAlert size={15} />
                <span>{accountError ?? saveError}</span>
                {accountError && (
                  <button
                    type="button"
                    className="notice-retry"
                    onClick={retryProfile}
                    disabled={watchlistRefreshing}
                    data-testid="button-retry-account-profile"
                  >
                    {watchlistRefreshing ? "讀取中…" : "重新讀取"}
                  </button>
                )}
              </div>
            )}
            {stock.insufficient && <div className="notice-strip"><CircleAlert size={15} /><strong>可用資料較少</strong><span>目前只有 {stockBars.length} 個交易日，長期平均價格暫時不顯示。</span></div>}
            <div className="stock-card-workspace">
              <CardOrderWorkspace
                storageKey={`${CARD_ORDER_STORAGE_KEY}:stock`}
                cardIds={stockCardScope}
                order={cardOrder.filter((id) => stockCardScope.includes(id))}
                onOrderChange={(order) => updateScopedCardOrder(stockCardScope, order)}
                className="card-order-workspace-layer"
              >
              {renderWorkspaceCard("stock-metrics", "個股快速摘要", stockCardScope, (
                <div className="metric-grid" data-reveal>
                  <MetricCard label="近期走勢" value={stock.trend} note={stock.ma20 !== null && stock.ma60 !== null ? "20 日與 60 日平均價相比" : "至少需要 60 個交易日"} accent={stock.trend === "近期較強" ? "rising" : stock.trend === "近期較弱" ? "falling" : "ink"} testId="metric-trend" />
                  <MetricCard label="近 14 日漲跌力道" value={stock.rsi === null ? "—" : stock.rsi.toFixed(1)} note={stock.rsi === null ? "至少需要 15 個交易日" : stock.rsi > 70 ? "近期漲得較快，留意波動" : stock.rsi < 30 ? "近期走弱" : "近期漲跌幅度一般"} accent={stock.rsi !== null && stock.rsi > 70 ? "rising" : stock.rsi !== null && stock.rsi < 30 ? "falling" : "signal"} testId="metric-rsi" />
                  <MetricCard label="每日波動參考" value={formatNumber(stock.atr, 2)} note="近 14 日平均每日價格變動" accent="signal" testId="metric-atr" />
                  <MetricCard label="近 20 日高低價" value={`${formatNumber(stock.support, 2)} — ${formatNumber(stock.resistance, 2)}`} note="僅顯示近期最高與最低價" accent="ink" testId="metric-range" />
                  <MetricCard label="成交量" value={stock.latest.volume === null ? "—" : `${formatNumber(stock.latest.volume / 1000, 1)} 張`} note={stock.latest.volume === null ? "來源未提供成交量" : "1 張 = 1,000 股"} accent="falling" testId="metric-volume" />
                </div>
              ))}
              {renderWorkspaceCard("research-data", "公司財報與投資人買賣", stockCardScope, (
                <StockResearchDataPanel
                  data={stockResearchDataQuery.data}
                  bars={stockBars}
                  loading={stockResearchDataQuery.isLoading}
                  error={stockResearchDataQuery.isError && !stockResearchDataQuery.data ? stockResearchDataQuery.error : null}
                  onRetry={() => void stockResearchDataQuery.refetch()}
                />
              ))}
              {renderWorkspaceCard("ai-assessment", "AI 個股方向參考", stockCardScope, (
                <StockAiAssessmentPanel
                  assessment={visibleStockAiAssessment}
                  loading={!visibleStockAiAssessment && (
                    stockAiAssessmentQuery.isLoading ||
                    stockAiAssessmentQuery.isFetching ||
                    isRefreshingAiForLiveQuote
                  )}
                  refreshing={Boolean(
                    visibleStockAiAssessment &&
                    (stockAiAssessmentQuery.isFetching || isRefreshingAiForLiveQuote)
                  )}
                  error={
                    stockAiAssessmentQuery.isFetching ||
                    isRefreshingAiForLiveQuote
                      ? null
                      : aiAssessmentNeedsLiveQuote
                        ? stockAiAssessmentQuery.error ??
                          new Error(
                            hasFreshIntradayStockQuote
                              ? "盤中即時報價已更新，但 AI 判讀尚未取得即時基準；舊的收盤價判讀已隱藏，請稍後重試。"
                              : "尚未取得可驗證的盤中即時報價；舊的收盤價判讀已隱藏，請稍後重試。",
                          )
                        : stockAiAssessmentQuery.isError
                          && !stockAiAssessmentQuery.data
                          ? stockAiAssessmentQuery.error
                          : null
                  }
                  onRetry={() => void stockAiAssessmentQuery.refetch()}
                />
              ))}
              {renderWorkspaceCard("price-chart", "股價走勢", stockCardScope, (
                <PriceChart
                  bars={stockBars}
                  symbol={stock.symbol}
                  dark={darkGrid}
                  assessment={visibleStockAiAssessment}
                />
              ))}
              {renderWorkspaceCard("volume-chart", "成交量", stockCardScope, (
                <VolumeChart bars={stockBars} symbol={stock.symbol} dark={darkGrid} />
              ))}
              {renderWorkspaceCard("technical-ledger", "股價計算明細", stockCardScope, (
              <Panel title="股價計算明細" eyebrow="數值來源與說明">
                <div className="ledger-grid">
                  <div className="ledger-item"><span>20 日平均價</span><strong>{formatNumber(stock.ma20, 2)}</strong><small>{stock.ma20 !== null ? (stock.latest.close > stock.ma20 ? "最近收盤價高於平均價" : "最近收盤價低於平均價") : "資料不足"}</small></div>
                  <div className="ledger-item"><span>60 日平均價</span><strong>{formatNumber(stock.ma60, 2)}</strong><small>{stock.ma60 !== null ? (stock.latest.close > stock.ma60 ? "最近收盤價高於平均價" : "最近收盤價低於平均價") : "資料不足"}</small></div>
                  <div className="ledger-item"><span>120 日平均價</span><strong>{formatNumber(stock.ma120, 2)}</strong><small>{stock.ma120 !== null ? "較長期股價參考" : "資料不足"}</small></div>
                  <div className="ledger-item"><span>最近高價／低價</span><strong>{formatNumber(stock.latest.high, 2)} / {formatNumber(stock.latest.low, 2)}</strong><small>{formatDate(stock.latest.date)}</small></div>
                  <div className="ledger-item"><span>可用交易日數</span><strong>{stockBars.length} 日</strong><small>查詢期間：{range}</small></div>
                </div>
                <div className="source-line"><Info size={13} /> {stock.source} · 數值由交易所每日收盤資料計算，不是 AI 漲跌預測。</div>
              </Panel>
              ))}
              </CardOrderWorkspace>
            </div>
          </>
        )}
          </div>
        ), (
          <div className="range-control"><span>期間</span>{RANGES.map((item) => <button type="button" key={item.value} className={range === item.value ? "active" : ""} onClick={() => setRange(item.value)} data-testid={`button-stock-range-${item.value}`}>{item.label}</button>)}</div>
        ))}
        </CardOrderWorkspace>

        <footer className="app-footer">
          <div><span className="footer-mark">TD</span><span>本工具僅供參考，不是券商或投資顧問。</span></div>
          <div><span><CircleCheck size={13} /> 顯示資料來源與更新時間。</span><span><Info size={13} /> 投資機構買賣資料每日更新，不是即時資訊。</span></div>
        </footer>
      </main>
    </div>
  );
}

function MarketIntradayChart({ data, dark }: { data: MarketIntradayHistory; dark: boolean }) {
  const rows = data.bars.map((bar) => ({
    timestamp: new Date(bar.time).getTime(),
    close: bar.close,
  }));
  const latest = data.bars.at(-1);
  if (!latest) return null;

  const change = latest.close - data.previousClose;
  const changePercent = (change / data.previousClose) * 100;
  const high = Math.max(...data.bars.map((bar) => bar.high));
  const low = Math.min(...data.bars.map((bar) => bar.low));
  const lineColor = change >= 0 ? CHART_COLORS.rising : CHART_COLORS.falling;
  const sessionStart = new Date(`${data.date}T09:00:00+08:00`).getTime();
  const sessionEnd = new Date(`${data.date}T13:30:00+08:00`).getTime();
  const sessionTicks = [
    sessionStart,
    ...Array.from({ length: 4 }, (_, index) => sessionStart + (index + 1) * 60 * 60 * 1000),
    sessionEnd,
  ];

  return (
    <div data-testid="chart-market-intraday">
      <div className="intraday-chart-summary">
        <div>
          <span>最新一分 K</span>
          <strong>{formatNumber(latest.close)}</strong>
        </div>
        <div>
          <span>較前收 {formatNumber(data.previousClose)}</span>
          <strong className={change >= 0 ? "rising" : "falling"}>
            {formatNumber(change)} · {formatPercent(changePercent)}
          </strong>
        </div>
        <div>
          <span>盤中高 / 低</span>
          <strong>{formatNumber(high)} / {formatNumber(low)}</strong>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280} debounce={0}>
        <LineChart data={rows} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid
            stroke={dark ? "rgba(220,230,238,.1)" : CHART_COLORS.grid}
            strokeDasharray="2 4"
            vertical={false}
          />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={[sessionStart, sessionEnd]}
            ticks={sessionTicks}
            tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval={0}
            tickFormatter={(value) => formatIntradayAxisTime(Number(value))}
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={72}
            tickFormatter={(value) => formatNumber(Number(value), 0)}
          />
          <Tooltip
            isAnimationActive={false}
            contentStyle={{
              background: dark ? "#202932" : "#fbfcfd",
              border: `1px solid ${dark ? "#3b4853" : "#d7dbe0"}`,
              borderRadius: 4,
              color: dark ? "#eef2f5" : "#233044",
              fontFamily: "Space Mono",
              fontSize: 11,
            }}
            labelFormatter={(label) => `台北時間 · ${formatIntradayAxisTime(Number(label))}`}
            formatter={(value) => [formatNumber(Number(value)), "加權指數"]}
          />
          <Line
            type="linear"
            dataKey="close"
            name="加權指數"
            stroke={lineColor}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatIntradayAxisTime(value: number) {
  if (!Number.isFinite(value)) return "—";
  return new Date(value).toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function MarketHistoryChart({ bars, dark, compact }: { bars: Bar[]; dark: boolean; compact: boolean }) {
  const data = bars.map((bar) => ({ ...bar, displayDate: formatChartDate(bar.date) }));
  return (
    <ResponsiveContainer width="100%" height={compact ? 190 : 330} debounce={0}>
      <AreaChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
        <defs><linearGradient id="marketFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={CHART_COLORS.rising} stopOpacity={0.25} /><stop offset="100%" stopColor={CHART_COLORS.rising} stopOpacity={0.02} /></linearGradient></defs>
        <CartesianGrid stroke={dark ? "rgba(220,230,238,.1)" : CHART_COLORS.grid} strokeDasharray="2 4" />
        <XAxis dataKey="displayDate" tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={34} />
        <YAxis domain={["auto", "auto"]} tick={{ fill: dark ? "#aab4be" : "#667383", fontSize: 11 }} axisLine={false} tickLine={false} width={72} tickFormatter={(value) => formatNumber(value, 0)} />
        <Tooltip isAnimationActive={false} contentStyle={{ background: dark ? "#202932" : "#fbfcfd", border: `1px solid ${dark ? "#3b4853" : "#d7dbe0"}`, borderRadius: 4, color: dark ? "#eef2f5" : "#233044", fontFamily: "Space Mono", fontSize: 11 }} labelFormatter={(label) => `日期 · ${label}`} />
        <Area type="monotone" dataKey="close" name="收盤價" stroke={CHART_COLORS.rising} fill="url(#marketFill)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function PageNavigation({ active }: { active: "dashboard" | "aiPicks" | "watchlist" | "portfolio" | "etfSavings" | "quantLab" | "research" | "systemSettings" }) {
  const { entries, profile, isSignedIn, isLoading, accountError } = useAccountWatchlist();
  const { signOut } = useClerk();
  const railNavRef = useRef<HTMLElement | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const count = entries.length;
  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const nav = railNavRef.current;
    const activeLink = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !activeLink) return;

    const navBounds = nav.getBoundingClientRect();
    const activeBounds = activeLink.getBoundingClientRect();
    if (activeBounds.right > navBounds.right) {
      nav.scrollLeft += activeBounds.right - navBounds.right;
    } else if (activeBounds.left < navBounds.left) {
      nav.scrollLeft -= navBounds.left - activeBounds.left;
    }
  }, [active, isSignedIn]);
  const handleSignOut = async () => {
    setIsSigningOut(true);
    setSignOutError("");
    try {
      await signOut({ redirectUrl: appRoute("/") });
    } catch {
      setIsSigningOut(false);
      setSignOutError("登出失敗，請重新整理後再試。");
    }
  };
  return <aside className="route-rail" aria-label="台股決策台導覽">
     <Link href="/" className="rail-brand" data-testid="link-brand-dashboard">
      <span className="brand-mark"><Activity size={17} /></span>
       <span><strong>台股分析</strong><small>市場與個股</small></span>
    </Link>
     <div className="rail-section-label">功能</div>
      <nav ref={railNavRef} className="rail-nav" aria-label="主要頁面">
      <Link href="/" className={`rail-link ${active === "dashboard" ? "active" : ""}`} aria-current={active === "dashboard" ? "page" : undefined} data-testid="link-nav-dashboard">
        <LayoutDashboard size={17} /><span>市場分析</span><small>01</small>
      </Link>
      <Link href="/ai-picks" className={`rail-link ${active === "aiPicks" ? "active" : ""}`} aria-current={active === "aiPicks" ? "page" : undefined} data-testid="link-nav-ai-picks">
        <Sparkles size={17} /><span>AI 選股</span><small>02</small>
      </Link>
      {isSignedIn && (
        <>
          <Link href="/watchlist" className={`rail-link ${active === "watchlist" ? "active" : ""}`} aria-current={active === "watchlist" ? "page" : undefined} data-testid="link-nav-watchlist">
            <Bookmark size={17} /><span>自選清單</span><small className="rail-count" aria-label={`${count} 檔自選`}>{String(count).padStart(2, "0")}</small>
          </Link>
          <Link href="/portfolio" className={`rail-link ${active === "portfolio" ? "active" : ""}`} aria-current={active === "portfolio" ? "page" : undefined} data-testid="link-nav-portfolio">
            <Briefcase size={17} /><span>交易試算</span><small>03</small>
          </Link>
          <Link href="/etf-savings" className={`rail-link ${active === "etfSavings" ? "active" : ""}`} aria-current={active === "etfSavings" ? "page" : undefined} data-testid="link-nav-etf-savings">
            <BarChart3 size={17} /><span>ETF 存股</span><small>04</small>
          </Link>
          <Link href="/quant-lab" className={`rail-link ${active === "quantLab" ? "active" : ""}`} aria-current={active === "quantLab" ? "page" : undefined} data-testid="link-nav-quant-lab">
            <FlaskConical size={17} /><span>量化研究室</span><small>05</small>
          </Link>
          <Link href="/research-office" className={`rail-link ${active === "research" ? "active" : ""}`} aria-current={active === "research" ? "page" : undefined} data-testid="link-nav-research-office">
            <MessageCircle size={17} /><span>CEO 研究部</span><small>06</small>
          </Link>
        </>
      )}
      <Link href="/system-settings" className={`rail-link ${active === "systemSettings" ? "active" : ""}`} aria-current={active === "systemSettings" ? "page" : undefined} data-testid="link-nav-system-settings">
        <Settings size={17} /><span>系統設定</span><small>07</small>
      </Link>
      {isLoading ? (
        <div className="rail-link rail-account-loading" role="status" data-testid="status-account-loading">正在確認帳號…</div>
      ) : isSignedIn ? (
        <div className="rail-link rail-user-control" data-testid="control-user-account">
          <span>{profile?.email ?? "帳號"}</span>
          <button
            type="button"
            className="rail-account-signout"
            onClick={() => void handleSignOut()}
            disabled={isSigningOut}
            aria-label="登出帳號"
            aria-busy={isSigningOut}
            title={isSigningOut ? "登出中" : "登出"}
            data-testid="button-sign-out"
          >
            <LogOut size={15} />
          </button>
        </div>
      ) : (
        <Link href="/sign-in" className="rail-link" data-testid="link-nav-sign-in">
          <LogIn size={17} /><span>登入並同步自選</span>
        </Link>
      )}
      {signOutError && <small className="rail-signout-error" role="alert">{signOutError}</small>}
      {isSignedIn &&
        !isLoading &&
        (profile?.isAdmin || accountError || !profile) && (
        <Link href="/admin/users" className="rail-link" data-testid="link-nav-admin-users">
          <ShieldCheck size={17} /><span>管理使用者</span>
        </Link>
      )}
    </nav>
     <div className="rail-footer"><span className="rail-status-dot" /><span>台股資料來源</span><small>{isSignedIn ? "自選清單同步至帳號" : "訪客僅瀏覽大盤行情"}</small></div>
  </aside>;
}

function calculateWatchlistReturn(
  bars: Array<{ close: number }>,
  tradingDays: number,
): number | null {
  const latestClose = bars.at(-1)?.close;
  const baseClose = bars.at(-(tradingDays + 1))?.close;
  if (
    latestClose === undefined ||
    baseClose === undefined ||
    baseClose <= 0
  ) {
    return null;
  }
  return ((latestClose - baseClose) / baseClose) * 100;
}

function watchlistInsightId(symbol: string): string {
  return `watchlist-insight-${symbol.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function WatchlistStockInsight({ entry }: { entry: WatchlistEntry }) {
  const history = useGetStockHistory(
    { symbol: entry.symbol, range: "3mo" },
    {
      query: {
        queryKey: [
          "/api/stocks/history",
          { symbol: entry.symbol, range: "3mo" },
        ] as const,
      },
    },
  );
  const assessmentQuery = useGetStockAiAssessment(
    { symbol: entry.symbol },
    {
      query: {
        queryKey: ["/api/stocks/ai-assessment", { symbol: entry.symbol }] as const,
        retry: false,
        staleTime: 60_000,
      },
    },
  );
  const bars = history.data?.bars ?? [];
  const latestBar = bars.at(-1);
  const assessment =
    assessmentQuery.data?.symbol.replace(/\.(TW|TWO)$/i, "") ===
    entry.symbol.replace(/\.(TW|TWO)$/i, "")
      ? assessmentQuery.data
      : undefined;
  const directionLabels: Record<StockAiAssessment["direction"], string> = {
    bullish: "偏多",
    bearish: "偏空",
    neutral: "方向不明",
    insufficient: "資料不足",
  };
  const performance = [
    { label: "當日", value: calculateWatchlistReturn(bars, 1) },
    { label: "近 5 日", value: calculateWatchlistReturn(bars, 5) },
    { label: "近 20 日", value: calculateWatchlistReturn(bars, 20) },
  ];

  return (
    <section
      className="watchlist-insight"
      id={watchlistInsightId(entry.symbol)}
      aria-label={`${entry.symbol} 個股表現與 AI 簡評`}
      data-testid={`panel-watchlist-insight-${entry.symbol}`}
    >
      <div className="watchlist-insight-heading">
        <div>
          <span className="section-eyebrow">個股速覽</span>
          <h3>
            {entry.symbol.replace(/\.(TW|TWO)$/i, "")} ·{" "}
            {history.data?.quote.name || entry.name}
          </h3>
        </div>
        <span className="watchlist-insight-period">近 3 個月每日收盤資料</span>
      </div>

      {history.isLoading && !history.data ? (
        <div className="watchlist-insight-loading" role="status">
          正在整理個股表現…
        </div>
      ) : history.isError && !history.data ? (
        <div className="watchlist-insight-error" role="status">
          <span>{parseError(history.error)}</span>
          <button type="button" onClick={() => void history.refetch()}>
            重試
          </button>
        </div>
      ) : latestBar ? (
        <>
          <div className="watchlist-performance-grid">
            <div>
              <span>最近收盤</span>
              <strong>{formatNumber(latestBar.close, 2)}</strong>
              <small>{formatDate(latestBar.date)}</small>
            </div>
            {performance.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong
                  className={
                    item.value === null
                      ? ""
                      : item.value >= 0
                        ? "rising"
                        : "falling"
                  }
                >
                  {formatPercent(item.value)}
                </strong>
                <small>依每日收盤價計算</small>
              </div>
            ))}
          </div>
          <p className="watchlist-insight-source">
            歷史表現以交易所每日收盤資料計算，不代表即時報價。
          </p>
        </>
      ) : (
        <div className="watchlist-insight-loading" role="status">
          目前沒有足夠的每日收盤資料計算近期表現。
        </div>
      )}

      <div className="watchlist-ai-brief" aria-live="polite">
        <div className="watchlist-ai-brief-heading">
          <strong>AI 短線判讀</strong>
          {assessment && (
            <span
              className={`watchlist-ai-badge ${assessment.direction}`}
              data-testid={`text-watchlist-ai-direction-${entry.symbol}`}
            >
              {directionLabels[assessment.direction]}
            </span>
          )}
        </div>
        {assessmentQuery.isLoading && !assessmentQuery.data ? (
          <p className="watchlist-insight-loading" role="status">
            正在分析個股強弱…
          </p>
        ) : assessmentQuery.isError && !assessmentQuery.data ? (
          <div className="watchlist-insight-error" role="status">
            <span>{parseAiRequestError(assessmentQuery.error)}</span>
            <button type="button" onClick={() => void assessmentQuery.refetch()}>
              重試
            </button>
          </div>
        ) : assessment ? (
          <>
            <p>{assessment.summary}</p>
            <small>
              {assessment.referenceType === "official_daily_close"
                ? `以 ${formatDate(assessment.quoteAsOf)} 官方收盤資料判讀`
                : `以 ${formatTime(assessment.quoteAsOf)} 最新成交資料判讀`}
              {" · "}AI 僅供參考
            </small>
          </>
        ) : (
          <p className="watchlist-insight-loading" role="status">
            尚無可用的 AI 簡短說明。
          </p>
        )}
      </div>
    </section>
  );
}

function WatchlistQuoteRow({ entry, selected, onRemove, onSelect, removeDisabled }: {
  entry: WatchlistEntry;
  selected: boolean;
  onRemove: (symbol: string) => void;
  onSelect: (entry: WatchlistEntry) => void;
  removeDisabled: boolean;
}) {
  const query = useGetStockHistory({ symbol: entry.symbol, range: "1mo" }, {
    query: { queryKey: ["/api/stocks/history", { symbol: entry.symbol, range: "1mo" }] as const },
  });
  const quote = query.data?.quote;
  const price = quote?.available && quote.price !== null ? quote.price : query.data?.bars.at(-1)?.close ?? null;
  const displayedName = quote?.name || entry.name;
  return <article className="watchlist-row" data-testid={`row-watchlist-${entry.symbol}`}>
    <button
      type="button"
      className={`watchlist-symbol ${selected ? "is-expanded" : ""}`}
      onClick={() => onSelect(entry)}
      aria-expanded={selected}
      aria-controls={selected ? watchlistInsightId(entry.symbol) : undefined}
      data-testid={`button-select-watchlist-${entry.symbol}`}
    >
      <strong>{entry.symbol.replace(/\.(TW|TWO)$/i, "")}</strong><span>{displayedName}</span>
    </button>
    <div className="watchlist-price" aria-live="polite">
      {query.isLoading ? <span className="watchlist-skeleton">查詢官方行情…</span> :
        query.isError && !query.data ? <span className="watchlist-quote-error" role="status">行情暫不可用 · <button type="button" onClick={() => void query.refetch()} data-testid={`button-retry-watchlist-${entry.symbol}`}>重試</button></span> :
        <><strong>{price === null ? "暫無價格資料" : formatNumber(price, 2)}</strong><small>{quote?.available ? quote.source : query.data?.source ?? "歷史來源未提供"} · {quote?.asOf ? formatTime(quote.asOf) : query.data?.asOf ? `每日價格 ${formatDate(query.data.asOf)}` : "時間未提供"}</small></>}
    </div>
    <button type="button" className="watchlist-remove" onClick={() => onRemove(entry.symbol)} disabled={removeDisabled} aria-label={`移除 ${entry.symbol}`} data-testid={`button-remove-watchlist-${entry.symbol}`}>移除</button>
  </article>;
}

function WatchlistPage() {
  const {
    entries,
    setEntries,
    isSignedIn,
    isLoading,
    canEdit,
    isSaving,
    saveSucceeded,
    canSave,
    isRefreshing,
    retryProfile,
    saveWatchlist,
    accountError,
    saveError,
  } = useAccountWatchlist();
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const remove = (symbol: string) => {
    if (!canEdit || isSaving) return;
    const next = entries.filter((entry) => entry.symbol !== symbol);
    setEntries(next);
    if (expandedSymbol === symbol) setExpandedSymbol(null);
  };
  const select = (entry: WatchlistEntry) => {
    storeSelectedSymbol(entry.symbol);
    setExpandedSymbol((current) =>
      current === entry.symbol ? null : entry.symbol,
    );
  };
  if (isLoading) {
    return <div className="account-route-loading" role="status" data-testid="status-watchlist-auth-loading">正在確認登入狀態…</div>;
  }
  if (!isSignedIn) {
    return <AccountRouteNotice
      title="登入後查看自選清單"
      detail="訪客僅能瀏覽大盤數字。登入後才能查看個人自選清單與個股資訊。"
      href="/sign-in"
      linkLabel="前往登入"
    />;
  }
  return <div className="app-shell terminal-grid">
    <PageNavigation active="watchlist" />
    <main className="dashboard-main route-page">
       <div className="route-page-heading"><div><p className="section-eyebrow">追蹤清單</p><h1>自選清單</h1><p className="lede">{isSignedIn ? "自選清單已連結至你的帳號，可在其他裝置登入後同步。每筆價格都會標示資料來源和時間。" : "未登入時，自選清單只存在這個瀏覽器。登入後會儲存在個人帳號中，並可在其他裝置同步。"}</p></div>
         <Link href="/" className="route-primary-link" data-testid="link-watchlist-to-dashboard"><Plus size={15} aria-hidden="true" />新增自選股</Link>
      </div>
      <section className="watchlist-panel glass-panel" data-testid="panel-watchlist">
          <div className="watchlist-panel-head">
            <div>
              <span className="section-eyebrow">帳號自選清單</span>
              <h2>{entries.length} 檔自選股票</h2>
            </div>
            <div className="watchlist-panel-actions">
              <p>
                {isSaving
                  ? "正在同步至帳號…"
                  : saveError
                    ? "同步失敗，可重新儲存。"
                    : "加入或移除股票時會自動同步。"}
              </p>
              <button
                type="button"
                className="watchlist-manual-save"
                onClick={saveWatchlist}
                disabled={!canSave || isSaving}
                data-testid="button-save-watchlist"
              >
                {isSaving
                  ? "儲存中…"
                  : saveSucceeded
                    ? "已儲存"
                    : "儲存自選清單"}
              </button>
            </div>
          </div>
         {saveError && <div className="notice-strip" role="status" data-testid="status-watchlist-save-error"><CircleAlert size={15} /><span>{saveError}</span></div>}
         {isLoading ? <div className="watchlist-empty" role="status" data-testid="status-watchlist-loading">正在載入自選清單…</div> :
           accountError ? <div className="watchlist-empty" role="status" data-testid="status-watchlist-account-error"><CircleAlert size={23} /><strong>帳號清單目前無法讀取</strong><p>{accountError}</p><button type="button" className="watchlist-retry" onClick={retryProfile} disabled={isRefreshing} data-testid="button-retry-account-watchlist">{isRefreshing ? "重新讀取中…" : "重新讀取自選清單"}</button></div> :
          entries.length ? <div className="watchlist-list">{entries.map((entry) => {
           const selected = expandedSymbol === entry.symbol;
           return (
             <div className="watchlist-entry" key={entry.symbol}>
               <WatchlistQuoteRow
                 entry={entry}
                 selected={selected}
                 onRemove={remove}
                 onSelect={select}
                 removeDisabled={!canEdit || isSaving}
               />
               {selected && <WatchlistStockInsight entry={entry} />}
             </div>
           );
         })}</div> :
          <div className="watchlist-empty" data-testid="status-watchlist-empty"><Bookmark size={23} /><strong>還沒有自選股票</strong><p>到台股分析頁選擇股票，再按「加入自選股」即可保存。</p><Link href="/" className="route-primary-link" data-testid="link-empty-watchlist-dashboard">搜尋台股</Link></div>}
      </section>
        <p className="route-footnote" data-testid="text-watchlist-storage-note">自選清單由登入帳號保存；加入與移除會自動同步，也可按「儲存自選清單」重新保存。若價格查詢失敗，可逐檔重試。</p>
    </main>
  </div>;
}

function PortfolioPage() {
  const { isSignedIn, isLoading: accountLoading } = useAccountWatchlist();
  const symbol = readSelectedSymbol();
  const assessmentSymbol = normalizeTaiwanStockSymbol(symbol);
  const history = useGetStockHistory({ symbol, range: "6mo" }, {
    query: {
      queryKey: ["/api/stocks/history", { symbol, range: "6mo" }] as const,
      enabled: isSignedIn,
    },
  });
  const assessmentQuery = useGetStockAiAssessment({ symbol: assessmentSymbol }, {
    query: { queryKey: ["/api/stocks/ai-assessment", { symbol: assessmentSymbol }] as const, retry: false, enabled: isSignedIn, staleTime: 60_000 },
  });
  const bars = history.data?.bars ?? [];
  const latest = bars.at(-1);
  const currentPrice = history.data?.quote.available && history.data.quote.price !== null
    ? history.data.quote.price : latest?.close ?? null;
  const assessment =
    assessmentQuery.data &&
    normalizeTaiwanStockSymbol(assessmentQuery.data.symbol) ===
      normalizeTaiwanStockSymbol(symbol)
      ? assessmentQuery.data
      : undefined;
  if (accountLoading) {
    return <div className="account-route-loading" role="status" data-testid="status-portfolio-auth-loading">正在確認登入狀態…</div>;
  }
  if (!isSignedIn) {
    return <AccountRouteNotice
      title="登入後查看交易試算"
      detail="訪客僅能瀏覽大盤數字。登入後才能查看個股行情與交易風險試算。"
      href="/sign-in"
      linkLabel="前往登入"
    />;
  }
  return <div className="app-shell terminal-grid">
    <PageNavigation active="portfolio" />
    <main className="dashboard-main route-page">
      <div className="route-page-heading"><div><p className="section-eyebrow">買賣與風險試算</p><h1>交易規劃</h1><p className="lede">試算預計投入金額、目標價和可承受損失。結果只供參考，不會替你買賣股票。</p></div>
        <Link href="/" className="route-primary-link" data-testid="link-portfolio-to-dashboard">切換分析標的</Link>
      </div>
      <div className="portfolio-workspace">
      <section className="portfolio-symbol-banner glass-panel" data-testid="panel-portfolio-symbol">
        <div><span className="section-eyebrow">目前選定</span><strong>{symbol.replace(/\.(TW|TWO)$/i, "")}</strong><span>{history.data?.quote.name ?? history.data?.ticker ?? "台股 / ETF"}</span></div>
        <div>{history.isLoading ? <span className="status-loading" data-testid="status-portfolio-quote-loading">正在查詢官方行情</span> :
          history.isError && !history.data ? <div role="alert" className="portfolio-quote-error" data-testid="error-portfolio-quote">{parseError(history.error)} <button type="button" className="text-button" onClick={() => void history.refetch()} data-testid="button-retry-portfolio-quote">重試</button></div> :
          <><strong>{currentPrice === null ? "無可用行情" : formatNumber(currentPrice, 2)}</strong><small>{history.data?.quote.available ? history.data.quote.source : history.data?.source ?? "歷史資料來源未提供"} · {history.data?.quote.asOf ? formatTime(history.data.quote.asOf) : history.data?.asOf ? formatDate(history.data.asOf) : "無時間資料"}</small></>}</div>
      </section>
      {history.isError && !history.data ? null : history.isLoading && !history.data ? <div className="glass-panel portfolio-loading" data-testid="status-portfolio-loading"><SkeletonBlock className="h-20" /><SkeletonBlock className="h-72" /></div> :
      <div className="portfolio-calculator" data-testid="panel-portfolio-calculator">
        <DecisionCalculator
          latestPrice={currentPrice}
          atr={calculateAtr(bars)}
          currency={history.data?.currency ?? "TWD"}
          symbol={history.data?.ticker ?? symbol}
          priceBasis={history.data?.quote.available ? "最新成交價" : "最近收盤價"}
          assessment={assessment}
        />
        {assessmentQuery.isError && !assessmentQuery.data && <div className="state-box state-error" role="status" data-testid="error-portfolio-assessment"><TriangleAlert size={17} /><div><strong>AI 價格計畫目前無法載入</strong><p>{parseError(assessmentQuery.error)}</p></div><button type="button" className="text-button" onClick={() => void assessmentQuery.refetch()} data-testid="button-retry-portfolio-assessment">重試</button></div>}
        {assessmentQuery.isLoading && <div className="route-footnote" data-testid="status-portfolio-assessment-loading">正在取得 AI 價格計畫；試算欄位仍可使用。</div>}
      </div>}
      </div>
      <p className="route-footnote">AI 回覆會標示使用的服務、參考資料與日期。AI 不會替你交易，也不提供個人化投資建議。</p>
    </main>
  </div>;
}

function EtfSavingsRoute() {
  return <div className="app-shell terminal-grid">
    <PageNavigation active="etfSavings" />
    <EtfSavingsPage />
  </div>;
}

function AccountRouteNotice({ title, detail, href, linkLabel }: {
  title: string;
  detail: string;
  href: string;
  linkLabel: string;
}) {
  return <div className="app-shell terminal-grid">
    <PageNavigation active="dashboard" />
    <main className="dashboard-main route-page">
      <div className="route-page-heading">
        <div>
          <p className="section-eyebrow">帳號存取</p>
          <h1>{title}</h1>
          <p className="lede">{detail}</p>
        </div>
      </div>
      <section className="glass-panel account-route-notice" role="status" data-testid="status-account-route-access">
        <ShieldCheck size={21} />
        <Link href={href} className="route-primary-link" data-testid="link-account-route-action">{linkLabel}</Link>
      </section>
    </main>
  </div>;
}

function AdminUsersRoute() {
  const { isLoading, isSignedIn, profile, accountError } = useAccountWatchlist();
  if (isLoading) {
    return <div className="account-route-loading" role="status" data-testid="status-admin-access-loading">正在確認管理員權限…</div>;
  }
  if (!isSignedIn) {
    return <AccountRouteNotice
      title="請先登入管理帳號"
      detail="只有已受邀的帳號可以管理研究空間的使用者。訪客僅能瀏覽大盤數字。"
      href="/sign-in?returnTo=admin-users"
      linkLabel="前往登入"
    />;
  }
  if (accountError || !profile) {
    return <AccountRouteNotice
      title="此帳號目前無法管理使用者"
      detail={accountError ?? "帳號資料尚未載入。請確認邀請狀態，或重新登入後再試。"}
      href="/"
      linkLabel="返回市場分析"
    />;
  }
  if (!profile.isAdmin) {
    return <AccountRouteNotice
      title="需要管理員權限"
      detail="目前帳號可以使用個人自選清單，但不能邀請或管理其他使用者。"
      href="/"
      linkLabel="返回市場分析"
    />;
  }
  return <AdminUsersPage />;
}

function QuantLabRoute() {
  return (
    <div className="app-shell terminal-grid">
      <PageNavigation active="quantLab" />
      <QuantLabPage />
    </div>
  );
}

function SystemSettingsRoute() {
  return (
    <div className="app-shell terminal-grid">
      <PageNavigation active="systemSettings" />
      <SystemSettingsPage />
    </div>
  );
}

function AiPicksRoute() {
  return (
    <div className="app-shell terminal-grid">
      <PageNavigation active="aiPicks" />
      <AiPicksPage />
    </div>
  );
}

function ResearchOfficeRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  const query = useGetAccountResearchJobs({
    query: {
      queryKey: ["account", "research-jobs"],
      enabled: Boolean(isLoaded && isSignedIn),
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
      refetchInterval: (current) =>
        current.state.data?.some((job) => job.status === "queued" || job.status === "running")
          ? 2_500
          : false,
    },
    request: { credentials: "include" },
  });
  const jobs = (query.data ?? []) as ResearchOfficeJob[];
  const [selectedJobId, setSelectedJobId] = useState<ResearchOfficeJob["id"] | null>(null);
  useEffect(() => {
    if (jobs.length && !jobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(jobs[0].id);
    }
  }, [jobs, selectedJobId]);

  return (
    <div className="app-shell terminal-grid">
      <PageNavigation active="research" />
      <ResearchOfficePage
        jobs={jobs}
        selectedJobId={selectedJobId}
        onSelectJob={setSelectedJobId}
        isLoading={!isLoaded || query.isLoading}
        onRefresh={async () => { await query.refetch(); }}
        error={isLoaded && !isSignedIn
          ? "請先登入，才能查看帳號與已連結 LINE 的研究紀錄。"
          : query.isError
            ? "研究紀錄暫時無法載入，請確認登入狀態後重試。"
            : null}
      />
    </div>
  );
}

function Router() {
  return (
    <ErrorBoundary>
      <>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/ai-picks" component={AiPicksRoute} />
          <Route path="/watchlist" component={WatchlistPage} />
          <Route path="/portfolio" component={PortfolioPage} />
          <Route path="/etf-savings" component={EtfSavingsRoute} />
          <Route path="/quant-lab" component={QuantLabRoute} />
          <Route path="/research-office" component={ResearchOfficeRoute} />
          <Route path="/system-settings" component={SystemSettingsRoute} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/accept-invitation/*?" component={AcceptInvitationPage} />
          <Route path="/admin/users" component={AdminUsersRoute} />
          <Route component={NotFound} />
        </Switch>
        <FloatingStockAiAssistant />
      </>
    </ErrorBoundary>
  );
}

const appBasePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const appRoute = (path: string) => `${appBasePath}${path.startsWith("/") ? path : `/${path}`}`;

function App() {
  return (
    <ClerkProvider
      publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
      signInUrl={appRoute("/sign-in")}
      signUpUrl={appRoute("/accept-invitation")}
    >
      <StartupIntroGate>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AccountWatchlistProvider>
              <WouterRouter base={appBasePath}>
                <Router />
              </WouterRouter>
              <Toaster />
            </AccountWatchlistProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </StartupIntroGate>
    </ClerkProvider>
  );
}

export default App;
