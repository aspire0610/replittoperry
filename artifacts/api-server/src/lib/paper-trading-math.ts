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
