const BACKTEST_MONTHS = 24;
const WARMUP_CALENDAR_DAYS = 60;
const REQUIRED_BACKTEST_BARS = 486;
const WARMUP_BARS = 20;

export function getMarketWideScanHistoryWindow(asOf: string) {
  const parsedAsOf = new Date(`${asOf}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    Number.isNaN(parsedAsOf.getTime()) ||
    parsedAsOf.toISOString().slice(0, 10) !== asOf
  ) {
    throw new Error("Invalid market-wide scan history date");
  }

  const cutoff = new Date(`${asOf}T00:00:00Z`);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - BACKTEST_MONTHS);
  cutoff.setUTCDate(cutoff.getUTCDate() - WARMUP_CALENDAR_DAYS);
  const startDate = cutoff.toISOString().slice(0, 10);
  const startMonth = Number(startDate.slice(0, 4)) * 12 + Number(startDate.slice(5, 7)) - 1;
  const endMonth = Number(asOf.slice(0, 4)) * 12 + Number(asOf.slice(5, 7)) - 1;

  return {
    startDate,
    endDate: asOf,
    monthCount: endMonth - startMonth + 1,
    minimumBars: REQUIRED_BACKTEST_BARS + WARMUP_BARS,
  };
}

export function hasAlignedRecentHistoryBars(
  bars: Array<{ date: string }>,
  asOf: string,
  minimumBars = 21,
): boolean {
  if (!Number.isInteger(minimumBars) || minimumBars < 1 || bars.length < minimumBars) {
    return false;
  }
  let previousDate = "";
  for (const bar of bars) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date) || bar.date <= previousDate) {
      return false;
    }
    previousDate = bar.date;
  }
  return previousDate === asOf;
}
