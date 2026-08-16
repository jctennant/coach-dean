import { describe, it, expect } from "vitest";
import {
  parseStravaTimezone,
  detectTimezoneDrift,
  DRIFT_MIN_SPAN_MS,
} from "@/lib/timezone-drift";

describe("parseStravaTimezone", () => {
  it("pulls the IANA zone out of Strava's offset-prefixed string", () => {
    expect(parseStravaTimezone("(GMT-07:00) America/Denver")).toBe("America/Denver");
    expect(parseStravaTimezone("(GMT+02:00) Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("handles multi-segment zone names", () => {
    expect(parseStravaTimezone("(GMT-05:00) America/Indiana/Indianapolis")).toBe("America/Indiana/Indianapolis");
  });

  it("rejects zones the runtime doesn't recognise", () => {
    // Writing an unvalidated string into users.timezone would make every subsequent
    // Intl.DateTimeFormat call throw — a much worse failure than a stale zone.
    expect(parseStravaTimezone("(GMT+00:00) Middle/Earth")).toBeNull();
  });

  it("returns null for missing or non-string input", () => {
    expect(parseStravaTimezone(undefined)).toBeNull();
    expect(parseStravaTimezone(null)).toBeNull();
    expect(parseStravaTimezone("(GMT-07:00)")).toBeNull();
    expect(parseStravaTimezone(42)).toBeNull();
  });
});

describe("detectTimezoneDrift", () => {
  // Newest first, matching the query order.
  const berlin = (day: number) => ({
    activity_timezone: "Europe/Berlin",
    start_date: `2026-08-${String(day).padStart(2, "0")}T08:00:00Z`,
  });

  it("detects a relocation from three agreeing activities spanning enough time", () => {
    // Gwyneth's case: still America/Denver on file while training in Europe, which had her
    // being texted at 1:17am her stored local time.
    expect(detectTimezoneDrift([berlin(16), berlin(14), berlin(12)], "America/Denver")).toBe("Europe/Berlin");
  });

  it("stays put when the athlete is already in the detected zone", () => {
    expect(detectTimezoneDrift([berlin(16), berlin(14), berlin(12)], "Europe/Berlin")).toBeNull();
  });

  it("ignores a single out-of-zone activity", () => {
    const mixed = [
      berlin(16),
      { activity_timezone: "America/Denver", start_date: "2026-08-14T14:00:00Z" },
      { activity_timezone: "America/Denver", start_date: "2026-08-12T14:00:00Z" },
    ];
    expect(detectTimezoneDrift(mixed, "America/Denver")).toBeNull();
  });

  it("ignores a race weekend that never spans long enough", () => {
    // Three activities in one out-of-town weekend satisfy the count on their own. Moving an
    // athlete's reminder schedule for a trip would be worse than leaving it alone.
    const weekend = [
      { activity_timezone: "Europe/Berlin", start_date: "2026-08-16T08:00:00Z" },
      { activity_timezone: "Europe/Berlin", start_date: "2026-08-16T04:00:00Z" },
      { activity_timezone: "Europe/Berlin", start_date: "2026-08-15T20:00:00Z" },
    ];
    expect(detectTimezoneDrift(weekend, "America/Denver")).toBeNull();

    // The same three activities, spread past the minimum span, do qualify.
    const spread = [
      { activity_timezone: "Europe/Berlin", start_date: "2026-08-16T08:00:00Z" },
      { activity_timezone: "Europe/Berlin", start_date: "2026-08-15T08:00:00Z" },
      {
        activity_timezone: "Europe/Berlin",
        start_date: new Date(Date.parse("2026-08-16T08:00:00Z") - DRIFT_MIN_SPAN_MS).toISOString(),
      },
    ];
    expect(detectTimezoneDrift(spread, "America/Denver")).toBe("Europe/Berlin");
  });

  it("needs at least three zone-carrying activities", () => {
    expect(detectTimezoneDrift([berlin(16), berlin(12)], "America/Denver")).toBeNull();
  });

  it("skips rows with no captured zone rather than stalling on them", () => {
    // History predating the activity_timezone column must not block detection forever.
    const withGaps = [
      berlin(16),
      { activity_timezone: null, start_date: "2026-08-15T08:00:00Z" },
      berlin(14),
      { activity_timezone: null, start_date: "2026-08-13T08:00:00Z" },
      berlin(12),
    ];
    expect(detectTimezoneDrift(withGaps, "America/Denver")).toBe("Europe/Berlin");
  });

  it("sets a zone for an athlete who has none on file", () => {
    expect(detectTimezoneDrift([berlin(16), berlin(14), berlin(12)], null)).toBe("Europe/Berlin");
  });
});
