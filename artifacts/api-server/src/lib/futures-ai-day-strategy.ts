import {
  MarketDataError,
  getMarketQuotes,
  getTaiexHistory,
  type MarketQuoteData,
} from "./market-data.js";
import type { FuturesAiDayStrategy } from "@workspace/api-zod";
import {
  AiProviderFallbackError,
  hasAiProviderCredentials,
  withAiProviderFallback,
} from "./ai-provider-fallback.js";
import type { AiProviderName, AiProviderResult } from "./ai-provider-fallback.js";
import { simplifyFinancialLanguage } from "./financial-language.js";
import {
  areQuotesSynchronized,
  isFreshIntradayTaiexQuote,
  isFreshMarketQuote,
  sameQuoteSnapshot,
} from "./futures-ai-day-strategy-guards.js";

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const STRATEGY_CACHE_MS = 5 * 60_000;
const DISCLAIMER =
  "期貨價格波動快，可能放大損失。本內容依公開行情整理，只供參考，不是個人化投資建議，也不保證獲利。";
const STRATEGY_INSTRUCTIONS = [
  "你是台灣加權指數期貨的日盤短線分析助手，只分析日盤當沖，不建議留倉過夜。",
  "只能使用輸入的 TAIFEX 日盤／夜盤最新或最後成交、加權指數報價及加權指數官方日線；不可補造新聞、價格、成交量、波動、支撐或壓力。",
  "臺指期輸入只有最新成交價、參考價、漲跌與時間，沒有已驗證的日內開高低、分時 K 線、成交量或買賣盤。不得輸出精確進場價、停損價、停利價或自行推算價位。",
  "夜盤報價只作背景，不得當成目前日盤成交。若日盤行情不明確、個股以外的市場資料互相矛盾或資料不足，action 選 wait 或 insufficient。",
  "不要因單一最新期指報價上漲就選 long，也不要因單一報價下跌就選 short；比較日盤期指與加權指數報價、近期加權指數 20／60 日走勢。只有多項可用資料方向相符時才選 long 或 short；若只有一筆報價可用、方向互相矛盾或日盤價格不新，選 wait／insufficient，不要硬湊方向。",
  "summary 只說明資料觀察，不可寫操作命令。action 必須由你依現有資料選出 long、short、wait 或 insufficient；伺服器會依 action 組合操作建議、條件與下一步，不會直接展示自由文字指令。",
  "riskNote 只說明行情資料限制或主要風險，不可包含買賣指令。輸出文字要短、白話、繁體中文；不要用「偏多／偏空、支撐／壓力、多空、留倉」等行話，改用一般人聽得懂的說法；不得包含阿拉伯數字或精確價位，不得宣稱勝率、保證獲利或適合任何特定使用者。",
].join(" ");

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["long", "short", "wait", "insufficient"],
    },
    summary: { type: "string", maxLength: 110 },
    riskNote: { type: "string", maxLength: 180 },
  },
  required: [
    "action",
    "summary",
    "riskNote",
  ],
} as const;

type StrategyOutput = {
  action: FuturesAiDayStrategy["action"];
  summary: string;
  riskNote: string;
};

type FuturesMarketQuoteKey = Extract<
  MarketQuoteData["key"],
  "taiex" | "futures_day" | "futures_night"
>;

let cachedStrategy:
  | {
      expiresAt: number;
      result: FuturesAiDayStrategy;
    }
  | undefined;

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
): FuturesAiDayStrategy {
  return {
    ...fields,
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
  );
}

function normalizeOutput(value: unknown): StrategyOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const validActions = new Set(["long", "short", "wait", "insufficient"]);
  if (typeof record.action !== "string" || !validActions.has(record.action)) {
    return null;
  }

  const normalize = (field: unknown): string | null => {
    if (typeof field !== "string") return null;
    const text = simplifyFinancialLanguage(field);
    if (!text || text.length > 180 || /\d/.test(text)) return null;
    return text;
  };
  const summary = normalize(record.summary);
  const riskNote = normalize(record.riskNote);
  if (
    !summary ||
    summary.length > 110 ||
    /(操作建議|下一步|建議|買進|買入|賣出|加碼|減碼|下單|進場)/u.test(summary) ||
    !riskNote ||
    /(操作建議|下一步|建議你|應該|買進|買入|賣出|加碼|減碼|下單|進場)/u.test(
      riskNote,
    )
  ) {
    return null;
  }

  return {
    action: record.action as StrategyOutput["action"],
    summary,
    riskNote,
  };
}

function composeStrategyGuidance(
  action: StrategyOutput["action"],
  explanation: string,
): Pick<
  FuturesAiDayStrategy,
  "summary" | "entryCondition" | "invalidationCondition"
