const OFFSET = 8 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;

/** Session windows use Taipei calendar dates; night bars span midnight. */
export function resolveFuturesSession(now = Date.now()) {
  const local = new Date(now + OFFSET);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const weekday = local.getUTCDay();
  const isDay = weekday >= 1 && weekday <= 5 && minute >= 525 && minute < 825;
  let startDay = midnight;
  if (!isDay) {
    if (minute < 825) startDay -= DAY;
    while ([0, 6].includes(new Date(startDay + OFFSET).getUTCDay())) startDay -= DAY;
  }
  const start = startDay + (isDay ? 525 : 900) * 60_000;
  const end = isDay ? startDay + 825 * 60_000 : startDay + DAY + 300 * 60_000;
  return {
    symbol: isDay ? "TXF1" as const : "TXF8" as const,
    label: isDay ? "日盤" : "夜盤",
    date: new Date(startDay + OFFSET).toISOString().slice(0, 10),
    start,
    end,
    active: now >= start && now < end,
  };
}

export function isFuturesSessionTimestamp(
  timestamp: number,
  session: ReturnType<typeof resolveFuturesSession>,
  now = Date.now(),
) {
  return Number.isFinite(timestamp) && timestamp >= session.start &&
    timestamp < session.end && timestamp <= now + 60_000;
}

/** SPARK midnight timestamps may encode only a date, even inside a night session. */
export function isFuturesSessionQuoteTimestamp(
  timestamp: number,
  session: ReturnType<typeof resolveFuturesSession>,
  now = Date.now(),
) {
  return isFuturesSessionTimestamp(timestamp, session, now) &&
    (timestamp + OFFSET) % DAY !== 0;
}
