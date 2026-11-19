export type StockForceBar = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export function calculateStockForce(bars: StockForceBar[]): number | null {
  const recent = bars.filter((bar) =>
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
    bar.close <= bar.high,
  ).slice(-5);
  const totalVolume = recent.reduce((sum, bar) => sum + (bar.volume ?? 0), 0);
  if (recent.length < 3 || totalVolume <= 0) return null;

  const weightedBody = recent.reduce((sum, bar) => {
    const range = bar.high - bar.low;
    const bodyStrength = range > 0 ? (bar.close - bar.open) / range : 0;
    return sum + bodyStrength * (bar.volume ?? 0);
  }, 0);
  return Math.round(weightedBody / totalVolume * 100);
}
