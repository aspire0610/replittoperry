export const MAX_ASSISTANT_CHAT_ANSWER_LENGTH = 420;
export const TAIWAN_STOCK_SHARES_PER_LOT = 1_000;

export function isTaiwanBroadMarketQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/gu, "");
  if (/大盤|加權指數|加權|櫃買指數|櫃買|漲跌家數/u.test(normalized)) {
    return true;
  }
  if (/^(?:台股|臺股|台灣股市|股市)?(?:盤勢|盤面)(?:如何|怎麼看)?[？?。！!]*$/u.test(normalized)) {
    return true;
  }
  if (/^(?:即時|目前|現在|最新)(?:行情|報價)(?:如何|多少|呢)?[？?。！!]*$/u.test(normalized)) {
    return true;
  }
  return /(?:今天|今日|現在|目前|即時|最新).{0,8}(?:台股|臺股|股市)|(?:台股|臺股|股市).{0,8}(?:今天|今日|現在|目前|即時|最新|行情|走勢|盤勢|盤面|成交量|成交金額)/u.test(
    normalized,
  );
}

export function isTaiwanMarketTimingQuestion(question: string): boolean {
  const normalized = question
    .normalize("NFKC")
    .replace(/[\s，。？！!?、]/gu, "");
  if (extractTaiwanStockSymbol(normalized)) return false;

  const timing = /盤前|盤後|開盤前|開盤後|收盤前|收盤後/u.test(normalized);
  if (!timing) return false;

  const taiwanMarketScope = /台股|臺股|台灣股市|大盤|加權指數|加權|櫃買指數|櫃買/u.test(
    normalized,
  );
  if (taiwanMarketScope) return true;

  return /^(?:(?:今天|今日|目前|現在)?(?:台股|臺股|大盤)?)(?:盤前|盤後)(?:盤勢|狀況|分析|走勢|如何|怎麼看|總結|摘要)?$/u.test(
    normalized,
  );
}

export function isTaiwanMarketForecastQuestion(question: string): boolean {
  const normalized = question.normalize("NFKC").replace(/\s+/gu, "");
  if (extractTaiwanStockSymbol(normalized)) return false;
  const explicitTaiwanMarket = /台股|臺股|台灣股市|大盤|加權|櫃買/u.test(normalized);
  const explicitOtherMarket =
    /美股|美國股市|道瓊|標普|納斯達克|NASDAQ|日股|日經|港股|恆生|韓股/u.test(normalized);
  if (explicitOtherMarket && !explicitTaiwanMarket) return false;
  const asksForDirection =
    /漲|跌|上漲|下跌|漲跌|偏多|偏空|走高|走低|走勢|趨勢|開盤方向|開盤如何|開盤怎麼看/u.test(normalized);
  const asksForNextSession =
    /明天|明日|下週|下周|下一個交易日|下個交易日|隔日|明早|開盤/u.test(normalized);
  const marketCue =
    /台股|臺股|股市|大盤|加權|櫃買|開盤|盤勢|股票|股價/u.test(normalized);
  return asksForDirection && asksForNextSession && marketCue;
}

export function isTaiwanMarketActionFollowUp(
  question: string,
  priorUserQuestions: string[],
): boolean {
  const normalizedQuestion = question.replace(/\s+/gu, "");
  if (
    extractTaiwanStockSymbol(normalizedQuestion) ||
    !/勝率|進場|操作|建議做法|建議操作|買進|買入|漲跌|趨勢|怎麼做/u.test(normalizedQuestion)
  ) {
    return false;
  }
  return priorUserQuestions
    .slice(-4)
    .some((priorQuestion) =>
      /台股|臺股|大盤|加權指數|加權|櫃買指數|櫃買|股市/u.test(
        priorQuestion.replace(/\s+/gu, ""),
      ),
    );
}

