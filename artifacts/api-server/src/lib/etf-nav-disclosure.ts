export type EtfNavDisclosure = {
  marketPrice: number | null;
  netAssetValue: number | null;
  discountPremiumAmount: number | null;
  discountPremiumPercent: number | null;
  updatedAt: string | null;
};

type EtfDisclosureRow = {
  a?: unknown;
  e?: unknown;
  f?: unknown;
  i?: unknown;
  j?: unknown;
};

type EtfDisclosureGroup = {
  msgArray?: unknown;
};

type EtfDisclosurePayload = {
  a1?: unknown;
};

function positiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.replaceAll(",", ""))
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseUpdatedAt(date: unknown, time: unknown): string | null {
  if (
    typeof date !== "string" ||
    !/^\d{8}$/.test(date) ||
    typeof time !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)
  ) {
    return null;
  }

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time}+08:00`;
}

export function parseEtfNavDisclosure(payload: unknown): Map<string, EtfNavDisclosure> {
  const groups = (payload as EtfDisclosurePayload | null)?.a1;
  if (!Array.isArray(groups)) return new Map();

  const disclosures = new Map<string, EtfNavDisclosure>();
  for (const group of groups as EtfDisclosureGroup[]) {
    if (!Array.isArray(group?.msgArray)) continue;

    for (const row of group.msgArray as EtfDisclosureRow[]) {
      if (typeof row?.a !== "string" || !/^00[A-Z0-9]{2,4}$/i.test(row.a)) {
        continue;
      }

      const marketPrice = positiveNumber(row.e);
      const netAssetValue = positiveNumber(row.f);
      const updatedAt = parseUpdatedAt(row.i, row.j);
      const discountPremiumAmount =
        marketPrice !== null && netAssetValue !== null
          ? marketPrice - netAssetValue
          : null;
      const disclosure: EtfNavDisclosure = {
        marketPrice,
        netAssetValue,
        discountPremiumAmount,
        discountPremiumPercent:
          discountPremiumAmount !== null && netAssetValue !== null
            ? (discountPremiumAmount / netAssetValue) * 100
            : null,
        updatedAt,
      };

      const symbol = row.a.toUpperCase();
      const previous = disclosures.get(symbol);
      if (
        !previous ||
        (updatedAt !== null &&
          (previous.updatedAt === null || updatedAt > previous.updatedAt))
      ) {
        disclosures.set(symbol, disclosure);
      }
    }
  }

  return disclosures;
}
