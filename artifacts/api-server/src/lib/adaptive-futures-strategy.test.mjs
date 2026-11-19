import test from "node:test";
import assert from "node:assert/strict";
import {
  AGGRESSIVE_FUTURES_STRATEGIES,
  emptyAdaptiveFuturesStrategyState,
  qualifiesAggressiveFuturesStrategy,
  recordAdaptiveFuturesStrategyOutcome,
  resolveAggressiveFuturesStrategy,
} from "./adaptive-futures-strategy.ts";

const close = (state, {
  strategyId = state.activeStrategyId,
  realizedPnl = 100,
  exitReason = "take_profit",
} = {}) => recordAdaptiveFuturesStrategyOutcome(state, {
  strategyId,
  realizedPnl,
  exitReason,
});

test("aggressive strategies rotate only after three stop losses on the active strategy", () => {
  let state = emptyAdaptiveFuturesStrategyState();
  const first = state.activeStrategyId;
  state = close(state, { realizedPnl: -100, exitReason: "stop_loss" });
  state = close(state, { realizedPnl: -100, exitReason: "stop_loss" });
  assert.equal(state.activeStrategyId, first);
  state = close(state, { realizedPnl: -100, exitReason: "stop_loss" });
  assert.equal(state.activeStrategyId, AGGRESSIVE_FUTURES_STRATEGIES[1].id);
  assert.equal(state.strategyConsecutiveStopLosses, 0);
  assert.equal(state.switchCount, 1);
});

test("relaxed candidates still require fresh live directional evidence and risk limits", () => {
  const [balanced, relaxed] = AGGRESSIVE_FUTURES_STRATEGIES;
  const base = {
    hasCompleteContext: false,
    hasLiveDirectionalContext: true,
    hasDirectionalAgreement: true,
    meetsRiskThresholds: true,
  };
  assert.equal(qualifiesAggressiveFuturesStrategy(balanced, base), false);
  assert.equal(qualifiesAggressiveFuturesStrategy(relaxed, base), true);
  assert.equal(qualifiesAggressiveFuturesStrategy(relaxed, {
    ...base,
    hasLiveDirectionalContext: false,
  }), false);
  assert.equal(qualifiesAggressiveFuturesStrategy(relaxed, {
    ...base,
    hasDirectionalAgreement: false,
  }), false);
  assert.equal(qualifiesAggressiveFuturesStrategy(relaxed, {
    ...base,
    meetsRiskThresholds: false,
  }), false);
});

test("a strategy is locked after at least 20 decisive paper trades and 75% wins", () => {
  let state = emptyAdaptiveFuturesStrategyState();
  const active = state.activeStrategyId;
  for (let index = 0; index < 14; index += 1) {
    state = close(state, { realizedPnl: 100 });
  }
  for (let index = 0; index < 5; index += 1) {
    state = close(state, { realizedPnl: -100 });
  }
  assert.equal(state.status, "exploring");
  state = close(state, { realizedPnl: 100 });
  assert.equal(state.status, "locked");
  assert.equal(state.activeStrategyId, active);
  assert.equal(state.strategies[active].closedTrades, 20);
  assert.equal(state.strategies[active].wins, 15);
});

test("a candidate below 75% stays active until its third consecutive stop loss", () => {
  let state = emptyAdaptiveFuturesStrategyState();
  const active = state.activeStrategyId;
  for (let index = 0; index < 10; index += 1) {
    state = close(state, { realizedPnl: 100 });
  }
  for (let index = 0; index < 10; index += 1) {
    state = close(state, { realizedPnl: -100 });
  }
  assert.equal(state.status, "exploring");
  assert.equal(state.activeStrategyId, active);
  state = close(state, { realizedPnl: -100, exitReason: "stop_loss" });
  state = close(state, { realizedPnl: -100, exitReason: "stop_loss" });
  assert.equal(state.activeStrategyId, active);
  state = close(state, { realizedPnl: -100, exitReason: "stop_loss" });
  assert.equal(state.activeStrategyId, AGGRESSIVE_FUTURES_STRATEGIES[1].id);
});

test("session-end breakeven is tracked but excluded from the win-rate denominator", () => {
  let state = emptyAdaptiveFuturesStrategyState();
  const id = state.activeStrategyId;
  state = close(state, { realizedPnl: 0, exitReason: "session_end" });
  assert.equal(state.strategies[id].closedTrades, 1);
  assert.equal(state.strategies[id].wins + state.strategies[id].losses, 0);
});

test("a locked strategy does not switch after later stop losses", () => {
  let state = emptyAdaptiveFuturesStrategyState();
  for (let index = 0; index < 15; index += 1) state = close(state);
  for (let index = 0; index < 5; index += 1) {
    state = close(state, { realizedPnl: -100 });
  }
  assert.equal(state.status, "locked");
  const active = state.activeStrategyId;
  for (let index = 0; index < 3; index += 1) {
    state = close(state, { realizedPnl: -100, exitReason: "stop_loss" });
  }
  assert.equal(state.activeStrategyId, active);
  assert.equal(resolveAggressiveFuturesStrategy(state).id, active);
});
