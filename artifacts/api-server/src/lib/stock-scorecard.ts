export type ScorecardBar = {
  date: string;
  open?: number | null;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type StockScorecardItem = {
  id: string;
  label: string;
  points: number | null;
  maximumPoints: number;
  status: "available" | "unavailable";
  note: string;
};

export type StockScorecard = {
  earnedPoints: number;
  availablePoints: number;
  maximumPoints: 100;
  complete: boolean;
  items: StockScorecardItem[];
  technicalIndicators: {
    ma5: number | null;
    ma10: number | null;
    ma20: number | null;
    ma60: number | null;
    ma5DeviationPercent: number | null;
    ma10DeviationPercent: number | null;
    ma20DeviationPercent: number | null;
    ma60DeviationPercent: number | null;
    rsi14: number | null;
    kdK: number | null;
    kdD: number | null;
    macdLine: number | null;
    macdSignal: number | null;
    macdHistogram: number | null;
  };
  note: string;
};

export type StockTradeScenario = {
  entryPrice: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  profitPercent: number | null;
  lossPercent: number | null;
  rewardToRisk: number | null;
};

export type StockTradeScenarios = {
  referencePrice: number;
  atr14: number | null;
  supportPrice: number | null;
  resistancePrice: number | null;
  deepSupportPrice: number | null;
  directEntry: StockTradeScenario;
  pullbackEntry: StockTradeScenario;
  methodNote: string;
};

export type StockMarkdownReportInput = {
  symbol: string;
  ticker: string;
  name: string | null;
  currentPrice: number;
  changePercent: number | null;
  biasLevel: "strong_bearish" | "bearish" | "neutral" | "bullish" | "strong_bullish" | "insufficient";
  summary: string;
  actionText: string;
  template?: "screening" | "automated_quant";
  action?: "buy" | "hold" | "sell" | "wait" | "insufficient";
  decisionSignal?: string;
  scanTags?: string[];
  historicalWinRatePercent?: number | null;
  riskNote?: string | null;
  positionSizingNote?: string | null;
  scorecard: StockScorecard;
  scenarios: StockTradeScenarios;
};

function cleanMarkdownText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "／").trim();
}

function formatPrice(value: number | null): string {
  return value === null ? "未取得" : value.toFixed(2);
}

function formatPercent(value: number | null): string {
  return value === null ? "未取得" : `${value.toFixed(2)}%`;
}

function formatScenarioLevel(price: number | null, percent: number | null, sign: "+" | "-"): string {
  if (price === null) return "未取得";
  return percent === null ? `${formatPrice(price)} 元` : `${formatPrice(price)} 元（${sign}${percent.toFixed(1)}%）`;
}

function formatDimension(
  items: StockScorecardItem[],
  maximumPoints: number,
): string {
  const earned = items.reduce((sum, item) => sum + (item.points ?? 0), 0);
  const available = items.reduce((sum, item) => sum + (item.points === null ? 0 : item.maximumPoints), 0);
  const missing = maximumPoints - available;
  const details = items.map((item) =>
    `${item.label}：${item.points === null ? "未取得" : `${item.points}/${item.maximumPoints}`}（${cleanMarkdownText(item.note)}）`
  ).join("；");
  return `${earned}/${maximumPoints} 分；可評估 ${available}/${maximumPoints} 分${missing ? `，未取得 ${missing} 分` : ""}。${details}`;
}

