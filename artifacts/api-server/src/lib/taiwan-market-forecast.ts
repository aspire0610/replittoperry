import { getTaiexHistory } from "./market-data.js";
import { calculateTaiwanMarketForecastEvidence } from "./taiwan-market-forecast-utils.js";
import type { TaiwanMarketForecastEvidence } from "./taiwan-market-forecast-utils.js";

export {
  calculateTaiwanMarketForecastEvidence,
  type DirectionBacktest,
  type MarketDirection,
  type TaiwanMarketForecastEvidence,
  type TaiexDailyBar,
} from "./taiwan-market-forecast-utils.js";

const HISTORY_CACHE_TTL_MS = 15 * 60_000;
let historyCache:
  | { expiresAt: number; promise: Promise<TaiwanMarketForecastEvidence> }
  | undefined;

export function getTaiwanMarketForecastEvidence(): Promise<TaiwanMarketForecastEvidence> {
  if (historyCache && historyCache.expiresAt > Date.now()) return historyCache.promise;

  const promise = getTaiexHistory("1y").then((history) => {
    const evidence = calculateTaiwanMarketForecastEvidence(history.bars, history.source);
    if (!evidence) throw new Error("加權指數日線不足 61 個交易日，無法建立歷史規則回測。");
    return evidence;
  });
  historyCache = { expiresAt: Date.now() + HISTORY_CACHE_TTL_MS, promise };
  void promise.catch(() => {
    if (historyCache?.promise === promise) historyCache = undefined;
  });
  return promise;
}