> {
  const guidance = {
    long: {
      action: "只有日盤期指與加權指數方向一致向上時，才考慮買進期貨。",
      entry: "日盤期指與加權指數都維持向上時，再考慮買進；方向不一致就不買進。",
      cancel: "任一行情轉弱或兩者方向不同，取消買進想法。",
    },
    short: {
      action: "只有日盤期指與加權指數方向一致向下時，才考慮賣出期貨。",
      entry: "日盤期指與加權指數都維持向下時，再考慮賣出；方向不一致就不賣出。",
      cancel: "任一行情轉強或兩者方向不同，取消賣出想法。",
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
  return {
    summary: `操作建議：${guidance.action} 市場依據：${explanation}`,
    entryCondition: guidance.entry,
    invalidationCondition: guidance.cancel,
  };
}

function outputUnavailableResult(
  dayQuote: MarketQuoteData,
  nightQuote: MarketQuoteData,
  taiexQuote: MarketQuoteData,
  aiProvider: AiProviderName,
): FuturesAiDayStrategy {
  return makeResult(
    {
      status: "insufficient_data",
      action: "insufficient",
      summary: "操作建議：這次分析資料不完整，現在先不交易；等日盤與大盤行情更新後重新分析。",
      entryCondition: "取得有效的日盤成交與大盤方向資料後，才重新評估是否買賣。",
      invalidationCondition: "資料未通過檢查，不依這次分析買賣。",
      riskNote: "這次分析不完整，請勿依此操作。",
      aiProvider,
    },
    "quote_only",
    dayQuote,
    nightQuote,
    taiexQuote,
  );
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

export async function getFuturesAiDayStrategy(): Promise<FuturesAiDayStrategy> {
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

  if (
    !isFreshIntradayTaiexQuote(taiexQuote) ||
    !areQuotesSynchronized(dayQuote, taiexQuote)
  ) {
    return staticUnavailableResult(
      "insufficient_data",
      "wait",
      "操作建議：加權指數沒有與日盤期指同步的新鮮盤中報價，現在先不交易；等兩邊行情更新後再分析。",
      "最近收盤價或過期的大盤報價不能代替同步的盤中行情。",
      "quote_only",
      dayQuote,
      nightQuote,
      taiexQuote,
    );
  }

  if (
    cachedStrategy &&
    cachedStrategy.expiresAt > Date.now() &&
    sameQuoteSnapshot(cachedStrategy.result.dayQuote, dayQuote) &&
    sameQuoteSnapshot(cachedStrategy.result.nightQuote, nightQuote) &&
    sameQuoteSnapshot(cachedStrategy.result.taiexQuote, taiexQuote)
  ) {
    return cachedStrategy.result;
  }

  if (!hasAiProviderCredentials()) {
    throw new MarketDataError("尚未設定可用的 AI 供應商 API 憑證，無法使用 AI 期貨分析。", 502);
  }

  let indexHistory;
  try {
    indexHistory = await getTaiexHistory("3mo");
  } catch {
    return staticUnavailableResult(
      "insufficient_data",
      "insufficient",
      "操作建議：大盤近期價格資料不足，今天先不交易；資料補齊後重新分析。",
      "期指只有即時／最後成交價，缺少日內高低與成交量資料。",
      "unavailable",
      dayQuote,
      nightQuote,
      taiexQuote,
    );
  }
  if (indexHistory.bars.length < 5) {
    return staticUnavailableResult(
      "insufficient_data",
      "insufficient",
      "操作建議：大盤近期價格資料不足，現在先不交易；取得足夠的近期日線後重新分析。",
      "期指只有即時／最後成交價，缺少日內高低與成交量資料。",
      "unavailable",
      dayQuote,
      nightQuote,
      taiexQuote,
    );
  }

  const marketContext = {
    dayFuturesQuote: {
      ticker: dayQuote.ticker,
      price: dayQuote.price,
      change: dayQuote.change,
      changePercent: dayQuote.changePercent,
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
      price: taiexQuote.price,
      change: taiexQuote.change,
      changePercent: taiexQuote.changePercent,
      source: taiexQuote.source,
      asOf: taiexQuote.asOf?.toISOString() ?? null,
      available: taiexQuote.available,
    },
    taiexHistory: {
      source: indexHistory.source,
      asOf: indexHistory.asOf.toISOString(),
      recentDailyBars: indexHistory.bars.slice(-20).map((bar) => ({
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    },
    dataLimitations:
      "沒有已驗證的臺指期分時 K 線、日內開高低、成交量或買賣盤；不得推算期指支撐壓力或精確掛單價。",
  };

  let aiResponse: AiProviderResult;
  try {
    aiResponse = await withAiProviderFallback({
      operation: "futures_day_strategy",
      allowedProviders: ["groq", "gemini", "openrouter"],
      instructions: STRATEGY_INSTRUCTIONS,
      input: JSON.stringify(marketContext),
      schema: outputSchema,
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

  if (!aiResponse.text) throw new MarketDataError("AI 未提供可驗證的期貨分析。", 502);

  let parsed: unknown;
  try {
    parsed = JSON.parse(aiResponse.text);
  } catch {
    throw new MarketDataError("AI 回傳的期貨分析格式無法讀取。", 502);
  }
  const strategy = normalizeOutput(parsed);
  if (!strategy) {
    return outputUnavailableResult(
      dayQuote,
      nightQuote,
      taiexQuote,
      aiResponse.provider,
    );
  }

  const composedGuidance = composeStrategyGuidance(
    strategy.action,
    strategy.summary,
  );
  const result = makeResult(
    {
      status: "available",
      action: strategy.action,
      ...composedGuidance,
      riskNote: strategy.riskNote,
      aiProvider: aiResponse.provider,
    },
    "quote_only",
    dayQuote,
    nightQuote,
    taiexQuote,
  );
  cachedStrategy = {
    expiresAt: Date.now() + STRATEGY_CACHE_MS,
    result,
  };
  return result;
}