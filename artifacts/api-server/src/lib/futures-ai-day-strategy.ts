import { createHash } from "node:crypto";
import {
  MarketDataError,
  getMarketQuotes,
  getTaiexHistory,
  type MarketQuoteData,
} from "./market-data.js";
import type { FuturesAiDayStrategy } from "@workspace/api-zod";
import type {
  AggressiveFuturesStrategyId,
  PaperFuturesEntryMode,
  PaperFuturesStopLossOutcome,
} from "@workspace/db";
import {
  AiProviderFallbackError,
  hasAiProviderCredentials,
  withAiProviderFallback,
} from "./ai-provider-fallback.js";
import type { AiProviderName, AiProviderResult } from "./ai-provider-fallback.js";
import { simplifyFinancialLanguage } from "./financial-language.js";
import { PAPER_FORCE_ENTRY_MIN_TARGET_POINTS } from "./paper-trading-automation-rules.js";
import {
  areQuotesSynchronized,
  FUTURES_MIN_REWARD_RISK,
  FUTURES_MIN_TARGET_POINTS,
  hasBreakoutRetestConfirmation,
  hasDirectionalQuoteAgreement,
  isFreshIntradayTaiexQuote,
  isFreshMarketQuote,
  isValidFuturesEntryPlan,
  qualifiesFuturesEntryMode,
  resolveFuturesEntryPlan,
  sameQuoteSnapshot,
} from "./futures-ai-day-strategy-guards.js";
import { fetchFuturesDayIntraday } from "./futures-day-intraday.js";
import { analyzeFuturesNightEvidence } from "./futures-night-strategy-evidence.js";
import { resolveFuturesSession } from "./futures-session.js";
import {
  AGGRESSIVE_FUTURES_STRATEGIES,
  qualifiesAggressiveFuturesStrategy,
  type AggressiveFuturesStrategy,
} from "./adaptive-futures-strategy.js";

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const STRATEGY_CACHE_MS = 5 * 60_000;
const MAX_STRATEGY_CACHE_ENTRIES = 32;
const DISCLAIMER =
  "期貨價格波動快，可能放大損失。本內容依指定時段的有效行情整理，只供參考，不是個人化投資建議，也不保證獲利。";
const NIGHT_STRATEGY_INSTRUCTIONS = [
  "你是臺指期夜盤短線分析助手，只分析目前 TXF8 夜盤，不使用日盤 AI 策略、日盤 K 線、加權指數或其他時段資料。",
  "只使用輸入的 Yuanta SPARK TXF8 新鮮報價、同一夜盤連續完成的一分與五分 OHLC，以及伺服器依夜盤 K 線計算的 EMA5、EMA13、一分 ATR14、方向與進場確認。不可補造新聞、成交量、買賣盤或價格結構。",
  "planDirection 必須等於證據方向；方向為 null 時不應呼叫 AI。action 只有在方向存在、夜盤進場確認成立、停利距離與風險報酬門檻通過時才可選 long 或 short，否則選 wait；不要猜方向或因每小時目標而強迫進場。",
  "只提供一組主方案。已確認進場時 entryPrice 必須等於最新 TXF8 價格；尚未確認時 entryPrice 必須等於夜盤證據提供的條件價。停損與停利必須依輸入夜盤 K 線結構設定，且順序須符合方向。",
  "summary 與 riskNote 使用繁體中文，不含阿拉伯數字或精確價位，不得寫買賣命令、保證獲利或勝率；價格理由只能引用輸入中可核對的夜盤依據。這是紙上模擬研究，不代表真實下單或成交。",
].join(" ");
const STRATEGY_INSTRUCTIONS = [
  "你是台灣加權指數期貨的日盤短線分析助手，只分析日盤當沖，不建議留倉過夜。",
  "只能使用輸入的 TAIFEX 或 Yuanta SPARK 期貨報價、具來源標示的日盤一分 OHLC、TAIFEX 官方 TX 日盤日線及其日 ATR14/4、由一分 OHLC 計算的 KD、加權指數報價及加權指數官方日線；不可補造新聞、價格、成交量、波動或不存在的價格結構。",
  "日盤一分 OHLC 若來自 SPARK，使用提供的一分 K 線；若來自 TAIFEX，僅涵蓋伺服器連線後實際觀測到的成交。若 K、D 或交叉訊號不足，不能推測 KD 訊號。若有黃金／死亡交叉，只能視為短線觀察訊號，仍需和日盤期指漲跌方向、加權指數方向及近期日線一起判斷；沒有交叉不可宣稱出現交叉。期指漲跌點數與百分比依報價來源提供的參考價計算，不等於短線趨勢，不可單獨決定方向。沒有期貨成交量或買賣盤。",
  "只提供一組主方案，不得同時列做多與做空兩套。只要有新鮮日盤期指即時價，無論 action 為何都必須提供 planDirection、單一 entryPrice、stopLossPrice、targetPrice 及各自理由；不可因低風險門檻未達或訊號未確認而把方案欄位設為 null。若證據不足，選目前較有依據的一側作條件式參考方案，明確說明不代表可立即進場。",
  "避免追逐單根長紅／長黑或突然放大的波動；進場方向仍須有可核對的即時期貨與加權指數依據，不得猜方向。",
  "若應等待確認，action 選 wait，planDirection 只選目前證據較支持的一個方向，entryPrice 是單一條件觸發價，不可把條件價冒稱現價。任何條件式方案都要具體給進場、停損、停利價；用數據不足作理由時，仍須把方案標示為主觀參考而不是合格低風險方案。",
  "價位理由只能說明輸入中可核對的依據，不得宣稱成交量或買賣盤訊號。此判讀只供日盤短線參考，不代表實際下單、成交或保證結果。",
  "夜盤報價只作背景，不得當成目前日盤成交。若日盤行情不明確、個股以外的市場資料互相矛盾或資料不足，action 選 wait 或 insufficient。",
  "不要因單一最新期指報價上漲就選 long，也不要因單一報價下跌就選 short；比較日盤期指與加權指數報價、近期加權指數 20／60 日走勢。只有多項可用資料方向相符時才選 long 或 short；若只有一筆報價可用、方向互相矛盾或日盤價格不新，選 wait／insufficient，不要硬湊方向。",
  "summary 只說明資料觀察，不可寫操作命令。action 必須由你依現有資料選出 long、short、wait 或 insufficient；伺服器會依 action 組合操作建議、條件與下一步，不會直接展示自由文字指令。",
  "riskNote 只說明行情資料限制或主要風險，不可包含買賣指令。價位理由需短、白話、繁體中文；不得宣稱勝率、保證獲利或適合任何特定使用者。summary 和 riskNote 不得包含阿拉伯數字或精確價位。",
].join(" ");
const STANDARD_PLAN_INSTRUCTIONS =
  `停損優先依可見的一分 OHLC 失效結構設定；資料不足時可參考官方日 ATR14/4 與最近完整日 K，但不得編造支撐壓力。停利目標盡量至少 ${FUTURES_MIN_TARGET_POINTS} 點；若市場結構支持的距離較短，仍提供結構位並說明未達門檻。風險報酬至少 ${FUTURES_MIN_REWARD_RISK}:1 是低風險參考門檻，不是隱藏方案的理由；未達時 action 必須為 wait，並在 riskNote 說明。long 須 stopLossPrice < entryPrice < targetPrice；short 須 targetPrice < entryPrice < stopLossPrice。`;
