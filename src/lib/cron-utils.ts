/**
 * Compute a Date that is reliably in the next local calendar day for `tz`.
 *
 * We can't use `now + 24h` (UTC) for late-evening cron runs because 8-9pm local
 * time often crosses UTC midnight — `now + 24h` would land on the wrong UTC date.
 * Instead we advance the local date string by one day and return noon UTC of that
 * date. Noon UTC is always "tomorrow local" for any timezone since offsets are
 * within ±14 hours.
 */
export function localTomorrowNoon(now: Date, tz: string): Date {
  const localTodayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const [y, m, d] = localTodayStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
}
