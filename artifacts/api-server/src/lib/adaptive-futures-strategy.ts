import type {
  AdaptiveFuturesStrategyStats,
  AdaptiveFuturesStrategyState,
  AggressiveFuturesStrategyId,
} from "@workspace/db";

export const FUTURES_ADAPTIVE_MIN_TRADES = 20;
export const FUTURES_ADAPTIVE_TARGET_WIN_RATE_PERCENT = 75;
export const FUTURES_ADAPTIVE_STOP_LOSS_SWITCH_THRESHOLD = 3;

export const AGGRESSIVE_FUTURES_STRATEGIES = [
  {
    id: "aggressive_balanced",
    label: "積極基準（150點／2R）",
    minimumTargetPoints: 150,
    minimumRewardRisk: 2,
    requireCompleteContext: true,
  },
  {
    id: "aggressive_relaxed",
    label: "積極放寬（100點／1.5R）",
    minimumTargetPoints: 100,
    minimumRewardRisk: 1.5,
    requireCompleteContext: false,
  },
  {
    id: "aggressive_flexible",
    label: "積極彈性（80點／1.25R）",
    minimumTargetPoints: 80,
    minimumRewardRisk: 1.25,
    requireCompleteContext: false,
  },
] as const;

export type AggressiveFuturesStrategy = (typeof AGGRESSIVE_FUTURES_STRATEGIES)[number];

export function emptyAdaptiveFuturesStrategyState(): AdaptiveFuturesStrategyState {
  const strategies = Object.fromEntries(
    AGGRESSIVE_FUTURES_STRATEGIES.map(({ id }) => [
      id,
      { closedTrades: 0, wins: 0, losses: 0, realizedPnl: 0 },
    ]),
  ) as Record<AggressiveFuturesStrategyId, AdaptiveFuturesStrategyStats>;
  return {
    status: "exploring",
    activeStrategyId: AGGRESSIVE_FUTURES_STRATEGIES[0].id,
    strategyConsecutiveStopLosses: 0,
    switchCount: 0,
    strategies,
  };
}

export function resolveAggressiveFuturesStrategy(
  state: AdaptiveFuturesStrategyState | null | undefined,
): AggressiveFuturesStrategy {
  const id = state?.activeStrategyId;
  return AGGRESSIVE_FUTURES_STRATEGIES.find((item) => item.id === id) ??
    AGGRESSIVE_FUTURES_STRATEGIES[0];
}

export function qualifiesAggressiveFuturesStrategy(
  strategy: AggressiveFuturesStrategy,
  input: {
    hasCompleteContext: boolean;
    hasLiveDirectionalContext: boolean;
    hasDirectionalAgreement: boolean;
    meetsRiskThresholds: boolean;
  },
): boolean {
  return (
    (strategy.requireCompleteContext
      ? input.hasCompleteContext
      : input.hasLiveDirectionalContext) &&
    input.hasDirectionalAgreement &&
    input.meetsRiskThresholds
  );
}

export function recordAdaptiveFuturesStrategyOutcome(
  current: AdaptiveFuturesStrategyState | null | undefined,
  input: {
    strategyId: AggressiveFuturesStrategyId;
    realizedPnl: number;
    exitReason: "take_profit" | "stop_loss" | "session_end";
  },
): AdaptiveFuturesStrategyState {
  const defaults = emptyAdaptiveFuturesStrategyState();
  const state: AdaptiveFuturesStrategyState = {
    ...defaults,
    ...structuredClone(current ?? {}),
    strategies: {
      ...defaults.strategies,
      ...structuredClone(current?.strategies ?? {}),
    },
  };
  const stats = state.strategies[input.strategyId];
  if (!stats) return state;

  stats.closedTrades += 1;
  stats.realizedPnl = Math.round((stats.realizedPnl + input.realizedPnl) * 100) / 100;
  if (input.realizedPnl > 0) stats.wins += 1;
  else if (input.realizedPnl < 0) stats.losses += 1;

  const outcomeBelongsToActiveStrategy =
    input.strategyId === state.activeStrategyId;
  if (outcomeBelongsToActiveStrategy) {
    state.strategyConsecutiveStopLosses = input.exitReason === "stop_loss"
      ? state.strategyConsecutiveStopLosses + 1
      : 0;
  }

  const decisiveTrades = stats.wins + stats.losses;
  if (
    outcomeBelongsToActiveStrategy &&
    state.status !== "locked" &&
    decisiveTrades >= FUTURES_ADAPTIVE_MIN_TRADES &&
    stats.wins / decisiveTrades * 100 >= FUTURES_ADAPTIVE_TARGET_WIN_RATE_PERCENT
  ) {
    state.status = "locked";
    state.strategyConsecutiveStopLosses = 0;
    return state;
  }

  if (
    state.status === "exploring" &&
    state.strategyConsecutiveStopLosses >= FUTURES_ADAPTIVE_STOP_LOSS_SWITCH_THRESHOLD
  ) {
    const activeIndex = AGGRESSIVE_FUTURES_STRATEGIES.findIndex(
      (item) => item.id === state.activeStrategyId,
    );
    state.activeStrategyId =
      AGGRESSIVE_FUTURES_STRATEGIES[(activeIndex + 1) % AGGRESSIVE_FUTURES_STRATEGIES.length].id;
    state.strategyConsecutiveStopLosses = 0;
    state.switchCount += 1;
  }

  return state;
}

export function adaptiveFuturesStrategyMessage(
  state: AdaptiveFuturesStrategyState,
): string {
  const active = resolveAggressiveFuturesStrategy(state);
  const stats = state.strategies[active.id];
  const decisiveTrades = stats.wins + stats.losses;
  const rate = decisiveTrades > 0
    ? `${(stats.wins / decisiveTrades * 100).toFixed(1)}%`
    : "尚無樣本";
  const comparison = AGGRESSIVE_FUTURES_STRATEGIES.map((strategy) => {
    const result = state.strategies[strategy.id];
    const sample = result.wins + result.losses;
    const strategyRate = sample
      ? `${(result.wins / sample * 100).toFixed(1)}%`
      : "尚無樣本";
    return `${strategy.label} ${result.wins}/${sample}（${strategyRate}）`;
  }).join("；");
  if (state.status === "locked") {
    return `${active.label}已固定；${decisiveTrades} 筆有輸贏的平倉、勝率 ${rate}（至少 ${FUTURES_ADAPTIVE_MIN_TRADES} 筆且達 75%）。試驗結果：${comparison}。`;
  }
  return `正在測試${active.label}；${decisiveTrades} 筆有輸贏的平倉、勝率 ${rate}（至少 ${FUTURES_ADAPTIVE_MIN_TRADES} 筆且達 75% 才固定）；此策略連續停損 3 次後切換。試驗結果：${comparison}。`;
}