const FORCED_PAPER_PLAN_INSTRUCTIONS =
  `強制進場紙上模擬的停利目標至少 ${PAPER_FORCE_ENTRY_MIN_TARGET_POINTS} 點，可高於此距離且不設上限；不必為符合一般模式的 ${FUTURES_MIN_TARGET_POINTS} 點或 ${FUTURES_MIN_REWARD_RISK}:1 而拉遠目標。停損仍依可見價格結構設定，不得為了增加成交而刻意縮窄；單口風險超過帳戶單筆風險額度時仍不進場。`;
const ENTRY_MODE_INSTRUCTIONS: Record<PaperFuturesEntryMode, string> = {
  aggressive:
    "目前是積極模式，使用指定候選策略進行紙上前向測試；可不等待突破回測，但不得猜測方向。保留新鮮行情、有效結構停損、方向確認及帳戶風控；每小時 3 次只是目標，不得為湊次數強迫進場。",
  convergent:
    "目前是收斂模式。只有完整日盤資料齊全、期指與加權指數同向、停利至少 150 點、風險報酬達 2:1，且有兩根完成的一分 K 突破回測確認時，才可提供立即進場方向；任何條件不足都選 wait 或 insufficient。",
};
const FORCED_PAPER_ENTRY_INSTRUCTIONS =
  "目前是強制現價進場的紙上模擬模式。只有 action 明確為 long 或 short 時，才能按 AI 判斷的方向評估進場；action 為 wait 或 insufficient 一律不進場。尚未突破回測或期指與加權不同向時，可按最新價評估，但不得猜方向、使用過期行情或忽略單口風險額度、持倉上限和每日停損。每小時 3 次仍是努力目標，不得為湊次數超過風險額度或強迫進場。";

export type FuturesStrategyAdjustmentFeedback = {
  consecutiveStopLosses: number;
  recentStopLosses: PaperFuturesStopLossOutcome[];
  strategyTrials?: Array<{
    strategyId: AggressiveFuturesStrategyId;
    closedTrades: number;
    wins: number;
    losses: number;
    rawWinRatePercent: number | null;
    realizedPnl: number;
  }>;
};

function strategyInstructions(
  entryMode: PaperFuturesEntryMode,
  forceEntryMode: boolean,
  adjustmentFeedback?: FuturesStrategyAdjustmentFeedback,
  aggressiveStrategy?: AggressiveFuturesStrategy,
): string {
  const adjustmentInstructions = adjustmentFeedback
    ? "這是帳戶連續停損後的紙上策略重新評估。檢視近期停損與各候選策略已記錄的紙上結果，再結合當前市場證據判斷；樣本不足時不可宣稱哪一套更好。不可照抄舊方向或舊價位，不可為避免停損而任意放寬停損，也不可降低風險控管。若證據不支持多空方向，action 必須為 wait 或 insufficient。這是重新分析，不保證之後獲利。"
    : "";
  return [
    STRATEGY_INSTRUCTIONS,
    forceEntryMode
      ? FORCED_PAPER_PLAN_INSTRUCTIONS
      : aggressiveStrategy
        ? `積極測試候選「${aggressiveStrategy.label}」：停利至少 ${aggressiveStrategy.minimumTargetPoints} 點，風險報酬至少 ${aggressiveStrategy.minimumRewardRisk}:1；日線歷史可缺，但必須有新鮮同步的期貨與加權指數報價，以及有效的同時段盤中證據。停損依可見價格結構設定，不得縮窄停損迎合進場。`
        : STANDARD_PLAN_INSTRUCTIONS,
    forceEntryMode ? FORCED_PAPER_ENTRY_INSTRUCTIONS : ENTRY_MODE_INSTRUCTIONS[entryMode],
    entryMode === "convergent"
      ? "立即進場還須兩根連續完成的一分 K 突破回測確認；未成立就 wait。"
      : "",
    adjustmentInstructions,
  ].join(" ");
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["long", "short", "wait", "insufficient"],
    },
    planDirection: { type: "string", enum: ["long", "short"] },
    summary: { type: "string", maxLength: 110 },
    riskNote: { type: "string", maxLength: 180 },
    entryPrice: { type: "number", exclusiveMinimum: 0 },
    stopLossPrice: { type: "number", exclusiveMinimum: 0 },
    targetPrice: { type: "number", exclusiveMinimum: 0 },
    entryReason: { type: "string", maxLength: 160 },
    stopLossReason: { type: "string", maxLength: 160 },
    targetReason: { type: "string", maxLength: 160 },
  },
  required: [
    "action",
    "summary",
    "riskNote",
    "planDirection",
    "entryPrice",
    "stopLossPrice",
    "targetPrice",
    "entryReason",
    "stopLossReason",
    "targetReason",
  ],
} as const;

type StrategyOutput = {
  action: FuturesAiDayStrategy["action"];
  planDirection: "long" | "short";
  summary: string;
  riskNote: string;
  entryPrice: number;
  stopLossPrice: number;
  targetPrice: number;
  entryReason: string;
  stopLossReason: string;
  targetReason: string;
};

type EntryPlanFields = Pick<
  FuturesAiDayStrategy,
  | "entryPlanStatus"
  | "entryPlanMode"
  | "planDirection"
  | "entryPrice"
  | "stopLossPrice"
  | "targetPrice"
  | "entryReason"
  | "stopLossReason"
  | "targetReason"
  | "entryPlanMessage"
>;

const EMPTY_ENTRY_PLAN: EntryPlanFields = {
  entryPlanStatus: "unavailable",
  entryPlanMode: "reference",
  planDirection: null,
  entryPrice: null,
  stopLossPrice: null,
  targetPrice: null,
  entryReason: null,
  stopLossReason: null,
  targetReason: null,
  entryPlanMessage: "目前沒有通過即時報價與價位結構驗證的點位。",
};

type FuturesMarketQuoteKey = Extract<
  MarketQuoteData["key"],
  "taiex" | "futures_day" | "futures_night"
>;

const cachedStrategies = new Map<
  string,
  {
    expiresAt: number;
    result: FuturesAiDayStrategy;
    intradayFingerprint: string;
  }
>();

function unavailableQuote(
  key: FuturesMarketQuoteKey,
  name: string,
  ticker: string,
  error: string,
): MarketQuoteData {
  return {
    key,
    name,
    ticker,
    price: null,
    change: null,
    changePercent: null,
    source: null,
    asOf: null,
    available: false,
    error,
  };
}

