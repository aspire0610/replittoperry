export type ChipExhaustionInputBar = {
  date: string;
  close: number;
  high: number;
  low: number;
  volume: number | null;
};

export type ChipExhaustionInstitutionalData = {
  status: string;
  observedAt: string | null;
  totalNetShares: number | null;
};

export type ChipExhaustionResult = {
  status: "seller_exhaustion" | "buyer_exhaustion" | "mixed" | "unavailable";
  label: string;
  explanation: string;
  details: {
    date: string;
    return5dPercent: number;
    volumeRatio20: number;
    institutionalNetShares: number;
  } | null;
};

const unavailable = (explanation: string): ChipExhaustionResult => ({
  status: "unavailable",
  label: "資料不足",
  explanation,
  details: null,
});

function calendarDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}/u.exec(value)?.[0] ?? null;
}

export function evaluateChipExhaustion(
  bars: ChipExhaustionInputBar[],
  institutional: ChipExhaustionInstitutionalData | undefined,
): ChipExhaustionResult {
  const latest = bars.at(-1);
  if (!latest) return unavailable("沒有可用的官方日線資料。");
  if (
    !institutional ||
    institutional.status !== "available" ||
    institutional.totalNetShares === null ||
    !Number.isFinite(institutional.totalNetShares)
  ) {
    return unavailable("缺少同一交易日的官方投資機構買賣資料。");
  }
  if (calendarDate(institutional.observedAt) !== calendarDate(latest.date)) {
    return unavailable("日線與投資機構資料日期不同，暫不合併判讀。");
  }
  if (bars.length < 21) {
    return unavailable("官方日線未滿 21 個交易日，無法比較近 20 日均量。");
  }

  const previousVolumes = bars
    .slice(-21, -1)
    .map((bar) => bar.volume)
    .filter((value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
    );
  const startBar = bars.at(-6);
  if (
    previousVolumes.length < 20 ||
    latest.volume === null ||
    !Number.isFinite(latest.volume) ||
    latest.volume <= 0 ||
    !startBar ||
    !Number.isFinite(startBar.close) ||
    startBar.close <= 0 ||
    !Number.isFinite(latest.close) ||
    !Number.isFinite(latest.high) ||
    !Number.isFinite(latest.low) ||
    latest.high <= latest.low ||
    latest.close < latest.low ||
    latest.close > latest.high
  ) {
    return unavailable("日線的價格或成交量資料不完整，暫不推估。");
  }

  const averageVolume =
    previousVolumes.reduce((sum, value) => sum + value, 0) /
    previousVolumes.length;
  if (!Number.isFinite(averageVolume) || averageVolume <= 0) {
    return unavailable("近 20 日成交量不足，暫不推估。");
  }

  const return5dPercent = ((latest.close / startBar.close) - 1) * 100;
  const volumeRatio20 = latest.volume / averageVolume;
  const closeLocation = (latest.close - latest.low) / (latest.high - latest.low);
  const netShares = institutional.totalNetShares;
  const details = {
    date: calendarDate(latest.date) ?? latest.date,
    return5dPercent: Number(return5dPercent.toFixed(2)),
    volumeRatio20: Number(volumeRatio20.toFixed(2)),
    institutionalNetShares: netShares,
  };

  if (
    return5dPercent < 0 &&
    volumeRatio20 >= 1.2 &&
    closeLocation >= 0.7 &&
    netShares > 0
  ) {
    return {
      status: "seller_exhaustion",
      label: "賣方力道可能轉弱",
      explanation:
        "近 5 日股價下跌、當日成交量高於近 20 日均量，收盤靠近日高，且投資機構當日合計買超；這是賣方力道可能減弱的推估，不是買進訊號。",
      details,
    };
  }

  if (
    return5dPercent > 0 &&
    volumeRatio20 >= 1.2 &&
    closeLocation <= 0.3 &&
    netShares < 0
  ) {
    return {
      status: "buyer_exhaustion",
      label: "買方力道可能轉弱",
      explanation:
        "近 5 日股價上漲、當日成交量高於近 20 日均量，收盤靠近日低，且投資機構當日合計賣超；這是買方力道可能減弱的推估，不是賣出訊號。",
      details,
    };
  }

  return {
    status: "mixed",
    label: "沒有一致的耗竭跡象",
    explanation:
      "近 5 日走勢、當日量價與投資機構日買賣未同時符合耗竭條件。",
    details,
  };
}
