import type { FuturesPhoneInputBar } from "./futures-phone-line";

export const FUTURES_ENTRY_REFERENCE = "https://winsmart.tw/online_teaching/期貨進場點出擊，掌握3要領/";
export type FuturesEntryInput = {
  status: string;
  symbol: string | null;
  date: string;
  asOf: string | null;
  price: number | null;
  source: string;
  bars: FuturesPhoneInputBar[];
};
export type FuturesEntryScenario = {
  id: string;
  title: string;
  direction: "long" | "short";
  status: "waiting" | "level_reached" | "armed" | "ready" | "missed" | "invalidated" | "risk_too_wide";
  level: number;
  condition: string;
  evidence: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskPoints: number | null;
  rewardRisk: number | null;
};
export type FuturesEntryResult = {
  state: "watching" | "ready" | "warming_up" | "closed" | "stale" | "unavailable";
  reason: string;
  source: string;
  asOf: string | null;
  signalAt: string | null;
  completedBars: number;
  support: number | null;
  resistance: number | null;
  keyPrice: number | null;
  atr14: number | null;
  maxChase: number | null;
  scenarios: FuturesEntryScenario[];
};

const MINUTE = 60_000;
const PERIOD = 5 * MINUTE;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const dateInTaipei = (time: number) => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);

function inSession(time: number, data: FuturesEntryInput) {
  const date = data.date.replaceAll("-", "");
  if (!/^\d{8}$/.test(date)) return false;
  const startDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
  const start = Date.parse(`${startDate}T${data.symbol === "TXF1" ? "08:45" : "15:00"}:00+08:00`);
  if (!Number.isFinite(start) || dateInTaipei(start) !== startDate) return false;
  const end = start + (data.symbol === "TXF1" ? 5 : 14) * 3600_000;
  return Number.isFinite(time) && time >= start && time < end;
}

/** Require all five observed minutes; never fill gaps or use an unfinished bucket. */
export function completedFuturesEntryBars(data: FuturesEntryInput, now: number) {
  const groups = new Map<number, Map<number, FuturesPhoneInputBar>>();
  const invalid = new Set<number>();
  for (const bar of data.bars) {
    const time = Date.parse(bar.time);
    if (!inSession(time, data)) continue;
    const bucket = Math.floor(time / PERIOD) * PERIOD;
    if (![bar.open, bar.high, bar.low, bar.close].every(positive) ||
        bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) ||
        bar.low > bar.high || time % MINUTE !== 0) {
      invalid.add(bucket);
      continue;
    }
    const group = groups.get(bucket) ?? new Map<number, FuturesPhoneInputBar>();
    if (group.has(time)) invalid.add(bucket);
    group.set(time, bar);
    groups.set(bucket, group);
  }
  return [...groups.entries()]
    .filter(([bucket, rows]) => !invalid.has(bucket) && bucket + PERIOD <= now &&
      rows.size === 5 && Array.from({ length: 5 }, (_, i) => bucket + i * MINUTE).every(t => rows.has(t)))
    .sort(([a], [b]) => a - b)
    .map(([bucket, rows]) => {
      const bars = [...rows.entries()].sort(([a], [b]) => a - b).map(([, bar]) => bar);
      return {
        time: new Date(bucket).toISOString(), open: bars[0]!.open,
        high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)),
        close: bars[4]!.close,
      };
    });
}