function isTaipeiFuturesDaySessionOpen(now = Date.now()): boolean {
  const taipeiTime = new Date(now + TAIPEI_OFFSET_MS);
  const weekday = taipeiTime.getUTCDay();
  const minutes = taipeiTime.getUTCHours() * 60 + taipeiTime.getUTCMinutes();
  return weekday >= 1 && weekday <= 5 && minutes >= 8 * 60 + 45 && minutes < 13 * 60 + 45;
}

function emptyQuoteSet(error: string): MarketQuoteData[] {
  return [
    unavailableQuote("taiex", "加權指數", "^TWII", error),
    unavailableQuote("futures_day", "臺指期日盤", "TXF-F", error),
    unavailableQuote("futures_night", "臺指期夜盤", "TXF-M", error),
  ];
}

function quoteByKey(
  quotes: MarketQuoteData[],
  key: FuturesMarketQuoteKey,
): MarketQuoteData {
  const existing = quotes.find((quote) => quote.key === key);
  if (existing) return existing;
  const fallback = {
    taiex: ["加權指數", "^TWII"],
    futures_day: ["臺指期日盤", "TXF-F"],
    futures_night: ["臺指期夜盤", "TXF-M"],
  } as const;
  const [name, ticker] = fallback[key];
  return unavailableQuote(key, name, ticker, "行情來源未回傳此時段資料。");
}

function makeResult(
  fields: Pick<
    FuturesAiDayStrategy,
    | "status"
    | "action"
    | "summary"
    | "entryCondition"
    | "invalidationCondition"
    | "riskNote"
    | "aiProvider"
       >,
  dataCoverage: FuturesAiDayStrategy["dataCoverage"],
  dayQuote: MarketQuoteData,
  nightQuote: MarketQuoteData,
  taiexQuote: MarketQuoteData,
  entryPlan: EntryPlanFields = EMPTY_ENTRY_PLAN,
): FuturesAiDayStrategy {
  return {
    ...fields,
    ...entryPlan,
    dataCoverage,
    dayQuote,
    nightQuote,
    taiexQuote,
    analyzedAt: new Date(),
    disclaimer: DISCLAIMER,
  };
}

function staticUnavailableResult(
  status: "waiting_for_day_session" | "insufficient_data",
  action: "wait" | "insufficient",
  summary: string,
  riskNote: string,
  dataCoverage: FuturesAiDayStrategy["dataCoverage"],
  dayQuote: MarketQuoteData,
  nightQuote: MarketQuoteData,
  taiexQuote: MarketQuoteData,
): FuturesAiDayStrategy {
  const waitingForSession = status === "waiting_for_day_session";
  const entryPlanMessage = isFreshMarketQuote(dayQuote)
    ? "雖有即時期貨報價，但缺少足夠的同步指數或分時證據；不以不完整資料猜測點位。"
    : "目前沒有有效即時日盤報價；依設定不使用收盤或過期價格估點。";
  return makeResult(
    {
      status,
      action,
      summary,
      entryCondition: waitingForSession
        ? "下一個日盤開市並取得新成交後，再確認期指與加權指數方向是否一致；夜盤或舊價格不能當成買進／賣出依據。"
        : "等到可驗證的日盤成交和近期大盤日線恢復後，再重新分析；資料補齊前先不要交易。",
      invalidationCondition:
        "若期指與加權指數方向不一致，取消原本方向，當天不下單。",
      riskNote,
      aiProvider: null,
    },
    dataCoverage,
    dayQuote,
    nightQuote,
    taiexQuote,
    {
      ...EMPTY_ENTRY_PLAN,
      entryPlanMessage,
    },
  );
}

function normalizeOutput(value: unknown): StrategyOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const validActions = new Set(["long", "short", "wait", "insufficient"]);
  if (typeof record.action !== "string" || !validActions.has(record.action)) {
    return null;
  }

  const normalizeNarrative = (
    field: unknown,
    fallback: string,
    maxLength: number,
    forbidden: RegExp,
  ): string => {
    if (typeof field !== "string") return fallback;
    const text = simplifyFinancialLanguage(field).trim();
    if (!text || /\d/.test(text) || forbidden.test(text)) return fallback;
    return text.slice(0, maxLength);
  };
  const normalizeReason = (field: unknown): string | null => {
    if (field === null) return null;
    if (typeof field !== "string") return null;
    const text = simplifyFinancialLanguage(field).slice(0, 160);
    return text || null;
  };
  const normalizePrice = (field: unknown): number | null =>
    typeof field === "number" && Number.isFinite(field) && field > 0
      ? field
      : null;
  const planDirection =
    record.planDirection === "long" || record.planDirection === "short"
      ? record.planDirection
      : null;
  const entryPrice = normalizePrice(record.entryPrice);
  const stopLossPrice = normalizePrice(record.stopLossPrice);
  const targetPrice = normalizePrice(record.targetPrice);
  const entryReason = normalizeReason(record.entryReason);
  const stopLossReason = normalizeReason(record.stopLossReason);
  const targetReason = normalizeReason(record.targetReason);
  const summary = normalizeNarrative(
    record.summary,
    "盤中方向仍需價格結構與指數同步確認。",
    110,
    /(操作建議|下一步|建議|買進|買入|賣出|加碼|減碼|下單|進場)/u,
  );
  const riskNote = normalizeNarrative(
    record.riskNote,
    "期貨波動快，停損可能滑價；方案不保證成交或獲利。",
    180,
    /(操作建議|下一步|建議你|應該|買進|買入|賣出|加碼|減碼|下單|進場)/u,
  );
  const completePlan =
    (record.planDirection === "long" || record.planDirection === "short") &&
    entryPrice !== null &&
    stopLossPrice !== null &&
    targetPrice !== null &&
    entryReason !== null &&
    stopLossReason !== null &&
    targetReason !== null;
  if (
    !completePlan ||
    ((record.action === "long" || record.action === "short") &&
      planDirection !== record.action) ||
    !summary ||
    !riskNote
  ) {
    return null;
  }

  return {
    action: record.action as StrategyOutput["action"],
    planDirection: planDirection!,
    summary,
    riskNote,
    entryPrice: entryPrice!,
    stopLossPrice: stopLossPrice!,
    targetPrice: targetPrice!,
    entryReason: entryReason!,
    stopLossReason: stopLossReason!,
    targetReason: targetReason!,
  };
}

function parseStrategyOutput(text: string | null): StrategyOutput | null {
  if (!text) return null;
  try {
    return normalizeOutput(JSON.parse(text));
  } catch {
    return null;
  }
}

function composeStrategyGuidance(
  action: StrategyOutput["action"],
  explanation: string,
  currentPrice?: number,
  conditionalPlan?: {
    direction: "long" | "short";
    entryPrice: number;
  },
): Pick<
  FuturesAiDayStrategy,
  "summary" | "entryCondition" | "invalidationCondition"
