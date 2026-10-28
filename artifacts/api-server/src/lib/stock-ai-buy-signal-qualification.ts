export const STOCK_AI_BUY_SIGNAL_MINIMUM_LOWER_BOUND_PERCENT = 80;

const WILSON_Z_95 = 1.959963984540054;

export function wilsonLowerBound(
  successes: number,
  sampleCount: number,
): number | null {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(sampleCount) ||
    sampleCount <= 0 ||
    successes < 0 ||
    successes > sampleCount
  ) {
    return null;
  }

  const zSquared = WILSON_Z_95 ** 2;
  const observedRate = successes / sampleCount;
  const denominator = 1 + zSquared / sampleCount;
  const center = observedRate + zSquared / (2 * sampleCount);
  const margin = WILSON_Z_95 * Math.sqrt(
    (observedRate * (1 - observedRate)) / sampleCount +
      zSquared / (4 * sampleCount ** 2),
  );

  return Math.max(0, (center - margin) / denominator) * 100;
}

export type BuySignalQualification = {
  qualified: boolean;
  directionLowerBoundPercent: number | null;
  pricePlanLowerBoundPercent: number | null;
  failures: string[];
};

export function evaluateStockAiBuySignalQualification(input: {
  directionSuccesses: number;
  directionSampleCount: number;
  pricePlanSuccesses: number;
  pricePlanSampleCount: number;
}): BuySignalQualification {
  const directionLowerBoundPercent = wilsonLowerBound(
    input.directionSuccesses,
    input.directionSampleCount,
  );
  const pricePlanLowerBoundPercent = wilsonLowerBound(
    input.pricePlanSuccesses,
    input.pricePlanSampleCount,
  );
  const failures: string[] = [];

  if (
    directionLowerBoundPercent === null ||
    directionLowerBoundPercent < STOCK_AI_BUY_SIGNAL_MINIMUM_LOWER_BOUND_PERCENT
  ) {
    failures.push(
      `5 日方向 95% 下限 ${directionLowerBoundPercent?.toFixed(1) ?? "—"}%（門檻 80%，目前 ${input.directionSampleCount} 筆）`,
    );
  }

  if (
    pricePlanLowerBoundPercent === null ||
    pricePlanLowerBoundPercent < STOCK_AI_BUY_SIGNAL_MINIMUM_LOWER_BOUND_PERCENT
  ) {
    failures.push(
      `價位方案 95% 下限 ${pricePlanLowerBoundPercent?.toFixed(1) ?? "—"}%（門檻 80%，目前 ${input.pricePlanSampleCount} 筆）`,
    );
  }

  return {
    qualified: failures.length === 0,
    directionLowerBoundPercent,
    pricePlanLowerBoundPercent,
    failures,
  };
}
