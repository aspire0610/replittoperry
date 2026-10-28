export type WalkForwardWindow = {
  index: number;
  trainStartDate: string;
  trainEndDate: string;
  validationStartDate: string;
  validationEndDate: string;
};

export type MonteCarloRisk = {
  method: string;
  simulationCount: number;
  sampledSessions: number;
  probabilityOfLossPercent: number | null;
  terminalReturnP05Percent: number | null;
  terminalReturnMedianPercent: number | null;
  terminalReturnP95Percent: number | null;
  maxDrawdownP95Percent: number | null;
  terminalReturnBuckets: Array<{ range: string; count: number }>;
};

export function createWalkForwardWindows(
  dates: string[],
  foldCount = 3,
): WalkForwardWindow[] {
  if (dates.length < 2 || !Number.isInteger(foldCount) || foldCount < 1) return [];
  const feasibleFolds = Math.floor((dates.length - 20) / 20);
  const actualFoldCount = Math.min(foldCount, feasibleFolds);
  if (actualFoldCount < 1) return [];
  const validationSize = 20;
  const initialTrainSize = dates.length - actualFoldCount * validationSize;
  const windows: WalkForwardWindow[] = [];
  for (let fold = 0; fold < actualFoldCount; fold += 1) {
    const trainEndIndex = initialTrainSize + validationSize * fold;
    const validationEndIndex = trainEndIndex + validationSize;
    if (trainEndIndex < 1 || validationEndIndex <= trainEndIndex) continue;
    windows.push({
      index: fold + 1,
      trainStartDate: dates[0]!,
      trainEndDate: dates[trainEndIndex - 1]!,
      validationStartDate: dates[trainEndIndex]!,
      validationEndDate: dates[validationEndIndex - 1]!,
    });
  }
  return windows;
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

function quantile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? null;
}

export function calculateMonteCarloRisk(
  equityCurves: Array<Array<{ equity: number }>>,
  seedKey: string,
  simulationCount = 1_000,
): MonteCarloRisk {
  const dailyReturns: number[] = [];
  for (const curve of equityCurves) {
    for (let index = 1; index < curve.length; index += 1) {
      const previous = curve[index - 1]!.equity;
      const current = curve[index]!.equity;
      const dailyReturn = previous > 0 ? current / previous - 1 : Number.NaN;
      if (Number.isFinite(dailyReturn) && dailyReturn > -1) dailyReturns.push(dailyReturn);
    }
  }
  if (dailyReturns.length < 20 || dailyReturns.filter((value) => Math.abs(value) > 1e-12).length < 5) {
    return {
      method: "Walk-forward 樣本外日報酬有放回抽樣",
      simulationCount: 0,
      sampledSessions: dailyReturns.length,
      probabilityOfLossPercent: null,
      terminalReturnP05Percent: null,
      terminalReturnMedianPercent: null,
      terminalReturnP95Percent: null,
      maxDrawdownP95Percent: null,
      terminalReturnBuckets: [],
    };
  }

  let randomState = hashSeed(seedKey);
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x1_0000_0000;
  };
  const finalReturns: number[] = [];
  const maxDrawdowns: number[] = [];
  for (let simulation = 0; simulation < simulationCount; simulation += 1) {
    let equity = 1;
    let peak = 1;
    let maximumDrawdown = 0;
    for (let session = 0; session < dailyReturns.length; session += 1) {
      equity *= 1 + dailyReturns[Math.floor(random() * dailyReturns.length)]!;
      peak = Math.max(peak, equity);
      if (peak > 0) maximumDrawdown = Math.max(maximumDrawdown, (peak - equity) / peak);
    }
    finalReturns.push((equity - 1) * 100);
    maxDrawdowns.push(maximumDrawdown * 100);
  }

  const bucketEdges = [-50, -20, -10, 0, 10, 20, 50, 100];
  const terminalReturnBuckets = bucketEdges.slice(0, -1).map((start, index) => {
    const end = bucketEdges[index + 1]!;
    return {
      range: `${start}% to ${end}%`,
      count: finalReturns.filter((value) => value >= start && value < end).length,
    };
  });
  terminalReturnBuckets.push({
    range: "100%+",
    count: finalReturns.filter((value) => value >= 100).length,
  });

  return {
    method: "Walk-forward 樣本外日報酬有放回抽樣",
    simulationCount,
    sampledSessions: dailyReturns.length,
    probabilityOfLossPercent: (finalReturns.filter((value) => value < 0).length / simulationCount) * 100,
    terminalReturnP05Percent: quantile(finalReturns, 0.05),
    terminalReturnMedianPercent: quantile(finalReturns, 0.5),
    terminalReturnP95Percent: quantile(finalReturns, 0.95),
    maxDrawdownP95Percent: quantile(maxDrawdowns, 0.95),
    terminalReturnBuckets,
  };
}