export function isTaiwanStockQuoteQuestion(question: string): boolean {
  return /成交價|股價|個股.{0,8}(?:行情|報價|價格)|(?:行情|報價|價格).{0,8}(?:個股|股票)|現價|目前股價|現在股價|(?:即時|目前|現在|最新).{0,4}(?:行情|報價|價格|多少)|\b\d{4,6}\b.{0,10}(?:多少|幾多|多少錢)|\b\d{4,6}\b.{0,12}(?:走勢|趨勢|表現)/u.test(
    question.replace(/\s+/gu, ""),
  );
}

export function isTaiwanStockActionQuestion(question: string): boolean {
  return /分析|盤勢|建議|操作|買進|買入|買嗎|可以.{0,3}買|能不能.{0,3}買|可不可以.{0,3}買|適合.{0,3}買|值得.{0,3}買|要不要買|該不該買|加碼|停損|續抱|賣出|減碼|停利|進場|退場|該買|該賣|怎麼看|如何操作|(?:最近|近期|現在|目前).{0,5}(?:怎麼樣|表現|走勢|如何)|(?:怎麼樣|近況|表現如何)/u.test(
    question.replace(/\s+/gu, ""),
  );
}

export function isTaiwanStockContextFollowUp(question: string): boolean {
  const normalized = question.trim().replace(/\s+/gu, "");
  return /^(?:那|這|它|剛剛|剛才|同一檔|這支|這檔|那支|那檔)/u.test(
    normalized,
  ) && /(?:買|賣|價|多少|原因|為什麼|為何|怎麼|如何|走勢|表現|分析|操作|呢|嗎)/u.test(
    normalized,
  );
}

export function mentionsTaiwanStockName(
  question: string,
  name: string,
  symbol?: string,
): boolean {
  const normalize = (value: string) =>
    value.normalize("NFKC").replace(/[\s　·．、，,。]/gu, "");
  const normalizedQuestion = normalize(question);
  const normalizedName = normalize(name);
  const legalName = normalizedName.replace(
    /(?:股份有限公司|有限責任公司|有限公司|公司)$/u,
    "",
  );
  const shortName = legalName.replace(
    /(?:科技|電子|工業|金控|金融|銀行|證券|半導體|光電|生技|通信|電機|材料|化學|國際|控股)$/u,
    "",
  );
  const knownAliases: Record<string, string[]> = {
    "2330": ["台積電", "台積"],
    "6223": ["旺矽"],
  };
  const aliases = new Set<string>([
    normalizedName,
    legalName,
    shortName,
    ...(symbol ? knownAliases[symbol] ?? [] : []),
  ]);
  if (shortName.length >= 2) aliases.add(shortName);
  return [...aliases].some(
    (alias) => alias.length >= 2 && normalizedQuestion.includes(alias),
  );
}

export function isTaiwanStockRecommendationQuestion(question: string): boolean {
  return /(?:推薦|推薦幾支|挑選|選出|找).{0,20}(?:台股|臺股|股票|個股|標的)|選股|(?:台股|臺股|股票|個股).{0,12}(?:推薦|選股|未來.{0,5}(?:漲|上漲)|接下來.{0,5}(?:漲|上漲))|(?:未來|接下來).{0,8}(?:幾天|幾日|一週).{0,8}(?:買哪支|買什麼|推薦)/u.test(
    question.replace(/\s+/gu, ""),
  );
}

export function isTaiwanStockMovementReasonQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/gu, "");
  const movement = "(?:上漲|下跌|漲跌|大漲|大跌|走高|走低|飆漲|重挫|回檔|拉回|漲|跌)";
  const reason = "(?:原因|為什麼|為何|怎麼回事|理由|因為)";
  return new RegExp(
    `(?:${reason}.{0,12}${movement}|${movement}.{0,12}${reason})`,
    "u",
  ).test(normalized);
}

export function isTaiwanStockMovementReasonFollowUp(
  question: string,
  priorUserQuestions: string[],
): boolean {
  const normalized = question.trim().replace(/\s+/gu, "");
  if (!/^(?:(?:那|所以|那麼|但是|可是)?)(?:為什麼|為何|原因|怎麼回事).{0,8}[？?嗎呢。！!]*$/u.test(normalized)) {
    return false;
  }
  return priorUserQuestions.some((priorQuestion) =>
    /上漲|下跌|漲跌|大漲|大跌|走高|走低|飆漲|重挫|回檔|拉回|漲|跌/u.test(
      priorQuestion.replace(/\s+/gu, ""),
    ),
  );
}

