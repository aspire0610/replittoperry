export type BuyPriceVerdictDisplayInput = {
  symbol: string;
  plannedBuyPrice: number;
  analysisAsOf: Date | string;
};

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.(TW|TWO)$/i, "");
}

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const timestamp =
    value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function matchesBuyVerdictInputs(
  verdict: BuyPriceVerdictDisplayInput | null | undefined,
  symbol: string,
  plannedBuyPrice: number,
): boolean {
  return Boolean(
    verdict &&
      normalizeSymbol(verdict.symbol) === normalizeSymbol(symbol) &&
      Number.isFinite(plannedBuyPrice) &&
      Math.abs(verdict.plannedBuyPrice - plannedBuyPrice) < 1e-8,
  );
}

export function usesDifferentAnalysisVersion(
  verdictAnalysisAsOf: Date | string | null | undefined,
  displayedAnalysisAsOf: Date | string | null | undefined,
): boolean {
  const verdictTimestamp = toTimestamp(verdictAnalysisAsOf);
  const displayedTimestamp = toTimestamp(displayedAnalysisAsOf);
  return (
    verdictTimestamp !== null &&
    displayedTimestamp !== null &&
    verdictTimestamp !== displayedTimestamp
  );
}
