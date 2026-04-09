import { describe, it, expect } from "vitest";
import { localTomorrowNoon } from "@/lib/cron-utils";

/**
 * localTomorrowNoon — the key scenario is a cron run that serves a late-evening
 * user whose local time has crossed UTC midnight. The old `now + 24h` approach
 * would return the wrong UTC date; this function must always return the correct
 * "tomorrow" regardless of when the cron fires.
 */
describe("localTomorrowNoon", () => {
  it("returns tomorrow's date for a US/Pacific user at 9pm (cron fires 04:00 UTC)", () => {
    // Wednesday 9pm PDT = Thursday 04:00 UTC
    const now = new Date("2026-04-09T04:00:00Z"); // Thursday UTC
    const result = localTomorrowNoon(now, "America/Los_Angeles");
    // Local today (PDT = UTC-7): Wednesday April 8 → tomorrow is Thursday April 9
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long" }).format(result);
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(result);
    expect(weekday).toBe("Thursday");
    expect(dateStr).toBe("2026-04-09");
  });

  it("returns tomorrow's date for a US/Eastern user at 8pm (cron fires 00:00 UTC)", () => {
    // Wednesday 8pm EDT = Thursday 00:00 UTC
    const now = new Date("2026-04-09T00:00:00Z"); // Thursday UTC
    const result = localTomorrowNoon(now, "America/New_York");
    // Local today (EDT = UTC-4): Wednesday April 8 → tomorrow is Thursday April 9
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(result);
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(result);
    expect(weekday).toBe("Thursday");
    expect(dateStr).toBe("2026-04-09");
  });

  it("returns tomorrow's date for a UK user at 9pm BST (cron fires 20:00 UTC)", () => {
    // Wednesday 9pm BST = Wednesday 20:00 UTC
    const now = new Date("2026-04-08T20:00:00Z"); // still Wednesday UTC
    const result = localTomorrowNoon(now, "Europe/London");
    // Local today (BST = UTC+1): Wednesday April 8 → tomorrow is Thursday April 9
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/London", weekday: "long" }).format(result);
    expect(weekday).toBe("Thursday");
  });

  it("returns tomorrow's date for an Australian user at 9pm AEST (cron fires 11:00 UTC)", () => {
    // Wednesday 9pm AEST = Wednesday 11:00 UTC
    const now = new Date("2026-04-08T11:00:00Z");
    const result = localTomorrowNoon(now, "Australia/Sydney");
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Australia/Sydney", weekday: "long" }).format(result);
    expect(weekday).toBe("Thursday");
  });

  it("handles month-end rollover correctly (Apr 30 → May 1)", () => {
    // US/Eastern at 8pm = 00:00 UTC May 1
    const now = new Date("2026-05-01T00:00:00Z");
    const result = localTomorrowNoon(now, "America/New_York");
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(result);
    expect(dateStr).toBe("2026-05-01");
  });

  it("handles year-end rollover correctly (Dec 31 → Jan 1)", () => {
    // US/Eastern at 8pm Dec 31 = 00:00 UTC Jan 1
    const now = new Date("2027-01-01T00:00:00Z");
    const result = localTomorrowNoon(now, "America/New_York");
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(result);
    expect(dateStr).toBe("2027-01-01");
  });

  it("noon UTC of the result is always the correct local date for any timezone", () => {
    // Spot-check: Hawaii (UTC-10) at 8pm = 06:00 UTC next day
    const now = new Date("2026-04-09T06:00:00Z"); // Thursday UTC
    const result = localTomorrowNoon(now, "Pacific/Honolulu");
    // Local today (HST = UTC-10): Wednesday April 8 → tomorrow is Thursday April 9
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Honolulu" }).format(result);
    expect(dateStr).toBe("2026-04-09");
  });
});
