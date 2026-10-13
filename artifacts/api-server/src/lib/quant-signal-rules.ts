export type QuantSignalFactor =
  | "momentum20"
  | "momentum60"
  | "liquidity20"
  | "volatility20";

export type QuantSignalCondition = {
  factor: QuantSignalFactor;
  operator: "gte" | "lte";
  threshold: number;
};

export type QuantSignalRule = {
  mode: "all" | "any";
  conditions: QuantSignalCondition[];
};

export type QuantSignalValues = Record<QuantSignalFactor, number>;
export type QuantSignalPurpose = "entry" | "exit";

const FACTOR_LIMITS: Record<QuantSignalFactor, [number, number]> = {
  momentum20: [-0.99, 3],
  momentum60: [-0.99, 3],
  liquidity20: [0, 1_000_000_000_000],
  volatility20: [0, 0.3],
};

const SIGNAL_FACTORS = new Set<QuantSignalFactor>(Object.keys(FACTOR_LIMITS) as
  QuantSignalFactor[]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedOperator(
  factor: QuantSignalFactor,
  purpose: QuantSignalPurpose,
): "gte" | "lte" {
  const entersOnHigher =
    factor === "momentum20" ||
    factor === "momentum60" ||
    factor === "liquidity20";
  if (purpose === "entry") return entersOnHigher ? "gte" : "lte";
  return entersOnHigher ? "lte" : "gte";
}

export function parseQuantSignalRule(
  value: unknown,
  purpose: QuantSignalPurpose,
): QuantSignalRule | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    (value.mode !== "all" && value.mode !== "any") ||
    !Array.isArray(value.conditions) ||
    value.conditions.length < 1 ||
    value.conditions.length > 3
  ) {
    return null;
  }

  const seenFactors = new Set<QuantSignalFactor>();
  const conditions: QuantSignalCondition[] = [];
  for (const condition of value.conditions) {
    if (
      !isRecord(condition) ||
      Object.keys(condition).length !== 3 ||
      typeof condition.factor !== "string" ||
      !SIGNAL_FACTORS.has(condition.factor as QuantSignalFactor) ||
      (condition.operator !== "gte" && condition.operator !== "lte") ||
      typeof condition.threshold !== "number" ||
      !Number.isFinite(condition.threshold)
    ) {
      return null;
    }

    const factor = condition.factor as QuantSignalFactor;
    const [minimum, maximum] = FACTOR_LIMITS[factor];
    if (
      seenFactors.has(factor) ||
      condition.operator !== expectedOperator(factor, purpose) ||
      condition.threshold < minimum ||
      condition.threshold > maximum
    ) {
      return null;
    }
    seenFactors.add(factor);
    conditions.push({
      factor,
      operator: condition.operator,
      threshold: condition.threshold,
    });
  }

  return { mode: value.mode, conditions };
}

export function matchesQuantSignalRule(
  rule: QuantSignalRule,
  values: QuantSignalValues,
): boolean {
  const matches = rule.conditions.map((condition) => {
    const actual = values[condition.factor];
    if (!Number.isFinite(actual)) return false;
    return condition.operator === "gte"
      ? actual >= condition.threshold
      : actual <= condition.threshold;
  });

  return rule.mode === "all"
    ? matches.every(Boolean)
    : matches.some(Boolean);
}