> {
  const guidance = {
    long: {
      action: "只評估這一組做多方案；突破回測確認且期指與加權指數同步向上時才考慮。",
      entry: "先等一分 K 向上突破進場價，下一根回測守住並收回其上，且加權指數同步向上；否則不進場。",
      cancel: "回測跌破進場條件、任一行情轉弱或兩者方向不同，取消做多方案。",
    },
    short: {
      action: "只評估這一組做空方案；跌破反彈確認且期指與加權指數同步向下時才考慮。",
      entry: "先等一分 K 向下跌破進場價，下一根反彈受阻並收在其下，且加權指數同步向下；否則不進場。",
      cancel: "反彈站回進場條件、任一行情轉強或兩者方向不同，取消做空方案。",
    },
    wait: {
      action: "現在先不交易；等日盤新成交與加權指數方向一致後再重新分析。",
      entry: "目前不買賣；取得新日盤成交並確認兩者方向一致後再重新分析。",
      cancel: "若下一筆有效行情仍不同向，當天不交易。",
    },
    insufficient: {
      action: "資料不足，現在先不交易；等有效日盤成交與近期大盤資料恢復後再分析。",
      entry: "補齊有效日盤成交與近期大盤資料後，再重新分析是否買賣。",
      cancel: "若資料仍未補齊，當天不交易。",
    },
  }[action];
  const currentPriceEntry =
    currentPrice === undefined
      ? null
      : action === "long"
        ? `本次即時價 ${currentPrice} 點已通過突破回測與指數同向確認；若新行情轉弱或失去同步，就不追進。`
        : action === "short"
          ? `本次即時價 ${currentPrice} 點已通過跌破反彈與指數同向確認；若新行情轉強或失去同步，就不追進。`
          : null;
  const conditionalEntry =
    conditionalPlan && (action === "wait" || action === "insufficient")
      ? conditionalPlan.direction === "long"
        ? `先不按現價進場；等一分 K 突破 ${conditionalPlan.entryPrice} 點，下一根回測守住並收回其上，且加權指數同步向上，再評估做多。`
        : `先不按現價進場；等一分 K 跌破 ${conditionalPlan.entryPrice} 點，下一根反彈受阻並收在其下，且加權指數同步向下，再評估做空。`
      : null;
  return {
    summary: `操作建議：${guidance.action} 市場依據：${explanation}`,
    entryCondition: currentPriceEntry ?? conditionalEntry ?? guidance.entry,
    invalidationCondition: guidance.cancel,
  };
}

function providerError(error: unknown): MarketDataError {
  if (error instanceof AiProviderFallbackError) {
    return new MarketDataError(error.message, error.status);
  }
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : null;
  if (status === 429) {
    return new MarketDataError("AI 分析目前忙碌，請稍後再試。", 429);
  }
  if (status === 401 || status === 403) {
    return new MarketDataError("AI 分析暫時無法使用，請稍後再試。", 502);
  }
  return new MarketDataError("AI 分析暫時無法使用，請稍後再試。", 502);
}

