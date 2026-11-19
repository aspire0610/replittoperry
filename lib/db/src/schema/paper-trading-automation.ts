import { createInsertSchema } from "drizzle-zod";
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export type PaperFuturesEntryMode = "aggressive" | "convergent";

export type PaperAutomationPosition = {
  id: string;
  agentId: string;
  ticker: string;
  name: string;
  shares: number;
  assetClass?: "equity" | "futures";
  contractType?: "TX" | "MTX" | "TMF";
  direction?: "long" | "short";
  contractMultiplier?: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  entryAt: string;
  signalAsOf: string;
  quoteSource: string;
  lastPrice: number;
  lastQuoteAt: string;
};

export type PaperAutomationPendingEntry = {
  id: string;
  agentId: string;
  ticker: string;
  name: string;
  assetClass?: "equity" | "futures";
  contractType?: "TX" | "MTX" | "TMF";
  direction?: "long" | "short";
  contractMultiplier?: number;
  forcedEntry?: boolean;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  signalAsOf: string;
  marketDate: string;
  expiresAt: string;
};

export type PaperAutomationEvent = {
  id: string;
  agentId: string | null;
  ticker: string | null;
  assetClass?: "equity" | "futures";
  contractType?: "TX" | "MTX" | "TMF";
  direction?: "long" | "short";
  contracts?: number | null;
  exitReason?: "take_profit" | "stop_loss" | "session_end";
  entryPrice?: number;
  stopLossPrice?: number;
  realizedPnl?: number;
  kind: "signal_queued" | "entry_filled" | "exit_filled" | "skipped" | "halted";
  side: "buy" | "sell" | null;
  shares: number | null;
  price: number | null;
  asOf: string;
  reason: string;
};

export type PaperFuturesEvaluation = {
  id: string;
  asOf: string;
  status: "ready" | "waiting" | "blocked" | "unavailable" | "inactive";
  action: "long" | "short" | "wait" | "insufficient" | null;
  direction: "long" | "short" | null;
  price: number | null;
  entryPrice: number | null;
  stopLossPrice: number | null;
  targetPrice: number | null;
  reason: string;
};

export type PaperFuturesStopLossOutcome = {
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  stopLossPrice: number;
  realizedPnl: number;
  asOf: string;
};

export type PaperFuturesAdjustmentFeedbackState = {
  streakId: number;
  consecutiveStopLosses: number;
  recentStopLosses: PaperFuturesStopLossOutcome[];
};

export type PaperFuturesPerformanceState = {
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  realizedPnl: number;
  consecutiveStopLosses: number;
  stopLossStreakId: number;
  lastAdjustedStreakId: number;
  lastAdjustedStopLossCount: number;
  recentStopLosses: PaperFuturesStopLossOutcome[];
  adjustmentFeedback: PaperFuturesAdjustmentFeedbackState | null;
  adjustmentStatus: "idle" | "pending" | "applied";
  adjustmentAt: string | null;
  adjustmentMessage: string;
};

export type PaperAutomationState = {
  positions: PaperAutomationPosition[];
  pendingEntries: PaperAutomationPendingEntry[];
  events: PaperAutomationEvent[];
  currentFuturesEvaluation: PaperFuturesEvaluation | null;
  futuresDecisionLogs: PaperFuturesEvaluation[];
  futuresPerformance: PaperFuturesPerformanceState;
  dailyDate: string | null;
  dailyStartEquity: number | null;
  dailyStopTriggered: boolean;
  lastProcessedAt: string | null;
};

export const paperTradingAutomationTable = pgTable("paper_trading_automation", {
  userId: text("user_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  startingCash: numeric("starting_cash", { precision: 18, scale: 2 }).notNull(),
  cash: numeric("cash", { precision: 18, scale: 2 }).notNull(),
  riskPerTradePercent: numeric("risk_per_trade_percent", { precision: 5, scale: 2 }).notNull().default("0.5"),
  dailyLossLimitPercent: numeric("daily_loss_limit_percent", { precision: 5, scale: 2 }).notNull().default("2"),
  maxOpenPositions: integer("max_open_positions").notNull().default(3),
  futuresEnabled: boolean("futures_enabled").notNull().default(false),
  futuresContract: text("futures_contract").notNull().default("TMF"),
  futuresEntryMode: text("futures_entry_mode").notNull().default("convergent"),
  futuresForceEntryEnabled: boolean("futures_force_entry_enabled").notNull().default(false),
  state: jsonb("state").$type<PaperAutomationState>().notNull().default({
    positions: [],
    pendingEntries: [],
    events: [],
    currentFuturesEvaluation: null,
    futuresDecisionLogs: [],
    futuresPerformance: {
      closedTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      realizedPnl: 0,
      consecutiveStopLosses: 0,
      stopLossStreakId: 0,
      lastAdjustedStreakId: 0,
      lastAdjustedStopLossCount: 0,
      recentStopLosses: [],
      adjustmentFeedback: null,
      adjustmentStatus: "idle",
      adjustmentAt: null,
      adjustmentMessage: "",
    },
    dailyDate: null,
    dailyStartEquity: null,
    dailyStopTriggered: false,
    lastProcessedAt: null,
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPaperTradingAutomationSchema = createInsertSchema(paperTradingAutomationTable).omit({
  updatedAt: true,
});
export type InsertPaperTradingAutomation = z.infer<typeof insertPaperTradingAutomationSchema>;
export type PaperTradingAutomation = typeof paperTradingAutomationTable.$inferSelect;
