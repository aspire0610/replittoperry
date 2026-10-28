function isTaipeiWeekdayWindow(
  date: Date,
  startHour: number,
  endHour: number,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const getPart = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(getPart("hour"));
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(getPart("weekday")) &&
    hour >= startHour &&
    hour < endHour;
}

export function isTaipeiPremarketSummaryHours(date = new Date()): boolean {
  return isTaipeiWeekdayWindow(date, 7, 10);
}

export function isTaipeiClosingSummaryHours(date = new Date()): boolean {
  return isTaipeiWeekdayWindow(date, 15, 17);
}
