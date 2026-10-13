import type { QuantWeekday } from "./quant-backtest.js";

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  兩: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function parseChineseAmount(value: string): number {
  if (/^[\d,]+$/.test(value)) return Number(value.replace(/,/g, ""));
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of value) {
    if (char in CHINESE_DIGITS) {
      digit = CHINESE_DIGITS[char]!;
    } else if (char === "十" || char === "百" || char === "千") {
      const unit = char === "十" ? 10 : char === "百" ? 100 : 1000;
      section += (digit || 1) * unit;
      digit = 0;
    } else if (char === "萬" || char === "万") {
      total += (section + digit) * 10000;
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

export function parseRecurringContribution(
  hypothesis: string,
): { amount: number; weekday: QuantWeekday } | null {
  const weekdayMatch = hypothesis.match(/每\s*(?:週|周)\s*([一二三四五])/u);
  const amountMatch = hypothesis.match(
    /([\d,]+|[零〇一二兩两三四五六七八九十百千萬万]+)\s*(?:元|塊)/u,
  );
  if (!weekdayMatch || !amountMatch) return null;
  const weekdays: Record<string, QuantWeekday> = {
    一: "monday",
    二: "tuesday",
    三: "wednesday",
    四: "thursday",
    五: "friday",
  };
  const amount = parseChineseAmount(amountMatch[1]!);
  return Number.isFinite(amount) && amount > 0
    ? { amount, weekday: weekdays[weekdayMatch[1]!]! }
    : null;
}
