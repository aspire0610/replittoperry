export const TAIWAN_STOCK_BUY_COMMISSION_RATE = 0.001425;
export const TAIWAN_STOCK_SHARES_PER_LOT = 1_000;

export type BudgetLotEstimate = {
  lots: number;
  shares: number;
  estimatedBuyNotional: number;
  estimatedBuyCommission: number;
  estimatedBuyCost: number;
  remainingBudget: number;
};

export type BudgetEntryCandidate = {
  referenceType: string;
  referenceAsOf: string | null;
  referencePrice: number;
  operationPlan: {
    action: string;
    entryPrice: number | null;
    stopPrice: number | null;
    targetPrice: number | null;
  };
};

export function isTaiwanStockBudgetEntryWindow(nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const taipeiTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(nowMs));
  const currentMinute =
    Number(taipeiTime.slice(0, 2)) * 60 + Number(taipeiTime.slice(3, 5));
  return currentMinute >= 600 && currentMinute <= 750;
}

export function isCurrentVerifiedEntryCandidate(
  candidate: BudgetEntryCandidate,
  nowMs: number,
): boolean {
  const quoteTime = candidate.referenceAsOf
    ? Date.parse(candidate.referenceAsOf)
    : Number.NaN;
  const quoteAge = nowMs - quoteTime;
  const plan = candidate.operationPlan;
  return Boolean(
    isTaiwanStockBudgetEntryWindow(nowMs) &&
      candidate.referenceType === "verified_trade" &&
      Number.isFinite(quoteTime) &&
      quoteAge >= 0 &&
      quoteAge <= 180_000 &&
      Number.isFinite(candidate.referencePrice) &&
      candidate.referencePrice > 0 &&
      plan.action === "conditional_entry" &&
      plan.entryPrice !== null &&
      plan.stopPrice !== null &&
      plan.targetPrice !== null &&
      plan.stopPrice < candidate.referencePrice &&
      candidate.referencePrice <= plan.entryPrice &&
      plan.entryPrice < plan.targetPrice,
  );
}

export type RoundTripEstimate = {
  buyNotional: number;
  buyCommission: number;
  estimatedBuyCost: number;
  sellNotional: number;
  sellCommission: number;
  estimatedSellProceeds: number;
  estimatedProfitLossBeforeTax: number;
};

export function calculateBudgetShareLimit(
  budgetLimit: number,
  sharePrice: number,
): number | null {
  if (
    !Number.isFinite(budgetLimit) ||
    budgetLimit <= 0 ||
    !Number.isFinite(sharePrice) ||
    sharePrice <= 0
  ) {
    return null;
  }

  const estimatedCostPerShare =
    sharePrice * (1 + TAIWAN_STOCK_BUY_COMMISSION_RATE);
  const shareLimit = Math.floor(budgetLimit / estimatedCostPerShare);
  if (!Number.isSafeInteger(shareLimit)) return null;
  return Math.max(0, shareLimit);
}

export function calculateBudgetLotEstimate(
  budgetLimit: number,
  sharePrice: number,
): BudgetLotEstimate | null {
  const shareLimit = calculateBudgetShareLimit(budgetLimit, sharePrice);
  if (shareLimit === null) return null;

  const lots = Math.floor(shareLimit / TAIWAN_STOCK_SHARES_PER_LOT);
  const shares = lots * TAIWAN_STOCK_SHARES_PER_LOT;
  const estimatedBuyNotional = shares * sharePrice;
  const estimatedBuyCommission =
    estimatedBuyNotional * TAIWAN_STOCK_BUY_COMMISSION_RATE;
  const estimatedBuyCost = estimatedBuyNotional + estimatedBuyCommission;
  const remainingBudget = Math.max(0, budgetLimit - estimatedBuyCost);

  if (
    !Number.isSafeInteger(lots) ||
    ![
      estimatedBuyNotional,
      estimatedBuyCommission,
      estimatedBuyCost,
      remainingBudget,
    ].every(Number.isFinite)
  ) {
    return null;
  }

  return {
    lots,
    shares,
    estimatedBuyNotional,
    estimatedBuyCommission,
    estimatedBuyCost,
    remainingBudget,
  };
}

export function calculateRoundTripEstimate(
  buyPrice: number,
  sellPrice: number,
  shares: number,
): RoundTripEstimate | null {
  if (
    !Number.isFinite(buyPrice) ||
    buyPrice <= 0 ||
    !Number.isFinite(sellPrice) ||
    sellPrice <= 0 ||
    !Number.isSafeInteger(shares) ||
    shares < 1
  ) {
    return null;
  }

  const buyNotional = buyPrice * shares;
  const buyCommission =
    buyNotional * TAIWAN_STOCK_BUY_COMMISSION_RATE;
  const estimatedBuyCost = buyNotional + buyCommission;
  const sellNotional = sellPrice * shares;
  const sellCommission =
    sellNotional * TAIWAN_STOCK_BUY_COMMISSION_RATE;
  const estimatedSellProceeds = sellNotional - sellCommission;
  const estimatedProfitLossBeforeTax =
    estimatedSellProceeds - estimatedBuyCost;

  if (
    ![
      buyNotional,
      buyCommission,
      estimatedBuyCost,
      sellNotional,
      sellCommission,
      estimatedSellProceeds,
      estimatedProfitLossBeforeTax,
    ].every(Number.isFinite)
  ) {
    return null;
  }

  return {
    buyNotional,
    buyCommission,
    estimatedBuyCost,
    sellNotional,
    sellCommission,
    estimatedSellProceeds,
    estimatedProfitLossBeforeTax,
  };
}