export function buildStockScanTags(scorecard: StockScorecard): string[] {
  const item = (id: string) => scorecard.items.find((entry) => entry.id === id);
  const warning = item("volume-breakout")?.note.includes("流動性不足")
    ? "⚠️ 系統標註：流動性偏低，列入觀察名單"
    : null;
  const evidenceTags = [
    (item("institution-外資")?.points ?? 0) >= 10 || (item("institution-投信")?.points ?? 0) >= 10
      ? "🔥 法人最近單日淨買超"
      : null,
    (item("volume-breakout")?.points ?? 0) >= 10
      ? "🚀 成交量達 20 日均量 1.5 倍且價揚"
      : null,
    (item("weekly-daily-alignment")?.points ?? 0) >= 10
      ? "📈 日週線趨勢同向"
      : null,
  ].filter((tag): tag is string => tag !== null);
  const tags = [
    ...(warning ? [warning] : []),
    ...evidenceTags.slice(0, warning ? 1 : 2),
  ];
  if (tags.length < 2) {
    tags.push(`📊 可評估 ${scorecard.availablePoints}/100 分；缺漏項目不補分`);
  }
  tags.push("📊 同條件歷史勝率：尚未驗證");
  return tags.slice(0, 3);
}

export function qualifiesForAutomatedQuantSignal(input: {
  score: number;
  rewardToRisk: number | null;
  trustBuyDays: number;
  volumeBreakoutAboveMonthlyAverage: boolean;
}): boolean {
  return input.score > 80 &&
    input.rewardToRisk !== null &&
    input.rewardToRisk > 2 &&
    input.trustBuyDays >= 2 &&
    input.volumeBreakoutAboveMonthlyAverage;
}

