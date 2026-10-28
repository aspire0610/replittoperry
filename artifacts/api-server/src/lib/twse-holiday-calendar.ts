const TWSE_HOLIDAY_URL =
  "https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule";
const CALENDAR_CACHE_MS = 24 * 60 * 60 * 1_000;
const CALENDAR_TIMEOUT_MS = 4_000;
const TAIPEI_TIME_ZONE = "Asia/Taipei";

type HolidayCalendarEntry = {
  expiresAt: number;
  dates: Set<string>;
};

const holidayCalendarCache = new Map<number, HolidayCalendarEntry>();
const holidayCalendarRequests = new Map<number, Promise<Set<string> | null>>();

function taipeiDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TAIPEI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isTaipeiWeekend(date: Date): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: TAIPEI_TIME_ZONE,
    weekday: "short",
  }).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

export function parseTwseHolidayDates(payload: unknown, year: number): Set<string> | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { stat?: unknown; data?: unknown };
  if (record.stat !== "ok" || !Array.isArray(record.data) || record.data.length === 0) {
    return null;
  }

  const dates = new Set<string>();
  for (const row of record.data) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const [date, name, description] = row;
    if (typeof date !== "string" || typeof name !== "string" || typeof description !== "string") {
      continue;
    }
    if (!new RegExp(`^${year}-\\d{2}-\\d{2}$`).test(date)) continue;

    const details = `${name} ${description}`;
    if (
      /(市場無交易|放假|補假|休市|非交易日)/u.test(details) &&
      !/(最後交易日|開始交易日)/u.test(details)
    ) {
      dates.add(date);
    }
  }
  return dates;
}

async function fetchHolidayDates(year: number): Promise<Set<string> | null> {
  const cached = holidayCalendarCache.get(year);
  if (cached && cached.expiresAt > Date.now()) return cached.dates;

  const pending = holidayCalendarRequests.get(year);
  if (pending) return pending;

  const request = (async () => {
    const url = new URL(TWSE_HOLIDAY_URL);
    url.searchParams.set("queryYear", String(year));
    url.searchParams.set("response", "json");
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const dates = parseTwseHolidayDates(await response.json(), year);
      if (!dates) return null;
      holidayCalendarCache.set(year, {
        expiresAt: Date.now() + CALENDAR_CACHE_MS,
        dates,
      });
      return dates;
    } catch {
      return null;
    } finally {
      holidayCalendarRequests.delete(year);
    }
  })();
  holidayCalendarRequests.set(year, request);
  return request;
}

/**
 * Returns null when the official calendar is unavailable. Callers should then
 * require live quotes rather than treating an unverified weekday as a holiday.
 */
export async function isTaiwanMarketClosed(date = new Date()): Promise<boolean | null> {
  if (isTaipeiWeekend(date)) return true;

  const dateKey = taipeiDateKey(date);
  const year = Number(dateKey.slice(0, 4));
  const dates = await fetchHolidayDates(year);
  return dates ? dates.has(dateKey) : null;
}
