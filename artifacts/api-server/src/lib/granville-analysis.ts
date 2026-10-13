import type { StockAiAssessment } from "@workspace/api-zod";

type GranvilleBar = {
  date: string;
  high: number;
  low: number;
  close: number;
};

type GranvilleAnalysis = StockAiAssessment["granvilleAnalysis"];
type GranvilleSignal = GranvilleAnalysis["signals"][number];

const MOVING_AVERAGE_PERIOD = 20;
const SLOPE_LOOKBACK = 5;

function round(value: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function average(values: number[]): number | null {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function movingAverageAt(
  closes: number[],
  endIndex: number,
): number | null {
  const startIndex = endIndex - MOVING_AVERAGE_PERIOD + 1;
  if (startIndex < 0) return null;
  return average(closes.slice(startIndex, endIndex + 1));
}

function calculateAtr14(bars: GranvilleBar[]): number | null {
  if (bars.length < 15) return null;
  const firstIndex = bars.length - 14;
  const trueRanges = [];
  for (let index = firstIndex; index < bars.length; index += 1) {
    const current = bars[index];
    const previousClose = bars[index - 1]?.close;
    if (previousClose === undefined) return null;
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose),
      ),
    );
  }
  return average(trueRanges);
}

function makeSignal(
  id: GranvilleSignal["id"],
  direction: GranvilleSignal["direction"],
  available: boolean,
  candidate: boolean,
  candidateExplanation: string,
  notDetectedExplanation: string,
  contextual = false,
  contextualExplanation = "",
): GranvilleSignal {
  return {
    id,
    direction,
    status: !available
      ? "insufficient"
      : candidate
        ? "candidate"
        : contextual
          ? "contextual"
          : "not_detected",
    explanation: !available
      ? "日線資料不足，無法確認此條件。"
      : candidate
        ? candidateExplanation
        : contextual
          ? contextualExplanation
          : notDetectedExplanation,
  };
}