function buildAutomatedQuantReport(input: StockMarkdownReportInput): string {
  const { scorecard, scenarios } = input;
  const chips = scorecard.items.filter((item) =>
    ["institution-外資", "institution-投信", "holders-margin", "main-force"].includes(item.id)
  );
  const volumePrice = scorecard.items.filter((item) =>
    ["volume-breakout", "obv-trend", "ma-breakout"].includes(item.id)
  );
  const momentum = scorecard.items.filter((item) =>
    ["macd", "rsi-kd", "divergence", "weekly-daily-alignment"].includes(item.id)
  );
  const actionDecision = ({
    buy: "🟢 強烈買入訊號",
    hold: "🟡 逢低佈局觀望",
    sell: "🔴 風險迴避",
    wait: "⚪ 區間箱型整理",
    insufficient: "🔴 風險迴避",
  }[input.action ?? "insufficient"]);
  const allowedDecisions = new Set([
    "🟢 強烈買入訊號",
    "🟡 逢低佈局觀望",
    "⚪ 區間箱型整理",
    "🔴 風險迴避",
  ]);
  const decision = input.decisionSignal && allowedDecisions.has(input.decisionSignal)
    ? input.decisionSignal
    : actionDecision;
  const coreView = cleanMarkdownText(`${input.summary} ${input.actionText}`)
    .split(/(?<=[。！？.!?])\s*/u)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ") || "目前沒有足夠證據形成系統觀點。";
  const suppliedTags = input.scanTags?.length ? input.scanTags : buildStockScanTags(scorecard);
  const chipTag = suppliedTags.find((tag) => tag.startsWith("🔥")) ?? "🔥 尚未確認籌碼面亮點。";
  const breakoutTag = suppliedTags.find((tag) => tag.startsWith("🚀")) ?? "🚀 尚未確認帶量突破。";
  const backtestTag = input.historicalWinRatePercent === null || input.historicalWinRatePercent === undefined
    ? "📊 歷史回測勝率參考：目前沒有足夠且可驗證的同條件樣本。"
    : `📊 歷史回測勝率參考：符合此量化條件之 20 日勝率約 ${input.historicalWinRatePercent.toFixed(1)}%。`;
  const scenarioRow = (
    label: string,
    scenario: StockTradeScenario,
    sizing: string,
  ) => `| **${label}** | ${formatScenarioLevel(scenario.entryPrice, null, "+")} | ${formatScenarioLevel(scenario.targetPrice, scenario.profitPercent, "+")} | ${formatScenarioLevel(scenario.stopPrice, scenario.lossPercent, "-")} | ${scenario.rewardToRisk === null ? "無法計算" : `**1 : ${scenario.rewardToRisk.toFixed(2)}**`} | ${sizing} |`;
  return [
    "## 0. 自動化掃描與亮點標籤 (Automated Scan Tags)",
    `* \`${cleanMarkdownText(chipTag)}\``,
    `* \`${cleanMarkdownText(breakoutTag)}\``,
    `* \`${backtestTag}\``,
    "",
    "## 1. 綜合評分與自動化訊號 (Summary & Signal)",
    `* **標的名稱**：${cleanMarkdownText(input.name ?? input.symbol)} (${cleanMarkdownText(input.ticker)})`,
    `* **當前股價**：${formatPrice(input.currentPrice)} 元（${input.changePercent === null ? "漲跌幅未取得" : `${input.changePercent >= 0 ? "+" : ""}${input.changePercent.toFixed(2)}%`}）`,
    `* **本地計算指標**：MA5 ${formatPrice(scorecard.technicalIndicators.ma5)}／MA10 ${formatPrice(scorecard.technicalIndicators.ma10)}／MA20 ${formatPrice(scorecard.technicalIndicators.ma20)}／MA60 ${formatPrice(scorecard.technicalIndicators.ma60)}；5／10／20／60 日乖離 ${formatPercent(scorecard.technicalIndicators.ma5DeviationPercent)}／${formatPercent(scorecard.technicalIndicators.ma10DeviationPercent)}／${formatPercent(scorecard.technicalIndicators.ma20DeviationPercent)}／${formatPercent(scorecard.technicalIndicators.ma60DeviationPercent)}；KD ${formatPrice(scorecard.technicalIndicators.kdK)}／${formatPrice(scorecard.technicalIndicators.kdD)}；MACD 柱 ${formatPrice(scorecard.technicalIndicators.macdHistogram)}；ATR14 ${formatPrice(scenarios.atr14)}。`,
    `* **量化綜合得分**：${scorecard.earnedPoints} / 100 分`,
    `* **自動化決策訊號**：${decision}`,
    "",
    "## 2. 三大維度量化診斷 (Quant Breakdown)",
    `* **籌碼面評估（/40）**：${formatDimension(chips, 40)}`,
    `* **量價面評估（/30）**：${formatDimension(volumePrice, 30)}`,
    `* **動能與回測評估（/30）**：${formatDimension(momentum, 30)}`,
    "",
    "## 3. 智慧交易策略與部位試算 (Automated Simulation & Sizing)",
    "| 執行情境 | 建議進場價位 | 預估停利位 | 預估停損位 (含 ATR 防守) | 風險報酬比 (R/R) | 建議建倉方式 |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |",
    scenarioRow("情境一：現價自動進場", scenarios.directEntry, "首批建立 1 單位部位"),
    scenarioRow("情境二：回測支撐佈局", scenarios.pullbackEntry, "觸及支撐加碼 1 單位"),
    "",
    "## 4. 自動化執行紀律與風控 (Action Plan & Risk Control)",
    `* **核心系統觀點**：${coreView}`,
    `* **關鍵防守與警示**：壓力位：${formatPrice(scenarios.resistancePrice)} 元 / 停損底線：${formatPrice(scenarios.directEntry.stopPrice)} 元 | ⚠️ 風險提示：請嚴格執行動態 ATR 停損與資金控管`,
    `* **價位試算方法**：${cleanMarkdownText(scenarios.methodNote)}`,
  ].join("\n");
}