async function getFuturesAiNightStrategy(input: {
  dayQuote: MarketQuoteData;
  nightQuote: MarketQuoteData;
  taiexQuote: MarketQuoteData;
  entryMode: PaperFuturesEntryMode;
  forceEntryMode: boolean;
  adjustmentFeedback?: FuturesStrategyAdjustmentFeedback;
  aggressiveStrategy?: AggressiveFuturesStrategy;
  session: ReturnType<typeof resolveFuturesSession>;
}): Promise<FuturesAiDayStrategy> {
  const {
    dayQuote,
    nightQuote,
    taiexQuote,
    entryMode,
    forceEntryMode,
    adjustmentFeedback,
    aggressiveStrategy,
    session,
  } = input;
  let intraday: Awaited<ReturnType<typeof fetchFuturesDayIntraday>> | null = null;
  try {
    intraday = await fetchFuturesDayIntraday();
  } catch {
    // The evidence check below returns a clear unavailable result.
  }
  const evidenceResult = analyzeFuturesNightEvidence({
    bars: intraday?.bars ?? [],
    price: nightQuote.price,
    quoteAsOf: nightQuote.asOf,
    source: intraday?.source ?? "",
    session,
  });
  if (
    !evidenceResult.available ||
    !isFreshMarketQuote(nightQuote) ||
    nightQuote.ticker !== "TXF8" ||
    !nightQuote.source?.includes("Yuanta SPARK")
  ) {
    const reason = !evidenceResult.available
      ? evidenceResult.reason
      : "TXF8 夜盤報價不是新鮮的 Yuanta SPARK 報價。";
    return makeResult(
      {
        status: "insufficient_data",
        action: "insufficient",
        summary: "操作建議：夜盤資料未通過完整性檢查，暫不納入紙上模擬。",
        entryCondition: reason,
        invalidationCondition: "取得有效 TXF8 夜盤報價與同一夜盤完整分 K 後，再重新分析。",
        riskNote: "不以日盤 K 線或其他時段行情代替夜盤資料。",
        aiProvider: null,
      },
      "unavailable",
      dayQuote,
      nightQuote,
      taiexQuote,
      { ...EMPTY_ENTRY_PLAN, entryPlanMessage: reason },
    );
  }

  const evidence = evidenceResult.evidence;
  if (evidence.direction === null || evidence.entryLevel === null) {
    return makeResult(
      {
        status: "insufficient_data",
        action: "wait",
        summary: "操作建議：夜盤五分趨勢尚未形成明確方向，暫不模擬進場。",
        entryCondition: evidence.reason,
        invalidationCondition: "等待 TXF8 夜盤五分趨勢明確後重新判斷。",
        riskNote: "趨勢未分方向，不猜測多空。",
        aiProvider: null,
      },
      "quote_only",
      dayQuote,
      nightQuote,
      taiexQuote,
    );
  }

  const feedbackKey = adjustmentFeedback
    ? createHash("sha256").update(JSON.stringify(adjustmentFeedback)).digest("hex").slice(0, 20)
    : "base";
  const strategyCacheKey = `TXF8:${entryMode}:${forceEntryMode ? "forced" : "standard"}:${aggressiveStrategy?.id ?? "default"}:${feedbackKey}`;
  const intradayFingerprint = [
    session.date,
    evidence.minuteBars.at(-1)?.time ?? "",
    evidence.trendBars.at(-1)?.time ?? "",
    evidence.direction,
    evidence.entryConfirmed,
    evidence.ema5.toFixed(2),
    evidence.ema13.toFixed(2),
    evidence.atr14.toFixed(2),
  ].join(":");
  const cachedStrategy = cachedStrategies.get(strategyCacheKey);
  if (
    cachedStrategy &&
    cachedStrategy.expiresAt > Date.now() &&
    sameQuoteSnapshot(cachedStrategy.result.dayQuote, dayQuote) &&
    sameQuoteSnapshot(cachedStrategy.result.nightQuote, nightQuote) &&
    sameQuoteSnapshot(cachedStrategy.result.taiexQuote, taiexQuote) &&
    cachedStrategy.intradayFingerprint === intradayFingerprint
  ) {
    return cachedStrategy.result;
  }
  if (!hasAiProviderCredentials()) {
    throw new MarketDataError("尚未設定可用的 AI 供應商 API 憑證，無法使用 AI 期貨分析。", 502);
  }

  const lastTwo = evidence.minuteBars.slice(-2);
  const last = lastTwo.at(-1);
  const previous = lastTwo.at(-2);
  const retestConfirmed = Boolean(
    previous && last &&
    Date.parse(last.time) - Date.parse(previous.time) === 60_000 &&
    (evidence.direction === "long"
      ? previous.close > evidence.entryLevel &&
        previous.close > previous.open &&
        last.low <= evidence.entryLevel &&
        last.close > evidence.entryLevel &&
        last.close > last.open
      : previous.close < evidence.entryLevel &&
        previous.close < previous.open &&
        last.high >= evidence.entryLevel &&
        last.close < evidence.entryLevel &&
        last.close < last.open),
  );
  const modeConfirmation = entryMode === "aggressive"
    ? evidence.entryConfirmed
    : evidence.entryConfirmed && retestConfirmed;
  const marketContext = {
    session: { symbol: "TXF8", label: "夜盤", date: session.date },
    quote: {
      price: nightQuote.price,
      source: nightQuote.source,
      asOf: nightQuote.asOf?.toISOString() ?? null,
    },
    evidence: {
      direction: evidence.direction,
      entryLevel: evidence.entryLevel,
      entryConfirmed: evidence.entryConfirmed,
      retestConfirmed,
      modeConfirmation,
      ema5: evidence.ema5,
      ema13: evidence.ema13,
      atr14: evidence.atr14,
      maxEntryDistance: evidence.maxEntryDistance,
      minuteBars: evidence.minuteBars,
      trendBars: evidence.trendBars,
    },
    ...(adjustmentFeedback
      ? {
          recentPaperTradeOutcomes: {
            consecutiveStopLosses: adjustmentFeedback.consecutiveStopLosses,
            stopLosses: adjustmentFeedback.recentStopLosses.slice(-3),
            strategyTrials: adjustmentFeedback.strategyTrials ?? [],
          },
        }
      : {}),
    mode: entryMode,
    aggressiveStrategy: aggressiveStrategy
      ? {
          id: aggressiveStrategy.id,
          minimumTargetPoints: aggressiveStrategy.minimumTargetPoints,
          minimumRewardRisk: aggressiveStrategy.minimumRewardRisk,
        }
      : null,
    forcedPaperEntry: forceEntryMode,
    limits: {
      minimumTargetPoints: forceEntryMode
        ? PAPER_FORCE_ENTRY_MIN_TARGET_POINTS
        : FUTURES_MIN_TARGET_POINTS,
      minimumRewardRisk: forceEntryMode ? null : FUTURES_MIN_REWARD_RISK,
    },
  };
  let aiResponse: AiProviderResult;
  try {
    aiResponse = await withAiProviderFallback({
      operation: "futures_night_strategy",
      allowedProviders: ["groq", "gemini", "openrouter"],
      instructions: [
        NIGHT_STRATEGY_INSTRUCTIONS,
        forceEntryMode
          ? `夜盤強制紙上進場的停利目標至少 ${PAPER_FORCE_ENTRY_MIN_TARGET_POINTS} 點；仍須以夜盤 K 線設停損並符合帳戶單筆風險上限。`
          : `夜盤方案停利目標至少 ${aggressiveStrategy?.minimumTargetPoints ?? FUTURES_MIN_TARGET_POINTS} 點、風險報酬至少 ${aggressiveStrategy?.minimumRewardRisk ?? FUTURES_MIN_REWARD_RISK}:1；未達任一門檻時只能等待，不可放寬帳戶風控。停損與停利只依夜盤完整 OHLC 結構，不使用官方日線 ATR。`,
        entryMode === "aggressive"
          ? "積極模式仍須夜盤方向與進場確認成立。"
          : "收斂模式除夜盤方向與進場確認外，還須通過兩根連續完成夜盤一分 K 的回測確認。",
        adjustmentFeedback
          ? "這是連續停損後的夜盤策略重新評估；可參考近期結果，但不得照抄舊方向或放寬風控。"
          : "",
      ],
      input: JSON.stringify(marketContext),
      schema: outputSchema,
      validateOutput: (text) => {
        const parsed = parseStrategyOutput(text);
        return parsed !== null &&
          parsed.planDirection === evidence.direction &&
          isValidFuturesEntryPlan({
            ...parsed,
            action: "wait",
            currentPrice: nightQuote.price,
          });
      },
      maxOutputTokens: 2048,
      timeoutMs: 5_000,
      groqTimeoutMs: 4_000,
      geminiTimeoutMs: 8_000,
      maxFallbackDurationMs: 10_000,
      openRouterTimeoutMs: 5_000,
    });
  } catch (error) {
    throw providerError(error);
  }
  const strategy = parseStrategyOutput(aiResponse.text);
  if (
    !strategy ||
    strategy.planDirection !== evidence.direction ||
    !isValidFuturesEntryPlan({
      ...strategy,
      action: "wait",
      currentPrice: nightQuote.price,
    })
  ) {
    throw new MarketDataError("AI 未提供符合 TXF8 夜盤證據的有效單一價位方案。", 502);
  }

  const expectedEntryPrice = evidence.entryConfirmed
    ? nightQuote.price!
    : evidence.entryLevel;
  if (Math.abs(strategy.entryPrice - expectedEntryPrice) > evidence.maxEntryDistance) {
    throw new MarketDataError("AI 夜盤進場價與已驗證的 TXF8 條件位差距過大。", 502);
  }
  const rewardPoints = evidence.direction === "long"
    ? strategy.targetPrice - strategy.entryPrice
    : strategy.entryPrice - strategy.targetPrice;
  const riskPoints = evidence.direction === "long"
    ? strategy.entryPrice - strategy.stopLossPrice
    : strategy.stopLossPrice - strategy.entryPrice;
  const rewardRisk = rewardPoints / riskPoints;
  const targetFloor = forceEntryMode
    ? PAPER_FORCE_ENTRY_MIN_TARGET_POINTS
    : aggressiveStrategy?.minimumTargetPoints ?? FUTURES_MIN_TARGET_POINTS;
  const meetsRiskThresholds =
    rewardPoints >= targetFloor &&
    (forceEntryMode ||
      rewardRisk >= (aggressiveStrategy?.minimumRewardRisk ?? FUTURES_MIN_REWARD_RISK));
  const qualified = modeConfirmation && meetsRiskThresholds;
  const action =
    qualified && strategy.action === evidence.direction
      ? strategy.action
      : strategy.action === "insufficient"
        ? "insufficient"
        : "wait";
  const directPlan = action === evidence.direction;
  const planPrice = directPlan ? nightQuote.price! : strategy.entryPrice;
  const planValid = isValidFuturesEntryPlan({
    ...strategy,
    action: "wait",
    currentPrice: nightQuote.price,
  });
  const result = makeResult(
    {
      status: "available",
      action,
      summary: `操作建議：${action === "long" ? "夜盤條件通過，僅評估做多" : action === "short" ? "夜盤條件通過，僅評估做空" : action === "insufficient" ? "AI 未能確認夜盤方案，暫不模擬" : "夜盤訊號未達進場條件，先等待"}。市場依據：${evidence.reason}`,
      entryCondition: directPlan
        ? "AI 夜盤方向、同時段分 K 與風險門檻均通過；若新行情轉弱或 K 線失去連續性，取消模擬進場。"
        : `等待 TXF8 夜盤價格與條件位重新確認；${entryMode === "convergent" ? "收斂模式另需完成一分 K 回測確認。" : "積極模式也須維持夜盤方向確認。"}`,
      invalidationCondition: "TXF8 夜盤方向改變、報價或分 K 過期、或觸及停損時，取消訊號或依帳戶規則模擬平倉。",
      riskNote: strategy.riskNote,
      aiProvider: aiResponse.provider,
    },
    "quote_only",
    dayQuote,
    nightQuote,
    taiexQuote,
    planValid
      ? {
          entryPlanStatus: "available",
          entryPlanMode: directPlan ? "current" : "conditional",
          planDirection: evidence.direction,
          entryPrice: planPrice,
          stopLossPrice: strategy.stopLossPrice,
          targetPrice: strategy.targetPrice,
          entryReason: strategy.entryReason,
          stopLossReason: strategy.stopLossReason,
          targetReason: strategy.targetReason,
          entryPlanMessage: directPlan
            ? `AI 夜盤方向與帳戶模式條件通過；停利 ${rewardPoints.toFixed(0)} 點，獲利風險比 ${rewardRisk.toFixed(1)}:1，仍受帳戶風控限制。`
            : `TXF8 夜盤條件方案暫不進場；${!modeConfirmation ? "夜盤進場／回測確認尚未完成。" : !meetsRiskThresholds ? "停利或風險報酬未達門檻。" : "AI 判斷等待，沒有可執行訊號。"}`,
        }
      : { ...EMPTY_ENTRY_PLAN, entryPlanMessage: "TXF8 夜盤價位方案未通過驗證，暫不模擬進場。" },
  );
  for (const [key, cached] of cachedStrategies) {
    if (cached.expiresAt <= Date.now()) cachedStrategies.delete(key);
  }
  while (cachedStrategies.size >= MAX_STRATEGY_CACHE_ENTRIES) {
    const oldestKey = cachedStrategies.keys().next().value;
    if (oldestKey === undefined) break;
    cachedStrategies.delete(oldestKey);
  }
  cachedStrategies.set(strategyCacheKey, {
    expiresAt: Date.now() + STRATEGY_CACHE_MS,
    result,
    intradayFingerprint,
  });
  return result;
}