export function extractTaiwanStockSymbol(question: string): string | null {
  const match = question.match(
    /(?<![A-Z0-9])(\d{4,6})(?:\.(?:TW|TWO))?(?![A-Z0-9])(?!\s*(?:年|月|日))/iu,
  );
  return match?.[1] ?? null;
}

const STOCK_COUNT_PATTERN =
  "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,3})?|[零〇一二兩三四五六七八九十百千]+";

function parseStockCount(value: string): number | null {
  if (/^\d/u.test(value)) {
    const parsed = Number(value.replaceAll(",", ""));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (character in units) {
      total += (current || 1) * units[character];
      current = 0;
      continue;
    }
    const digit = digits[character];
    if (digit === undefined) return null;
    current = digit;
  }
  return total + current;
}

function formatStockCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(
    value,
  );
}

export function answerTaiwanStockLotQuestion(
  question: string,
  selectedSymbol?: string,
): string | null {
  const normalized = question.trim().replace(/\s+/gu, " ");
  if (!normalized.includes("張")) return null;
  if (/美股|港股|日股|韓股|海外股票|期貨|選擇權/u.test(normalized)) {
    return null;
  }

  const explicitTaiwanMarket = /台股|臺股|台灣|臺灣|上市櫃/u.test(normalized);
  const normalizedSymbol = selectedSymbol
    ?.trim()
    .toUpperCase()
    .replace(/\.(TW|TWO)$/u, "");
  if (
    normalizedSymbol &&
    !/^\d{4,6}$/u.test(normalizedSymbol) &&
    !explicitTaiwanMarket
  ) {
    return null;
  }

  const asksForShares =
    /(?:幾|多少|幾多)\s*股(?!票|價|利)|(?:換算|換成)(?:成|為)?\s*股/u.test(
      normalized,
    );
  const asksForLots =
    /(?:幾|多少|幾多)\s*張|(?:換算|換成)(?:成|為)?\s*張/u.test(normalized);
  const hasExplicitConversion =
    /張.{0,12}(?:(?:等於|是|為|=|＝).{0,12})?(?:\d[\d,]*(?:\.\d{1,3})?|[零〇一二兩三四五六七八九十百千]+)\s*股|(?:\d[\d,]*(?:\.\d{1,3})?|[零〇一二兩三四五六七八九十百千]+)\s*股.{0,12}(?:等於|是|為|=|＝).{0,12}張/u.test(
      normalized,
    );

  if (!asksForShares && !asksForLots && !hasExplicitConversion) return null;

  const countPattern = new RegExp(`(${STOCK_COUNT_PATTERN})\\s*`, "u");
  const sharesMatch = normalized.match(
    new RegExp(`${countPattern.source}股(?!票|價|利)`, "u"),
  );
  if (asksForLots && sharesMatch?.[1]) {
    const shares = parseStockCount(sharesMatch[1]);
    if (
      shares !== null &&
      Number.isSafeInteger(shares) &&
      shares >= 0
    ) {
      const lots = shares / TAIWAN_STOCK_SHARES_PER_LOT;
      const wholeLots = Math.floor(lots);
      const remainder =
        shares % TAIWAN_STOCK_SHARES_PER_LOT;
      if (remainder === 0) {
        return `${formatStockCount(shares)} 股 = ${formatStockCount(lots)} 張。台灣上市櫃股票 1 張 = 1,000 股。`;
      }
      return `${formatStockCount(shares)} 股 = ${formatStockCount(wholeLots)} 張 + ${formatStockCount(remainder)} 股零股（合計 ${formatStockCount(lots)} 張）。台灣上市櫃股票 1 張 = 1,000 股。`;
    }
  }

  const lotsMatch = normalized.match(
    new RegExp(`${countPattern.source}張`, "u"),
  );
  const lots =
    lotsMatch?.[1] !== undefined
      ? parseStockCount(lotsMatch[1])
      : /每張|每一張|單張/u.test(normalized)
        ? 1
        : null;
  if (lots === null || lots < 0) {
    return "台灣上市櫃股票 1 張 = 1,000 股；不足 1,000 股為零股。其他市場或商品的單位可能不同。";
  }
  const shares = lots * TAIWAN_STOCK_SHARES_PER_LOT;
  if (!Number.isSafeInteger(shares)) return null;
  return lots === 1
    ? "台灣上市櫃股票 1 張 = 1,000 股；不足 1,000 股為零股。其他市場或商品的單位可能不同。"
    : `台灣上市櫃股票 1 張 = 1,000 股；${formatStockCount(lots)} 張 = ${formatStockCount(shares)} 股。其他市場或商品的單位可能不同。`;
}

