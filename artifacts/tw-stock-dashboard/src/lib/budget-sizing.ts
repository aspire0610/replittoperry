export const TAIWAN_STOCK_BUY_COMMISSION_RATE = 0.001425;

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
