export type TaiwanCalendarDayWindow = {
  date: string;
  start: Date;
  end: Date;
};

export function getTaiwanCalendarDayWindow(
  now = new Date(),
): TaiwanCalendarDayWindow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Unable to determine the Taiwan calendar date");
  }
  const date = `${year}-${month}-${day}`;
  const start = new Date(`${date}T00:00:00+08:00`);
  return {
    date,
    start,
    end: new Date(start.getTime() + 24 * 60 * 60 * 1_000),
  };
}