export async function getFuturesAiDayStrategy(
  entryMode: PaperFuturesEntryMode = "convergent",
  forceEntryMode = false,
  adjustmentFeedback?: FuturesStrategyAdjustmentFeedback,
  adaptiveStrategyId?: AggressiveFuturesStrategyId,
): Promise<FuturesAiDayStrategy> {
  const aggressiveStrategy = entryMode === "aggressive"
    ? AGGRESSIVE_FUTURES_STRATEGIES.find((item) => item.id === adaptiveStrategyId) ??
      AGGRESSIVE_FUTURES_STRATEGIES[0]
    : undefined;
  let quotes: MarketQuoteData[];
  try {
    quotes = await getMarketQuotes();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "目前無法取得市場行情。";
    const [taiexQuote, dayQuote, nightQuote] = emptyQuoteSet(message);
    return staticUnavailableResult(
      "insufficient_data",
      "insufficient",
      "操作建議：目前沒有可核對的期指與大盤價格，現在先不交易；行情恢復後再重新分析。",
      "缺少可驗證的期指與大盤價格，不提供進場訊號。",
      "unavailable",
      dayQuote,
      nightQuote,
      taiexQuote,
    );
  }

  const dayQuote = quoteByKey(quotes, "futures_day");
  const nightQuote = quoteByKey(quotes, "futures_night");
  const taiexQuote = quoteByKey(quotes, "taiex");
  const session = resolveFuturesSession();
  if (session.active && session.symbol === "TXF8") {
    return getFuturesAiNightStrategy({
      dayQuote,
      nightQuote,
      taiexQuote,
      entryMode,
      forceEntryMode,
      adjustmentFeedback,
      aggressiveStrategy,
      session,
    });
  }
  if (!isTaipeiFuturesDaySessionOpen() || !isFreshMarketQuote(dayQuote)) {
    return staticUnavailableResult(
      "waiting_for_day_session",
      "wait",
      "操作建議：現在沒有最新日盤成交，不要依夜盤或舊價格下單；下一交易日日盤開市後，先確認新成交與加權指數方向，再決定是否買賣。",
      "夜盤和上一筆成交只作背景參考，不代表目前日盤價格。",
      dayQuote.available ? "quote_only" : "unavailable",
      dayQuote,
      nightQuote,
      taiexQuote,
    );
  }

  let futuresIntraday: Awaited<ReturnType<typeof fetchFuturesDayIntraday>> | null = null;
  let intradayFetchFailed = false;
  try {
    futuresIntraday = await fetchFuturesDayIntraday();
  } catch {
    intradayFetchFailed = true;
  }
  const intradayFingerprint = [
    futuresIntraday?.date ?? "unavailable",
    futuresIntraday?.bars.at(-1)?.time ?? "",
    futuresIntraday?.k?.toFixed(2) ?? "",
    futuresIntraday?.d?.toFixed(2) ?? "",
    futuresIntraday?.signal ?? "unavailable",
    futuresIntraday?.dailyHistory.asOf ?? "",
    futuresIntraday?.dailyHistory.atr14By4?.toFixed(2) ?? "",
  ].join(":");
  const hasIntradayEvidence =
    futuresIntraday?.status === "live" &&
    futuresIntraday.k !== null &&
    futuresIntraday.d !== null;
  const hasSynchronizedTaiexQuote =
    isFreshIntradayTaiexQuote(taiexQuote) &&
    areQuotesSynchronized(dayQuote, taiexQuote);

  const feedbackKey = adjustmentFeedback
    ? createHash("sha256").update(JSON.stringify(adjustmentFeedback)).digest("hex").slice(0, 20)
    : "base";
  const strategyCacheKey = `TXF1:${entryMode}:${forceEntryMode ? "forced" : "standard"}:${aggressiveStrategy?.id ?? "default"}:${feedbackKey}`;
  const cachedStrategy = cachedStrategies.get(strategyCacheKey);
  if (
    cachedStrategy &&
    cachedStrategy.expiresAt > Date.now() &&
    sameQuoteSnapshot(cachedStrategy.result.dayQuote, dayQuote) &&
    sameQuoteSnapshot(cachedStrategy.result.nightQuote, nightQuote) &&
    sameQuoteSnapshot(cachedStrategy.result.taiexQuote, taiexQuote) &&
    cachedStrategy.intradayFingerprint === intradayFingerprint
  ) {
    return cachedStrategy.result;
  }

  if (!hasAiProviderCredentials()) {
    throw new MarketDataError("尚未設定可用的 AI 供應商 API 憑證，無法使用 AI 期貨分析。", 502);
  }

  let indexHistory: Awaited<ReturnType<typeof getTaiexHistory>> | null = null;
  try {
    indexHistory = await getTaiexHistory("3mo");
  } catch {
    indexHistory = null;
  }
  const hasEnoughIndexHistory = (indexHistory?.bars.length ?? 0) >= 5;
  const hasDailyFuturesHistory =
    futuresIntraday?.dailyHistory.status === "available" &&
    futuresIntraday.dailyHistory.atr14By4 !== null;
  const hasCompleteContext =
    hasIntradayEvidence &&
    hasSynchronizedTaiexQuote &&
    hasEnoughIndexHistory &&
    hasDailyFuturesHistory;
  const limitations = [
    intradayFetchFailed ? "期貨一分資料暫不可用" : null,
    !hasIntradayEvidence ? "期貨一分 K／KD 尚未完整" : null,
    !hasSynchronizedTaiexQuote ? "沒有同步的新鮮加權指數盤中報價" : null,
    !hasEnoughIndexHistory ? "加權指數近期日線不足" : null,
    !hasDailyFuturesHistory ? "TAIFEX 官方期貨日線不足，日 ATR14/4 不可用" : null,
  ].filter((item): item is string => Boolean(item));

  const marketContext = {
    ...(adjustmentFeedback
      ? {
          recentPaperTradeOutcomes: {
            consecutiveStopLosses: adjustmentFeedback.consecutiveStopLosses,
            stopLosses: adjustmentFeedback.recentStopLosses.slice(-3).map((trade) => ({
              direction: trade.direction,
              entryPrice: trade.entryPrice,
              exitPrice: trade.exitPrice,
              stopLossPrice: trade.stopLossPrice,
              realizedPnl: trade.realizedPnl,
              asOf: trade.asOf,
            })),
            strategyTrials: adjustmentFeedback.strategyTrials ?? [],
          },
        }
      : {}),
    aggressiveStrategy: aggressiveStrategy
      ? {
          id: aggressiveStrategy.id,
          minimumTargetPoints: aggressiveStrategy.minimumTargetPoints,
          minimumRewardRisk: aggressiveStrategy.minimumRewardRisk,
          requireCompleteContext: aggressiveStrategy.requireCompleteContext,
        }
      : null,
    dayFuturesQuote: {
      ticker: dayQuote.ticker,
      price: dayQuote.price,
      change: dayQuote.change,
      changePercent: dayQuote.changePercent,
      referenceDirection: dayQuote.change === null
        ? "unavailable"
        : dayQuote.change > 0
          ? "up"
          : dayQuote.change < 0
            ? "down"
            : "flat",
      source: dayQuote.source,
      asOf: dayQuote.asOf?.toISOString() ?? null,
    },
    nightFuturesQuote: {
      ticker: nightQuote.ticker,
      price: nightQuote.price,
      change: nightQuote.change,
      changePercent: nightQuote.changePercent,
      source: nightQuote.source,
      asOf: nightQuote.asOf?.toISOString() ?? null,
      available: nightQuote.available,
    },
    taiexQuote: {
      price: hasSynchronizedTaiexQuote ? taiexQuote.price : null,
      change: hasSynchronizedTaiexQuote ? taiexQuote.change : null,
      changePercent: hasSynchronizedTaiexQuote ? taiexQuote.changePercent : null,
      source: hasSynchronizedTaiexQuote ? taiexQuote.source : null,
      asOf: hasSynchronizedTaiexQuote ? taiexQuote.asOf?.toISOString() ?? null : null,
      available: hasSynchronizedTaiexQuote,
    },
    taiexHistory: {
      source: indexHistory?.source ?? "近期日線暫不可用",
      asOf: indexHistory?.asOf.toISOString() ?? null,
      recentDailyBars: (indexHistory?.bars ?? []).slice(-20).map((bar) => ({
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    },
    futuresDailyHistory: {
      status: futuresIntraday?.dailyHistory.status ?? "unavailable",
      source: futuresIntraday?.dailyHistory.source ?? "TAIFEX 官方 TX 日盤歷史暫不可用",
      asOf: futuresIntraday?.dailyHistory.asOf ?? null,
      atr14: futuresIntraday?.dailyHistory.atr14 ?? null,
      atr14By4: futuresIntraday?.dailyHistory.atr14By4 ?? null,
      recentDailyBars: (futuresIntraday?.dailyHistory.bars ?? []).slice(-15),
    },
    futuresIntraday: {
      date: futuresIntraday?.date ?? null,
      symbol: futuresIntraday?.symbol ?? dayQuote.ticker,
      asOf: futuresIntraday?.asOf?.toISOString() ?? null,
      kd: { k: futuresIntraday?.k ?? null, d: futuresIntraday?.d ?? null },
      kdSignal: futuresIntraday?.signal ?? "insufficient",
      observedMinuteBars: (futuresIntraday?.bars ?? []).slice(-30),
      coverageNote: futuresIntraday?.source ?? "日盤一分資料暫不可用",
    },
    dataLimitations: [
      "只使用最新有效日盤期貨即時成交作為估點基準；不使用舊收盤價或夜盤價代替。",
      "分 K 僅為伺服器連線後觀測到的日盤成交，不代表完整歷史；沒有期貨成交量或買賣盤。",
      ...limitations,
      "只要有即時期指價格，就必須顯示一組有方向、附理由的條件式點位；低風險門檻只決定是否等待，不得用來隱藏方案。",
    ].join("；"),
  };

  let aiResponse: AiProviderResult;
  try {
    aiResponse = await withAiProviderFallback({
      operation: "futures_day_strategy",
      allowedProviders: ["groq", "gemini", "openrouter", "replit"],
      instructions: strategyInstructions(
        entryMode,
        forceEntryMode,
        adjustmentFeedback,
        aggressiveStrategy,
      ),
      input: JSON.stringify(marketContext),
      schema: outputSchema,
      // Retry providers for malformed or wrongly ordered prices, but keep the
      // user-selected distance and reward/risk thresholds as visible warnings.
      validateOutput: (text) => {
        const parsed = parseStrategyOutput(text);
        return parsed !== null && isValidFuturesEntryPlan({
          ...parsed,
          action: "wait",
          currentPrice: dayQuote.price,
        });
      },
      maxOutputTokens: 2048,
      timeoutMs: 5_000,
      groqTimeoutMs: 4_000,
      geminiTimeoutMs: 8_000,
      maxFallbackDurationMs: 25_000,
      replitTimeoutMs: 12_000,
      openRouterTimeoutMs: 5_000,
    });
  } catch (error) {
    throw providerError(error);
  }

  if (!aiResponse.text) throw new MarketDataError("AI 未提供可驗證的期貨分析。", 502);

  const strategy = parseStrategyOutput(aiResponse.text);
  if (!strategy) {
    throw new MarketDataError("AI 未提供完整且可驗證的單一價位方案，請稍後重試。", 502);
  }

  const rewardPoints =
    strategy.planDirection === "long"
      ? strategy.targetPrice - strategy.entryPrice
      : strategy.entryPrice - strategy.targetPrice;
  const riskPoints =
    strategy.planDirection === "long"
      ? strategy.entryPrice - strategy.stopLossPrice
      : strategy.stopLossPrice - strategy.entryPrice;
  const rewardRisk = rewardPoints / riskPoints;
  const targetFloor = forceEntryMode
    ? PAPER_FORCE_ENTRY_MIN_TARGET_POINTS
    : aggressiveStrategy?.minimumTargetPoints ?? FUTURES_MIN_TARGET_POINTS;
  const meetsRiskThresholds =
    rewardPoints >= targetFloor &&
    (forceEntryMode ||
      rewardRisk >= (aggressiveStrategy?.minimumRewardRisk ?? FUTURES_MIN_REWARD_RISK));
  const hasDirectionalAgreement = hasDirectionalQuoteAgreement({
      direction: strategy.planDirection,
      futuresChange: dayQuote.change,
      indexChange: taiexQuote.change,
    });
  const hasBreakoutRetest = hasBreakoutRetestConfirmation({
      direction: strategy.planDirection,
      entryPrice: strategy.entryPrice,
      bars: futuresIntraday?.bars ?? [],
    });
  const hasQualifiedImmediateSetup = aggressiveStrategy
    ? qualifiesAggressiveFuturesStrategy(aggressiveStrategy, {
        hasCompleteContext,
        hasLiveDirectionalContext: hasIntradayEvidence && hasSynchronizedTaiexQuote,
        meetsRiskThresholds,
        hasDirectionalAgreement,
      })
    : qualifiesFuturesEntryMode({
        mode: entryMode,
        hasCompleteContext,
        meetsRiskThresholds,
        hasDirectionalAgreement,
        hasBreakoutRetestConfirmation: hasBreakoutRetest,
      });
  const planResolution = resolveFuturesEntryPlan({
    action: hasQualifiedImmediateSetup
      ? strategy.action
      : strategy.action === "insufficient"
        ? "insufficient"
        : "wait",
    planDirection: strategy.planDirection,
    currentPrice: dayQuote.price,
    entryPrice: strategy.entryPrice,
    stopLossPrice: strategy.stopLossPrice,
    targetPrice: strategy.targetPrice,
    entryReason: strategy.entryReason,
    stopLossReason: strategy.stopLossReason,
    targetReason: strategy.targetReason,
  });
  const hasEntryPlan = planResolution.valid;
  const directPlanValid = planResolution.mode === "current";
  const planDirection = planResolution.planDirection ?? strategy.planDirection;
  const action = planResolution.action;
  const explanation = directPlanValid
    ? strategy.summary
    : hasEntryPlan
      ? `目前不立即進場，以下提供條件式點位。${strategy.summary}`
      : `價位結構未通過檢查。${strategy.summary}`;
  const composedGuidance = composeStrategyGuidance(
    action,
    explanation,
    directPlanValid ? dayQuote.price ?? undefined : undefined,
    hasEntryPlan && !directPlanValid
      ? { direction: planDirection, entryPrice: strategy.entryPrice }
      : undefined,
  );
  const entryPlan: EntryPlanFields = hasEntryPlan
    ? {
        entryPlanStatus: "available",
        entryPlanMode: planResolution.mode,
        planDirection,
        entryPrice: directPlanValid ? dayQuote.price : strategy.entryPrice,
        stopLossPrice: strategy.stopLossPrice,
        targetPrice: strategy.targetPrice,
        entryReason: strategy.entryReason,
        stopLossReason: strategy.stopLossReason,
        targetReason: strategy.targetReason,
        entryPlanMessage: directPlanValid
          ? `AI 主觀單一方案；停利 ${rewardPoints.toFixed(0)} 點，獲利風險比 ${rewardRisk.toFixed(1)}:1。若行情轉弱，不追進。`
          : forceEntryMode
            ? rewardPoints >= PAPER_FORCE_ENTRY_MIN_TARGET_POINTS
              ? `強制紙上模擬方案；停利 ${rewardPoints.toFixed(0)} 點（最低 ${PAPER_FORCE_ENTRY_MIN_TARGET_POINTS} 點），仍受單筆風險上限限制。`
              : `停利方案不足 ${PAPER_FORCE_ENTRY_MIN_TARGET_POINTS} 點最低門檻，不進行強制模擬。`
          : `單一條件式方案；停利 ${rewardPoints.toFixed(0)} 點，獲利風險比 ${rewardRisk.toFixed(1)}:1。${meetsRiskThresholds ? "突破回測與指數同向確認前不進場。" : `未達低風險參考門檻（停利 ${FUTURES_MIN_TARGET_POINTS} 點、風險報酬 ${FUTURES_MIN_REWARD_RISK}:1），只供觀察，不代表合格進場。`}`,
      }
    : {
        ...EMPTY_ENTRY_PLAN,
        entryPlanMessage:
          "AI 提供的點位順序未通過驗證，為避免顯示錯置停損或停利，請重新判讀。",
      };
  const result = makeResult(
    {
      status: hasCompleteContext ? "available" : "insufficient_data",
      action,
      ...composedGuidance,
      riskNote: strategy.riskNote,
      aiProvider: aiResponse.provider,
    },
    "quote_only",
    dayQuote,
    nightQuote,
    taiexQuote,
    entryPlan,
  );
  for (const [key, cached] of cachedStrategies) {
    if (cached.expiresAt <= Date.now()) cachedStrategies.delete(key);
  }
  while (cachedStrategies.size >= MAX_STRATEGY_CACHE_ENTRIES) {
    const oldestKey = cachedStrategies.keys().next().value;
    if (oldestKey === undefined) break;
    cachedStrategies.delete(oldestKey);
  }
  cachedStrategies.set(strategyCacheKey, {
    expiresAt: Date.now() + STRATEGY_CACHE_MS,
    result,
    intradayFingerprint,
  });
  return result;
}