export function parseAssistantChatOutput(text: string | null): string | null {
  if (!text) return null;
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced?.[1]) candidate = fenced[1].trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const answer = (parsed as Record<string, unknown>).answer;
    if (typeof answer !== "string") return null;
    const normalized = answer.trim();
    return normalized.length > 0 &&
      normalized.length <= MAX_ASSISTANT_CHAT_ANSWER_LENGTH
      ? normalized
      : null;
  } catch {
    return null;
  }
}

export function shouldSearchWeb(question: string): boolean {
  const normalized = question.trim();
  if (!normalized) return false;
  if (
    /^(?:hi|hello|hey|嗨|哈囉|你好|早安|午安|晚安|謝謝|感謝|再見)[\s!！。,.，]*$/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /^(?:幫我寫|寫一首|創作|編一個故事|想像|改寫成|翻譯成|make up|write a|write me|draft a|compose a)\b/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  return /最新|目前|現在|今天|今日|今年|最近|上週|上個月|新聞|消息|來源|網址|搜尋|查詢|查一下|資料|資訊|價格|行情|配息|除息|ETF|股票|基金|法規|政策|公告|比較|原因|為什麼|為何|怎麼回事|漲跌|上漲|下跌|what|when|where|who|which|why|how|latest|current|today|news|source|search|price|dividend|compare|reason|cause/iu.test(
    normalized,
  ) || /[?？]|嗎[？?。！!]?$/u.test(normalized);
}

export function shouldDispatchResearchAgents(question: string): boolean {
  const normalized = question.trim();
  if (!normalized) return false;
  if (/^(?:hi|hello|hey|嗨|哈囉|你好|早安|午安|晚安|謝謝|感謝|再見)[\s!！。,.，]*$/iu.test(normalized)) {
    return false;
  }
  if (/^(?:幫我寫|寫一首|創作|改寫成|翻譯成)/iu.test(normalized)) {
    return false;
  }
  if (/^(?:算一下|換算)/u.test(normalized)) {
    return false;
  }
  const detailedResearch = /分析|研究|比較|差異|優缺|深入|全面|整理|評估|風險|策略|計畫|方案|趨勢|原因|為什麼|為何|怎麼回事|背景|查證|盤點|recommend|analy[sz]e|research|compare|risk|strategy|trend|why|investigate/iu.test(normalized);
  const tickerAction = /\b\d{4,6}(?:\.(?:TW|TWO))?\b/iu.test(normalized) &&
    /買|補倉|補買|加碼|加倉|減碼|賣|續抱|操作|進場|出場|停損|停利|目標價|持有|短線|長線|走勢|盤勢/u.test(normalized);
  const marketResearch = /(?:台股|臺股|大盤|ETF|期貨|投資).*(?:走勢|盤勢|後市|配置|方向|展望)|(?:走勢|盤勢|後市|配置|方向|展望).*(?:台股|臺股|大盤|ETF|期貨|投資)/u.test(normalized);
  return detailedResearch || tickerAction || marketResearch;
}