export function calculateFuturesEntryPoints(data: FuturesEntryInput, now = Date.now()): FuturesEntryResult {
  const result: FuturesEntryResult = {
    state: "unavailable", reason: "", source: data.source, asOf: data.asOf,
    signalAt: null, completedBars: 0, support: null, resistance: null, keyPrice: null,
    atr14: null,
    maxChase: null, scenarios: [],
  };
  const block = (state: FuturesEntryResult["state"], reason: string) => ({ ...result, state, reason });
  if (!["TXF1", "TXF8"].includes(data.symbol ?? "") || data.status === "unavailable") {
    return block("unavailable", "尚無可驗證的本盤別資料，不提供出擊點。");
  }
  if (!/分 K：Yuanta SPARK/u.test(data.source)) {
    return block("unavailable", "Yuanta SPARK 本盤分鐘 K 暫不可用；不使用其他來源代替盤中風險判斷。");
  }
  if (data.status === "closed") return block("closed", "目前休市／待開盤；不沿用上個盤別的進場訊號。");
  const quoteAt = data.asOf ? Date.parse(data.asOf) : NaN;
  if (!positive(data.price) || !Number.isFinite(quoteAt) || !inSession(quoteAt, data) ||
      !inSession(now, data) || now - quoteAt > 180_000 || now - quoteAt < -60_000) {
    return block("stale", "報價未通過本盤別與 3 分鐘新鮮度驗證，暫停出擊判斷。");
  }
  const bars = completedFuturesEntryBars(data, now);
  result.completedBars = bars.length;
  const tail = bars.slice(-22);
  if (tail.length < 22) return block("warming_up", `已取得 ${bars.length} 根完整 5 分 K；需至少連續 22 根（110 分鐘），不補造缺漏資料。`);
  if (tail.some((bar, i) => i > 0 && Date.parse(bar.time) - Date.parse(tail[i - 1]!.time) !== PERIOD)) {
    return block("warming_up", "最近 22 根 5 分 K 有缺漏，等待連續資料，不把不完整觀測當作完整走勢。");
  }
  const last = tail[21]!;
  const setup = tail[20]!;
  const closedAt = Date.parse(last.time) + PERIOD;
  if (now - closedAt > PERIOD || quoteAt < closedAt - MINUTE) {
    return block("stale", "已完成的 5 分 K 或最新報價未對齊，不沿用舊出擊點。");
  }
  const history = tail.slice(0, 20);
  const support = Math.min(...history.map(b => b.low));
  const resistance = Math.max(...history.map(b => b.high));
  const keyPrice = history.reduce((sum, b) => sum + b.close, 0) / history.length;
  const trueRanges = tail.slice(1).map((bar, i) =>
    Math.max(bar.high - bar.low, Math.abs(bar.high - tail[i]!.close), Math.abs(bar.low - tail[i]!.close)));
  // Simple mean of 14 true ranges, explicitly a 5-minute ATR, NOT daily ATR.
  const atr14 = trueRanges.slice(-14).reduce((sum, n) => sum + n, 0) / 14;
  if (!positive(atr14)) return block("warming_up", "觀測波幅不足，暫不推算風險距離。");
  const buffer = Math.max(1, Math.ceil(atr14 * 0.1));
  const maxChase = Math.max(1, Math.floor(atr14 * 0.25));
  Object.assign(result, { support, resistance, keyPrice, atr14, maxChase, signalAt: new Date(closedAt).toISOString() });
  const up = last.close > last.open && last.close > setup.high;
  const down = last.close < last.open && last.close < setup.low;
  const specs = [
    { id: "support_bounce", title: "支撐止跌做多", direction: "long" as const, level: support,
      confirmed: setup.low <= support + maxChase && setup.low >= support - buffer && up && last.close > support,
      condition: "回測前 20 根低點附近，守住支撐後，下一根紅 K 收盤突破回測 K 高點。" },
    { id: "key_reclaim", title: "站回關鍵價做多", direction: "long" as const, level: keyPrice,
      confirmed: setup.open <= keyPrice && setup.close > keyPrice && last.low >= keyPrice - buffer && up,
      condition: "回測 K 由下向上站回 20 根均價，下一根守住均價並收盤突破回測 K 高點。" },
    { id: "resistance_reject", title: "壓力受阻做空", direction: "short" as const, level: resistance,
      confirmed: setup.high >= resistance - maxChase && setup.high <= resistance + buffer && down && last.close < resistance,
      condition: "反彈至前 20 根高點附近、未有效突破，下一根黑 K 收盤跌破反彈 K 低點。" },
    { id: "key_breakdown", title: "跌破關鍵價做空", direction: "short" as const, level: keyPrice,
      confirmed: setup.open >= keyPrice && setup.close < keyPrice && last.high <= keyPrice + buffer && down,
      condition: "回測 K 由上向下跌破 20 根均價，下一根未站回均價並收盤跌破回測 K 低點。" },
  ];
  const recentObservedBars = data.bars.filter(bar => {
    const time = Date.parse(bar.time);
    return time >= Date.parse(setup.time) && time <= quoteAt && inSession(time, data) &&
      time % MINUTE === 0 &&
      [bar.open, bar.high, bar.low, bar.close].every(positive) &&
      bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close);
  });
  result.scenarios = specs.map(spec => {
    const base: FuturesEntryScenario = {
      id: spec.id, title: spec.title, direction: spec.direction, level: spec.level,
      status: "waiting", condition: spec.condition,
      evidence: "尚未同時滿足位置與兩根已完成 K 棒確認；不只因價格靠近就進場。",
      entry: null, stop: null, target: null, riskPoints: null, rewardRisk: null,
    };
    if (!spec.confirmed) {
      const tolerance = maxChase + buffer;
      const reachedByQuote = Math.abs(data.price! - spec.level) <= tolerance;
      const reachedByRecentBar = recentObservedBars.some(bar =>
        bar.low <= spec.level + tolerance && bar.high >= spec.level - tolerance);
      const levelReached = reachedByQuote || reachedByRecentBar;
      return levelReached ? {
        ...base,
        status: "level_reached",
        evidence: `現價或最近 1 分 K 已觸及參考位 ±${tolerance} 點範圍；仍需完成回測與下一根 5 分 K 確認，未確認前不提供觸發價。`,
      } : base;
    }
    const long = spec.direction === "long";
    const entry = long ? Math.ceil(last.high) + 1 : Math.floor(last.low) - 1;
    const stop = long ? Math.floor(Math.min(setup.low, last.low)) - buffer : Math.ceil(Math.max(setup.high, last.high)) + buffer;
    const riskPoints = Math.abs(entry - stop);
    const target = long ? entry + 3 * riskPoints : entry - 3 * riskPoints;
    if (!positive(stop) || !positive(target)) return base;
    const moved = long ? data.price! - entry : entry - data.price!;
    const afterConfirmation = data.bars.filter(bar => {
      const time = Date.parse(bar.time);
      return time >= closedAt && time <= quoteAt && inSession(time, data) &&
        [bar.open, bar.high, bar.low, bar.close].every(positive) &&
        bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close);
    });
    const invalidated = long
      ? data.price! <= stop || afterConfirmation.some(bar => bar.low <= stop)
      : data.price! >= stop || afterConfirmation.some(bar => bar.high >= stop);
    const status: FuturesEntryScenario["status"] = invalidated ? "invalidated" :
      riskPoints > atr14 ? "risk_too_wide" : moved > maxChase ? "missed" :
      moved < 0 || quoteAt < closedAt ? "armed" : "ready";
    return {
      ...base, status, entry, stop, target, riskPoints, rewardRisk: 3,
      evidence: status === "invalidated" ? "現價已穿越停損參考，原條件失效；不可直接反手。" :
        status === "risk_too_wide" ? "結構停損距離大於一個 5 分 ATR，暫不出擊，也不縮小停損迎合進場。" :
        status === "missed" ? `現價已超出觸發價 ${maxChase} 點，不追價，等待新一輪確認。` :
        status === "armed" ? "位置與收 K 確認成立，等待現價穿越觸發價；尚未觸發。" :
        "位置、收 K 確認與最新報價皆符合；僅為規則條件成立，不是保證成交或獲利。",
    };
  });
  result.state = result.scenarios.some(s => s.status === "ready") ? "ready" : "watching";
  result.reason = result.state === "ready" ? "出擊條件成立；下單前仍須核對即時價、滑價與個人風險上限。" :
    result.scenarios.some(s => s.status === "level_reached")
      ? "已有情境觸及參考位，仍須等待完成的 5 分 K 確認；碰價本身不代表可進場。"
      : "等待位置、收 K 與觸發價一致；不追高、不追空。";
  return result;
}
