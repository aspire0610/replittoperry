import type { StockForceBar } from "./stock-force";

export type VolumePressureDirection = "bullish" | "bearish" | "neutral";

export type VolumePressure = {
  direction: VolumePressureDirection;
  upVolume: number;
  downVolume: number;
  flatVolume: number;
  totalVolume: number;
  barCount: number;
};

const isValidTradedBar = (bar: StockForceBar) =>
  Number.isFinite(bar.open) &&
  Number.isFinite(bar.high) &&
  Number.isFinite(bar.low) &&
  Number.isFinite(bar.close) &&
  bar.volume !== null &&
  Number.isFinite(bar.volume) &&
  bar.volume > 0 &&
  bar.high >= bar.low &&
  bar.open >= bar.low &&
  bar.open <= bar.high &&
  bar.close >= bar.low &&
  bar.close <= bar.high;

/**
 * Describes estimated candle-direction volume distribution, not aggressor-side
 * volume. Uses the latest five valid traded bars, matching stock-force.
 */
export function calculateVolumePressure(bars: StockForceBar[]): VolumePressure | null {
  const recent = bars.filter(isValidTradedBar).slice(-5);
  if (recent.length < 3) return null;

  const result = recent.reduce(
    (totals, bar) => {
      const volume = bar.volume ?? 0;
      if (bar.close > bar.open) totals.upVolume += volume;
      else if (bar.close < bar.open) totals.downVolume += volume;
      else totals.flatVolume += volume;
      return totals;
    },
    { upVolume: 0, downVolume: 0, flatVolume: 0 },
  );
  const totalVolume = result.upVolume + result.downVolume + result.flatVolume;
  const direction = result.upVolume > result.downVolume
    ? "bullish"
    : result.downVolume > result.upVolume
      ? "bearish"
      : "neutral";

  return { ...result, direction, totalVolume, barCount: recent.length };
}