export function buildStockMarkdownReport(input: StockMarkdownReportInput): string {
  if (input.template === "automated_quant") {
    return buildAutomatedQuantReport(input);
  }
  const { scorecard, scenarios } = input;
  const chips = scorecard.items.filter((item) =>
    ["institution-外資", "institution-投信", "holders-margin", "main-force"].includes(item.id)
  );
  const volumePrice = scorecard.items.filter((item) =>
    ["volume-breakout", "obv-trend", "ma-breakout"].includes(item.id)
  );
  const momentum = scorecard.items.filter((item) =>
    ["macd", "rsi-kd", "divergence", "weekly-daily-alignment"].includes(item.id)
  );
  const signals = {
    strong_bullish: "🟢 強烈偏多",
    bullish: "🟡 偏多觀望",
    neutral: "⚪ 盤整整理",
    bearish: "🔴 偏空避開",
    strong_bearish: "🔴 偏空避開",
    insufficient: "資料不足，暫無訊號",
  }[input.biasLevel];
  const direct = scenarios.directEntry;
  const pullback = scenarios.pullbackEntry;
  const directRatio = direct.rewardToRisk === null ? "無法計算" : `1 : ${direct.rewardToRisk.toFixed(2)}`;
  const pullbackRatio = pullback.rewardToRisk === null ? "無法計算" : `1 : ${pullback.rewardToRisk.toFixed(2)}`;
  const priceAndChange = `${formatPrice(input.currentPrice)} 元（${input.changePercent === null ? "漲跌幅未取得" : `${input.changePercent >= 0 ? "+" : ""}${input.changePercent.toFixed(2)}%`}）`;
  const coreText = cleanMarkdownText(`${input.summary} ${input.actionText}`);
  const core = coreText.split(/(?<=[。！？.!?])\s*/u).filter(Boolean).slice(0, 2).join(" ");
  const support = scenarios.supportPrice;
  const resistance = scenarios.resistancePrice;

  return [
    "## 1. 綜合評分與訊號 (Summary)",
    `* **標的名稱**：${cleanMarkdownText(input.name ?? input.symbol)} (${cleanMarkdownText(input.ticker)})`,
    `* **當前股價**：${priceAndChange}`,
    `* **量化綜合得分**：${scorecard.earnedPoints} / 100 分（本次可評估 ${scorecard.availablePoints} / 100 分；未取得項目不補分、不換算）`,
    `* **決策訊號**：${signals}（依 AI 方向判讀，不由分數直接決定）`,
    "",
    "## 2. 三大維度診斷 (Quant Breakdown)",
    `* **籌碼面評估（/40）**：${formatDimension(chips, 40)}`,
    `* **量價面評估（/30）**：${formatDimension(volumePrice, 30)}`,
    `* **動能與趨勢評估（/30）**：${formatDimension(momentum, 30)}`,
    "",
    "## 3. 交易策略與多情境試算 (Trading Simulation)",
    "| 進場情境 | 建議進場價位 | 預估停利位 | 預估停損位 (含 ATR 防守) | 風險報酬比 (R/R) |",
    "| :--- | :--- | :--- | :--- | :--- |",
    `| **情境一：現價進場** | ${formatPrice(direct.entryPrice)} 元 | ${formatScenarioLevel(direct.targetPrice, direct.profitPercent, "+")} | ${formatScenarioLevel(direct.stopPrice, direct.lossPercent, "-")} | ${directRatio} |`,
    `| **情境二：回測進場** | ${formatPrice(pullback.entryPrice)} 元 | ${formatPrice(pullback.targetPrice)} 元 | ${formatPrice(pullback.stopPrice)} 元 | ${pullbackRatio} |`,
    "",
    "## 4. 具體操作建議 (Actionable Insight)",
    `* **核心觀點**：${core}`,
    `* **觀察關鍵價位**：壓力位：${formatPrice(resistance)} 元 / 支撐位：${formatPrice(support)} 元`,
  ].join("\n");
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = closes.length - period; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return gains > 0 ? 100 : 50;
  const ratio = gains / losses;
  return 100 - 100 / (1 + ratio);
}

function rsiSeries(closes: number[]): Array<number | null> {
  return closes.map((_, index) => rsi(closes.slice(0, index + 1)));
}

function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]!];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index]! * multiplier + result[index - 1]! * (1 - multiplier));
  }
  return result;
}

function scoreItem(
  id: string,
  label: string,
  points: number | null,
  maximumPoints: number,
  note: string,
): StockScorecardItem {
  return {
    id,
    label,
    points,
    maximumPoints,
    status: points === null ? "unavailable" : "available",
    note,
  };
}

