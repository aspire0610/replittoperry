import type { TaifexFuturesDailyHistory } from "./taifex-market-data.js";

export const FUTURES_DAILY_HISTORY_RESPONSE_BUDGET_MS = 10_000;

export function withFuturesDailyHistoryBudget(
  historyPromise: Promise<TaifexFuturesDailyHistory>,
  fallback: TaifexFuturesDailyHistory,
  budgetMs = FUTURES_DAILY_HISTORY_RESPONSE_BUDGET_MS,
): Promise<TaifexFuturesDailyHistory> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (history: TaifexFuturesDailyHistory) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(history);
    };
    const timeout = setTimeout(() => finish(fallback), budgetMs);
    historyPromise.then(finish, () => finish(fallback));
  });
}