export function analyzeGranvilleRules(
  bars: GranvilleBar[],
): GranvilleAnalysis {
  const closes = bars.map((bar) => bar.close);
  const movingAverages = bars.map((_, index) =>
    movingAverageAt(closes, index),
  );
  const latestBar = bars.at(-1);
  const latestAverage = movingAverages.at(-1) ?? null;
  const enoughSlopeHistory = bars.length >= MOVING_AVERAGE_PERIOD + SLOPE_LOOKBACK;
  const priorAverage =
    enoughSlopeHistory
      ? movingAverages.at(-(SLOPE_LOOKBACK + 1)) ?? null
      : null;
  const slopePercent =
    latestAverage !== null && priorAverage !== null && priorAverage > 0
      ? ((latestAverage / priorAverage) - 1) * 100
      : null;
  const averageTrend: GranvilleAnalysis["averageTrend"] =
    slopePercent === null
      ? "insufficient"
      : slopePercent > 0
        ? "rising"
        : slopePercent < 0
          ? "falling"
          : "flat";
  const atr14 = calculateAtr14(bars);
  const distanceAtr =
    latestBar && latestAverage !== null && atr14 !== null && atr14 > 0
      ? (latestBar.close - latestAverage) / atr14
      : null;
  const distancePercent =
    latestBar && latestAverage !== null && latestAverage > 0
      ? ((latestBar.close / latestAverage) - 1) * 100
      : null;
  const previousBar = bars.at(-2);
  const previousAverage = movingAverages.at(-2) ?? null;
  const dataAvailable =
    bars.length >= MOVING_AVERAGE_PERIOD + SLOPE_LOOKBACK &&
    latestBar !== undefined &&
    latestAverage !== null &&
    previousBar !== undefined &&
    previousAverage !== null;
  const latestClose = latestBar?.close ?? null;
  const previousClose = previousBar?.close ?? null;
  const latestLow = latestBar?.low ?? null;
  const latestHigh = latestBar?.high ?? null;
  const lowDistancePercent =
    latestLow !== null && latestAverage !== null && latestAverage > 0
      ? ((latestLow / latestAverage) - 1) * 100
      : null;
  const highDistancePercent =
    latestHigh !== null && latestAverage !== null && latestAverage > 0
      ? ((latestHigh / latestAverage) - 1) * 100
      : null;
  const underLatestAverage =
    latestClose !== null &&
    latestAverage !== null &&
    latestClose < latestAverage;
  const aboveLatestAverage =
    latestClose !== null &&
    latestAverage !== null &&
    latestClose > latestAverage;

  const signals: GranvilleSignal[] = [
    makeSignal(
      "buy_breakout",
      "buy",
      dataAvailable,
      averageTrend !== "falling" &&
        previousClose !== null &&
        previousAverage !== null &&
        latestClose !== null &&
        latestAverage !== null &&
        previousClose <= previousAverage &&
        latestClose > latestAverage,
      "收盤價由 20 日平均價下方穿越至上方；平均價近 5 個交易日持平或上升。",
      "最近一日沒有由平均價下方收盤轉為上方的突破。",
    ),
    makeSignal(
      "buy_retest",
      "buy",
      dataAvailable,
      averageTrend === "rising" &&
        previousClose !== null &&
        previousAverage !== null &&
        latestAverage !== null &&
        latestLow !== null &&
        latestClose !== null &&
        previousClose > previousAverage &&
        latestClose > latestAverage &&
        latestLow <= latestAverage,
      "20 日平均價近 5 個交易日上升；收盤仍在平均價上方，當日低點觸及或跌破平均價後收回。",
      "最近一日未同時出現上升平均價、價格在平均價上方及回到平均價。",
      averageTrend === "rising" &&
        previousClose !== null &&
        previousAverage !== null &&
        latestAverage !== null &&
        latestLow !== null &&
        latestClose !== null &&
        previousClose > previousAverage &&
        latestClose > latestAverage &&
        latestLow > latestAverage,
      lowDistancePercent !== null
        ? `平均價上升且收盤仍在上方；當日最低價高於平均價 ${lowDistancePercent.toFixed(2)}%，頁面不自設「接近」門檻。`
        : "平均價上升且收盤在上方；當日低點與平均價的距離需一併判讀。",
    ),
    makeSignal(
      "buy_false_breakdown",
      "buy",
      dataAvailable,
      averageTrend === "rising" &&
        latestClose !== null &&
        latestAverage !== null &&
        latestClose > latestAverage &&
        latestLow !== null &&
        latestLow < latestAverage,
      "20 日平均價近 5 個交易日上升；當日低點跌到平均價下方，收盤重新站回上方。",
      "當日未出現上升平均價下的跌破後收回。",
    ),
    makeSignal(
      "buy_rebound",
      "buy",
      dataAvailable && distancePercent !== null,
      false,
      "",
      "收盤目前不在下彎平均價下方。",
      averageTrend === "falling" && underLatestAverage,
      distancePercent !== null
        ? `收盤低於下彎平均價 ${Math.abs(distancePercent).toFixed(2)}%${distanceAtr === null ? "" : `，約 ${Math.abs(distanceAtr).toFixed(2)} 倍近 14 日平均波動`}；「遠離」沒有固定門檻，下跌仍可能延續。`
        : "收盤低於下彎平均價；實際距離資料不足，不能判斷是否屬於偏遠情境。",
    ),
    makeSignal(
      "sell_breakdown",
      "sell",
      dataAvailable,
      averageTrend !== "rising" &&
        previousClose !== null &&
        previousAverage !== null &&
        latestClose !== null &&
        latestAverage !== null &&
        previousClose >= previousAverage &&
        latestClose < latestAverage,
      "平均價近 5 個交易日持平或下彎；最新收盤由上方跌至平均價下方。",
      "最近一日沒有在平均價持平或下彎時由上方收盤跌至下方。",
    ),
    makeSignal(
      "sell_resistance",
      "sell",
      dataAvailable,
      averageTrend === "falling" &&
        previousClose !== null &&
        previousAverage !== null &&
        latestHigh !== null &&
        latestAverage !== null &&
        latestClose !== null &&
        previousClose < previousAverage &&
        latestClose < latestAverage &&
        latestHigh >= latestAverage,
      "20 日平均價近 5 個交易日下彎；當日高點觸及或越過平均價後，收盤仍在下方。",
      "最近一日未同時出現下彎平均價、價格回到平均價及收在下方。",
      averageTrend === "falling" &&
        previousClose !== null &&
        previousAverage !== null &&
        latestHigh !== null &&
        latestAverage !== null &&
        latestClose !== null &&
        previousClose < previousAverage &&
        latestClose < latestAverage &&
        latestHigh < latestAverage,
      highDistancePercent !== null
        ? `平均價下彎且收盤仍在下方；當日最高價低於平均價 ${Math.abs(highDistancePercent).toFixed(2)}%，頁面不自設「接近」門檻。`
        : "平均價下彎且收盤在下方；當日高點與平均價的距離需一併判讀。",
    ),
    makeSignal(
      "sell_false_breakout",
      "sell",
      dataAvailable,
      averageTrend === "falling" &&
        underLatestAverage &&
        latestHigh !== null &&
        latestAverage !== null &&
        latestHigh > latestAverage,
      "20 日平均價近 5 個交易日下彎；當日高點短暫越過平均價，收盤又回到下方。",
      "當日未出現下彎平均價上的越過後收回。",
    ),
    makeSignal(
      "sell_overextension",
      "sell",
      dataAvailable && distancePercent !== null,
      false,
      "",
      "收盤目前不在 20 日平均價上方。",
      aboveLatestAverage,
      distancePercent !== null
        ? `收盤高於 20 日平均價 ${distancePercent.toFixed(2)}%${distanceAtr === null ? "" : `，約 ${Math.abs(distanceAtr).toFixed(2)} 倍近 14 日平均波動`}；「遠離」沒有固定門檻，價格仍可能延續上漲。`
        : "收盤高於 20 日平均價；實際距離資料不足，不能判斷是否屬於偏遠情境。",
    ),
  ];

  return {
    status: dataAvailable ? "available" : "insufficient",
    timeframe: "daily",
    sourceDate: latestBar
      ? new Date(`${latestBar.date}T00:00:00.000Z`)
      : null,
    movingAveragePeriod: MOVING_AVERAGE_PERIOD,
    latestClose: latestClose === null ? null : round(latestClose, 3),
    movingAverage:
      latestAverage === null ? null : round(latestAverage, 3),
    slopePercent5d:
      slopePercent === null ? null : round(slopePercent, 3),
    averageTrend,
    distancePercent:
      distancePercent === null ? null : round(distancePercent, 3),
    distanceAtr: distanceAtr === null ? null : round(distanceAtr, 2),
    signals,
    methodNote:
      "以最近完成日線及 20 日簡單平均價計算；平均價方向比較近 5 個交易日的實際變化，不另設走平百分比。明確的收盤穿越或日內觸及後收回才標記為候選。「接近／遠離」沒有統一距離，本頁只顯示實際價差與近 14 日平均波動倍數，不自設進出場門檻。均線有滯後，短期圖形也可能出現假訊號；這些線索未經歷史回測，不是勝率或買賣指令。",
  };
}