export function buildStockScorecard(
  bars: ScorecardBar[],
  institutional: {
    status: "available" | "unavailable";
    foreignNetShares: number | null;
    investmentTrustNetShares: number | null;
    observedAt?: string | null;
  },
  holderMargin: { points: number | null; note: string } = {
    points: null,
    note: "本次尚無官方大股東與融資融券資料，未估分。",
  },
): StockScorecard {
  const closes = bars.map((bar) => bar.close);
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const last20 = bars.slice(-20);
  const volumeBaseline = bars.slice(-21, -1)
    .map((bar) => bar.volume)
    .filter((value): value is number => value !== null && value >= 0);
  const averageVolume = average(volumeBaseline);
  const volumeRatio = latest?.volume !== null && latest?.volume !== undefined &&
    averageVolume !== null && averageVolume > 0
    ? latest.volume / averageVolume
    : null;
  const averageTurnover = average(last20
    .filter((bar) => bar.volume !== null)
    .map((bar) => bar.close * bar.volume!));
  const turnoverSamples = last20.filter((bar) => bar.volume !== null).length;
  const liquidityWarning = averageTurnover !== null && turnoverSamples >= 15 && averageTurnover < 10_000_000
    ? `⚠️ 流動性不足，近 20 日平均成交金額約 ${Math.round(averageTurnover).toLocaleString("zh-TW")} 元，技術指標參考價值降低。`
    : averageTurnover === null || turnoverSamples < 15
      ? "成交金額資料不足，無法完成流動性檢查。"
      : `近 20 日平均成交金額約 ${Math.round(averageTurnover).toLocaleString("zh-TW")} 元，未觸發流動性警示。`;
  const gapPercent = latest?.open && previous && previous.close > 0
    ? ((latest.open / previous.close) - 1) * 100
    : null;
  const gapWarning = gapPercent !== null && Math.abs(gapPercent) >= 5
    ? ` ⚠️ 開盤跳空 ${gapPercent > 0 ? "+" : ""}${gapPercent.toFixed(1)}%，請留意極端價格風險。`
    : "";

  const volumePoints = volumeRatio === null || !previous || !latest
    ? null
    : volumeRatio >= 1.5 && latest.close > previous.close
      ? 10
      : volumeRatio >= 1 && latest.close >= previous.close
        ? 7
        : volumeRatio < 0.8 || latest.close < previous.close
          ? 2
          : 5;

  const obvTail = bars.slice(-20);
  const obv = obvTail.reduce<number[]>((values, bar, index) => {
    const prior = obvTail[index - 1];
    const priorValue = values.at(-1) ?? 0;
    const volume = bar.volume ?? 0;
    values.push(index === 0 || !prior ? priorValue : bar.close > prior.close
      ? priorValue + volume
      : bar.close < prior.close
        ? priorValue - volume
        : priorValue);
    return values;
  }, []);
  const obvPoints = volumeBaseline.length < 10 || obv.length < 2
    ? null
    : obv.at(-1)! > obv[0]! ? 10 : obv.at(-1)! < obv[0]! ? 0 : 5;
  const ma20 = average(closes.slice(-20));
  const ma60 = average(closes.slice(-60));
  const ma5 = average(closes.slice(-5));
  const ma10 = average(closes.slice(-10));
  const priceMaPoints = latest && ma20 !== null && ma60 !== null
    ? (latest.close > ma20 ? 5 : 0) + (latest.close > ma60 ? 5 : 0)
    : null;

  const slowEma = ema(closes, 26);
  const macdSeries = ema(closes, 12).map((fast, index) => fast - slowEma[index]!);
  const signal = ema(macdSeries, 9);
  const histNow = bars.length >= 35 && macdSeries.at(-1) !== undefined && signal.at(-1) !== undefined
    ? macdSeries.at(-1)! - signal.at(-1)!
    : null;
  const histPrior = bars.length >= 35 && macdSeries.at(-2) !== undefined && signal.at(-2) !== undefined
    ? macdSeries.at(-2)! - signal.at(-2)!
    : null;
  const macdPoints = histNow === null || histPrior === null
    ? null
    : histNow > 0 && histNow > histPrior ? 10
      : histNow < 0 && histNow < histPrior ? 0
        : 5;

  const currentRsi = rsi(closes);
  const window = bars.slice(-9);
  const rangeHigh = window.length === 9 ? Math.max(...window.map((bar) => bar.high)) : null;
  const rangeLow = window.length === 9 ? Math.min(...window.map((bar) => bar.low)) : null;
  const stochasticK = rangeHigh !== null && rangeLow !== null && rangeHigh > rangeLow && latest
    ? ((latest.close - rangeLow) / (rangeHigh - rangeLow)) * 100
    : null;
  const kValues = bars.slice(-11).map((_, index, slice) => {
    const absoluteIndex = bars.length - slice.length + index;
    const periodBars = bars.slice(Math.max(0, absoluteIndex - 8), absoluteIndex + 1);
    if (periodBars.length < 9) return null;
    const high = Math.max(...periodBars.map((bar) => bar.high));
    const low = Math.min(...periodBars.map((bar) => bar.low));
    return high > low ? ((bars[absoluteIndex]!.close - low) / (high - low)) * 100 : null;
  }).filter((value): value is number => value !== null);
  const k = kValues.at(-1) ?? stochasticK;
  const d = average(kValues.slice(-3));
  const oscillatorPoints = currentRsi === null || k === null || d === null
    ? null
    : currentRsi >= 50 && currentRsi <= 70 && k > d
      ? 10
      : currentRsi < 30 || k < d
        ? 2
        : 6;

  const priorHalf = bars.slice(-20, -10);
  const recentHalf = bars.slice(-10);
  const rsiValues = rsiSeries(closes);
  const extremeIndex = (start: number, end: number, kind: "high" | "low") => {
    let selected = start;
    for (let index = start + 1; index < end; index += 1) {
      if (
        kind === "high"
          ? bars[index]!.close > bars[selected]!.close
          : bars[index]!.close < bars[selected]!.close
      ) selected = index;
    }
    return selected;
  };
  const priorHighIndex = priorHalf.length === 10 ? extremeIndex(bars.length - 20, bars.length - 10, "high") : null;
  const recentHighIndex = recentHalf.length === 10 ? extremeIndex(bars.length - 10, bars.length, "high") : null;
  const priorLowIndex = priorHalf.length === 10 ? extremeIndex(bars.length - 20, bars.length - 10, "low") : null;
  const recentLowIndex = recentHalf.length === 10 ? extremeIndex(bars.length - 10, bars.length, "low") : null;
  const bearishDivergence = priorHighIndex !== null && recentHighIndex !== null &&
    rsiValues[priorHighIndex] !== null && rsiValues[recentHighIndex] !== null &&
    bars[recentHighIndex]!.close > bars[priorHighIndex]!.close * 1.01 &&
    rsiValues[recentHighIndex]! < rsiValues[priorHighIndex]!;
  const bullishDivergence = priorLowIndex !== null && recentLowIndex !== null &&
    rsiValues[priorLowIndex] !== null && rsiValues[recentLowIndex] !== null &&
    bars[recentLowIndex]!.close < bars[priorLowIndex]!.close * 0.99 &&
    rsiValues[recentLowIndex]! > rsiValues[priorLowIndex]!;
  const divergenceAvailable =
    priorHighIndex !== null && recentHighIndex !== null &&
    priorLowIndex !== null && recentLowIndex !== null &&
    rsiValues[priorHighIndex] != null && rsiValues[recentHighIndex] != null &&
    rsiValues[priorLowIndex] != null && rsiValues[recentLowIndex] != null;
  const divergencePoints = divergenceAvailable
    ? bearishDivergence ? 0 : 5
    : null;

  const weeklyByStart = new Map<string, number[]>();
  for (const bar of bars) {
    const date = new Date(`${bar.date}T00:00:00Z`);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    const weekStart = date.toISOString().slice(0, 10);
    weeklyByStart.set(weekStart, [...(weeklyByStart.get(weekStart) ?? []), bar.close]);
  }
  const weeklyCloses = [...weeklyByStart.values()].map((values) => values.at(-1)!);
  const weeklyMa5 = average(weeklyCloses.slice(-5));
  const weeklyMa10 = average(weeklyCloses.slice(-10));
  const dailyBullish = latest && ma20 !== null && ma60 !== null && latest.close > ma20 && latest.close > ma60;
  const dailyBearish = latest && ma20 !== null && ma60 !== null && latest.close < ma20 && latest.close < ma60;
  const weeklyBullish = weeklyCloses.length >= 10 && weeklyMa5 !== null && weeklyMa10 !== null &&
    weeklyCloses.at(-1)! > weeklyMa5 && weeklyCloses.at(-1)! > weeklyMa10;
  const weeklyBearish = weeklyCloses.length >= 10 && weeklyMa5 !== null && weeklyMa10 !== null &&
    weeklyCloses.at(-1)! < weeklyMa5 && weeklyCloses.at(-1)! < weeklyMa10;
  const trendAlignmentPoints = weeklyCloses.length < 10 || (!dailyBullish && !dailyBearish && ma20 !== null && ma60 !== null)
    ? null
    : dailyBullish && weeklyBullish ? 5
      : dailyBearish && weeklyBearish ? 0
        : (dailyBullish && weeklyBearish) || (dailyBearish && weeklyBullish) ? 1
          : 3;

  const institutionPoint = (value: number | null, label: string) =>
    institutional.status === "available" && value !== null
      ? scoreItem(
          `institution-${label}`,
          `${label}單日淨買賣`,
          value > 0 ? 10 : value < 0 ? 0 : 5,
          10,
          `官方資料日 ${institutional.observedAt ?? "未提供"}；僅反映 ${label} 最近一筆官方交易日淨買賣，不代表連續買賣天數。`,
        )
      : scoreItem(`institution-${label}`, `${label}單日淨買賣`, null, 10, "沒有可用的官方數值。");

  const items = [
    institutionPoint(institutional.foreignNetShares, "外資"),
    institutionPoint(institutional.investmentTrustNetShares, "投信"),
    scoreItem("holders-margin", "大股東現況與融資融券變化", holderMargin.points, 10, holderMargin.note),
    scoreItem("main-force", "主力集中度", null, 10, "依目前設定略過；不以投信或法人買賣代替。"),
    scoreItem("volume-breakout", "成交量突破與流動性", volumePoints, 10, `${volumeRatio === null ? "成交量基準不足。" : `當日量為前 20 日均量 ${volumeRatio.toFixed(2)} 倍；1.5 倍以上且收漲列為偏強。`} ${liquidityWarning}${gapWarning}`),
    scoreItem("obv-trend", "OBV 量能趨勢", obvPoints, 10, "以近 20 根日線收漲／收跌方向累計成交量，和區間起點比較。"),
    scoreItem("ma-breakout", "收盤價相對 20／60 日均線", priceMaPoints, 10, "20 日與 60 日均線各占 5 分，價格在均線上方得分。"),
    scoreItem("macd", "MACD 柱狀體", macdPoints, 10, "柱狀體正值擴大得 10 分、負值擴大得 0 分，其餘 5 分。"),
    scoreItem("rsi-kd", "RSI／KD 動能", oscillatorPoints, 10, "RSI 50–70 且 K>D 得 10 分；弱勢條件得 2 分；其他情況得 6 分。"),
    scoreItem("divergence", "價格／RSI 背離觀察", divergencePoints, 5, "比較前後各 10 根日線的收盤極值與 RSI；出現高點背離得 0 分，其餘得 5 分。背離是簡化觀察，不是獨立買賣訊號。"),
    scoreItem("weekly-daily-alignment", "週線／日線趨勢一致性", trendAlignmentPoints, 5, `以週收盤對照 5／10 週均線，日線對照 20／60 日均線；週資料 ${weeklyCloses.length} 週。同步偏多得 5 分、同步偏弱得 0 分、趨勢相反得 1 分，部分一致得 3 分。`),
  ];
  const availablePoints = items.reduce((sum, item) => sum + (item.points === null ? 0 : item.maximumPoints), 0);
  const earnedPoints = items.reduce((sum, item) => sum + (item.points ?? 0), 0);
  return {
    earnedPoints,
    availablePoints,
    maximumPoints: 100,
    complete: availablePoints === 100,
    items,
    technicalIndicators: {
      ma5,
      ma10,
      ma20,
      ma60,
      ma5DeviationPercent: latest && ma5 !== null ? ((latest.close / ma5) - 1) * 100 : null,
      ma10DeviationPercent: latest && ma10 !== null ? ((latest.close / ma10) - 1) * 100 : null,
      ma20DeviationPercent: latest && ma20 !== null ? ((latest.close / ma20) - 1) * 100 : null,
      ma60DeviationPercent: latest && ma60 !== null ? ((latest.close / ma60) - 1) * 100 : null,
      rsi14: currentRsi,
      kdK: k,
      kdD: d,
      macdLine: macdSeries.at(-1) ?? null,
      macdSignal: signal.at(-1) ?? null,
      macdHistogram: histNow,
    },
    note: "只顯示可由本次資料計算的點數；不可用已得分除以可用分數換算成 100 分。評分是診斷資訊，不會覆蓋 AI 行動判斷。",
  };
}

