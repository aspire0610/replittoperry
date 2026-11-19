const PRICE_SCALE_TOLERANCE = 0.03;

/**
 * Resolves the known SPARK TAIFEX tick-detail scale difference against a quote
 * for the same contract. Return null when the ratio is not safely identifiable.
 */
export function resolveYuantaSparkTickPriceScale(
  latestTickBarClose: number,
  quotePrice: number,
): 1 | 10 | null {
  if (
    !Number.isFinite(latestTickBarClose) ||
    latestTickBarClose <= 0 ||
    !Number.isFinite(quotePrice) ||
    quotePrice <= 0
  ) return null;

  const quoteToBarRatio = quotePrice / latestTickBarClose;
  if (Math.abs(quoteToBarRatio - 1) <= PRICE_SCALE_TOLERANCE) return 1;
  if (Math.abs(quoteToBarRatio / 10 - 1) <= PRICE_SCALE_TOLERANCE) return 10;
  return null;
}

/**
 * A midnight SDK timestamp may carry only the trading date, not a quote time.
 * Such a quote is never a live price. It can establish the scale of an already
 * session/freshness-validated tick bar only when its price matches exactly.
 */
export function resolveYuantaSparkDateOnlyTickScale(
  latestTickBarClose: number,
  quotePrice: number,
  quoteAsOf: Date | null,
  barTime: Date,
): 1 | 10 | null {
  if (!quoteAsOf || !Number.isFinite(quoteAsOf.getTime()) || !Number.isFinite(barTime.getTime())) return null;
  const quoteLocal = new Date(quoteAsOf.getTime() + 8 * 60 * 60_000).toISOString();
  const barLocal = new Date(barTime.getTime() + 8 * 60 * 60_000).toISOString();
  if (
    !quoteLocal.endsWith("T00:00:00.000Z") ||
    quoteLocal.slice(0, 10) !== barLocal.slice(0, 10)
  ) return null;
  const scale = resolveYuantaSparkTickPriceScale(latestTickBarClose, quotePrice);
  return scale !== null && Math.abs(latestTickBarClose * scale - quotePrice) < 0.000001
    ? scale
    : null;
}
