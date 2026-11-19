export type PaperTradeCostsInput = {
  side: "buy" | "sell";
  shares: number;
  price: number;
  isFundOrEtf: boolean;
};

export type PaperTradeCosts = {
  price: number;
  grossAmount: number;
  commission: number;
  transactionTax: number;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculatePaperTradeCosts(
  input: PaperTradeCostsInput,
): PaperTradeCosts {
  const grossAmount = roundMoney(input.price * input.shares);
  const commission = roundMoney(grossAmount * 0.001425);
  const transactionTax =
    input.side === "sell"
      ? roundMoney(grossAmount * (input.isFundOrEtf ? 0.001 : 0.003))
      : 0;
  return {
    price: input.price,
    grossAmount,
    commission,
    transactionTax,
  };
}

export type RealizedPaperTradePnlInput = {
  assetClass: "equity" | "futures";
  shares: number;
  entryPrice: number;
  exitPrice: number;
  direction?: "long" | "short";
  contractMultiplier?: number;
  isFundOrEtf: boolean;
};

export function calculateRealizedPaperTradePnl(
  input: RealizedPaperTradePnlInput,
): number {
  if (input.assetClass === "futures") {
    const direction = input.direction === "short" ? -1 : 1;
    return roundMoney(
      (input.exitPrice - input.entryPrice) *
        input.shares *
        (input.contractMultiplier ?? 0) *
        direction,
    );
  }

  const entryCosts = calculatePaperTradeCosts({
    side: "buy",
    shares: input.shares,
    price: input.entryPrice,
    isFundOrEtf: input.isFundOrEtf,
  });
  const exitCosts = calculatePaperTradeCosts({
    side: "sell",
    shares: input.shares,
    price: input.exitPrice,
    isFundOrEtf: input.isFundOrEtf,
  });

  return roundMoney(
    exitCosts.grossAmount -
      exitCosts.commission -
      exitCosts.transactionTax -
      entryCosts.grossAmount -
      entryCosts.commission,
  );
}