function scenario(entry: number | null, target: number | null, stop: number | null): StockTradeScenario {
  if (entry === null || target === null || stop === null || entry <= 0 || target <= entry || stop >= entry) {
    return { entryPrice: entry, targetPrice: target, stopPrice: stop, profitPercent: null, lossPercent: null, rewardToRisk: null };
  }
  const profitPercent = ((target / entry) - 1) * 100;
  const lossPercent = (1 - stop / entry) * 100;
  return {
    entryPrice: entry,
    targetPrice: target,
    stopPrice: stop,
    profitPercent,
    lossPercent,
    rewardToRisk: lossPercent > 0 ? profitPercent / lossPercent : null,
  };
}

export function buildStockTradeScenarios(
  bars: ScorecardBar[],
  referencePrice: number,
): StockTradeScenarios {
  const last20 = bars.slice(-20);
  const last60 = bars.slice(-60);
  const supportPrice = last20.length === 20 ? Math.min(...last20.map((bar) => bar.low)) : null;
  const resistancePrice = last20.length === 20 ? Math.max(...last20.map((bar) => bar.high)) : null;
  const deepSupportPrice = last60.length === 60 ? Math.min(...last60.map((bar) => bar.low)) : null;
  const trueRanges = bars.slice(1).map((bar, index) => Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - bars[index]!.close),
    Math.abs(bar.low - bars[index]!.close),
  ));
  const atr14 = trueRanges.length >= 14
    ? average(trueRanges.slice(-14))
    : null;
  const atrStop = atr14 === null ? null : referencePrice - 1.5 * atr14;
  const supportStop = supportPrice !== null && supportPrice < referencePrice ? supportPrice : null;
  const directStop = [atrStop, supportStop]
    .filter((value): value is number => value !== null && value > 0 && value < referencePrice)
    .sort((a, b) => b - a)[0] ?? null;
  return {
    referencePrice,
    atr14,
    supportPrice,
    resistancePrice,
    deepSupportPrice,
    directEntry: scenario(referencePrice, resistancePrice, directStop),
    pullbackEntry: scenario(supportPrice, resistancePrice, deepSupportPrice),
    methodNote: `技術價位取最近 20 個交易日最低／最高價；深層支撐取最近 60 日最低價。ATR(14)${atr14 === null ? "未取得" : `為 ${atr14.toFixed(2)} 元`}；現價情境停損採現價減 1.5 倍 ATR 與低於現價的 20 日支撐中較高者。R/R 僅在價位順序有效時計算，試算不是買賣建議或保證。`,
  };
}
