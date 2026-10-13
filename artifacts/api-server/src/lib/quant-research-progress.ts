export type QuantResearchProgressStage =
  | "strategy"
  | "market-data"
  | "backtest"
  | "summary"
  | "saving";

export type QuantResearchProgress = {
  type: "progress";
  stage: QuantResearchProgressStage;
  message: string;
  current?: number;
  total?: number;
};

export type QuantResearchProgressCallback = (
  event: QuantResearchProgress,
) => void;
