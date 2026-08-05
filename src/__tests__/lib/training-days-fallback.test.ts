import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { deriveTrainingDaysFallback, inferTrainingDaysFromActivities } from "@/lib/infer-training-days";

const TZ = "America/Denver";
const WEEK_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// Pinned so weekday arithmetic is fixed rather than depending on the day the suite runs —
// these assertions are all about which weekday a run lands on, so a floating "now" makes
// them pass or fail based on the calendar.
const NOW = new Date("2026-08-05T12:00:00Z"); // Wednesday

/** A run on a specific calendar date, at midday local so timezone bucketing is unambiguous. */
function runOn(isoDate: string, type = "Run") {
  return { activity_type: type, start_date: `${isoDate}T18:00:00Z` };
}

function weekdayOf(isoDate: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" })
    .format(new Date(`${isoDate}T18:00:00Z`))
    .toLowerCase();
}

describe("deriveTrainingDaysFallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("never returns an empty list, even with no history at all", () => {
    const { days, source } = deriveTrainingDaysFallback({ activities: [], timezone: TZ, daysPerWeek: null });
    expect(days.length).toBeGreaterThan(0);
    expect(source).toBe("template");
  });

  it("sizes the template from days_per_week when there is no history", () => {
    expect(deriveTrainingDaysFallback({ activities: [], timezone: TZ, daysPerWeek: 3 }).days).toHaveLength(3);
    expect(deriveTrainingDaysFallback({ activities: [], timezone: TZ, daysPerWeek: 6 }).days).toHaveLength(6);
  });

  it("always includes Sunday in a template, since the skeleton anchors the long run there", () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const { days } = deriveTrainingDaysFallback({ activities: [], timezone: TZ, daysPerWeek: n });
      expect(days).toContain("sunday");
    }
  });

  it("keeps at least one rest day between runs in the low-volume templates", () => {
    for (const n of [2, 3]) {
      const idx = deriveTrainingDaysFallback({ activities: [], timezone: TZ, daysPerWeek: n }).days
        .map((d) => WEEK_ORDER.indexOf(d));
      for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThan(1);
    }
  });

  it("covers for inference on a single week of history, keeping the days actually run", () => {
    // Mon and Wed of the current week only. inferTrainingDaysFromActivities requires 2+
    // distinct weeks, so it bails — but these are real days and shouldn't be thrown away.
    // This is the just-connected-Strava case, and the one most likely to hit the fallback.
    const acts = [runOn("2026-08-03"), runOn("2026-08-05")];
    expect(inferTrainingDaysFromActivities(acts, TZ)).toBeNull();

    const { days, source } = deriveTrainingDaysFallback({ activities: acts, timezone: TZ, daysPerWeek: 4 });
    expect(source).not.toBe("template");
    expect(days).toContain(weekdayOf("2026-08-03"));
    expect(days).toContain(weekdayOf("2026-08-05"));
  });

  it("sizes from the busiest week, not a partial-week average", () => {
    // Six runs straddling a Monday: four in the week of Jul 27, two in the week of Aug 3.
    // Averaging runs across "weeks observed" would read this as 3/week and understate a
    // genuine 4-day schedule. The busiest week is the most complete view in the window.
    const acts = [
      runOn("2026-07-29"), runOn("2026-07-30"), runOn("2026-07-31"), runOn("2026-08-01"),
      runOn("2026-08-03"), runOn("2026-08-04"),
    ];
    const { days } = deriveTrainingDaysFallback({ activities: acts, timezone: TZ, daysPerWeek: 4 });
    expect(days).toHaveLength(4);
  });

  it("lets observed frequency override the days_per_week default", () => {
    // days_per_week is 4 by default whether or not the athlete said so; two real days beat it.
    const acts = [runOn("2026-08-03"), runOn("2026-08-05"), runOn("2026-07-27"), runOn("2026-07-29")];
    const { days } = deriveTrainingDaysFallback({ activities: acts, timezone: TZ, daysPerWeek: 4 });
    expect(days).toHaveLength(2);
  });

  it("keeps a real day when the busiest week only had one", () => {
    const acts = [runOn("2026-08-03"), runOn("2026-07-27"), runOn("2026-07-20")]; // one weekday, three weeks
    const { days, source } = deriveTrainingDaysFallback({ activities: acts, timezone: TZ, daysPerWeek: 4 });
    expect(days).toContain(weekdayOf("2026-08-03"));
    expect(source).toBe("history");
    expect(days).toHaveLength(1);
  });

  it("ignores non-run activities", () => {
    const acts = [runOn("2026-08-03", "Ride"), runOn("2026-08-04", "Swim"), runOn("2026-08-05", "WeightTraining")];
    expect(deriveTrainingDaysFallback({ activities: acts, timezone: TZ, daysPerWeek: 3 }).source).toBe("template");
  });

  it("ignores runs older than the lookback window", () => {
    const acts = [runOn("2026-01-05"), runOn("2026-01-07")]; // ~7 months old
    expect(deriveTrainingDaysFallback({ activities: acts, timezone: TZ, daysPerWeek: 3 }).source).toBe("template");
  });

  it("returns days in Monday-first week order with no duplicates", () => {
    const acts = [
      runOn("2026-08-03"), runOn("2026-08-04"), runOn("2026-07-31"),
      runOn("2026-07-29"), runOn("2026-07-26"),
    ];
    const { days } = deriveTrainingDaysFallback({ activities: acts, timezone: TZ, daysPerWeek: 5 });
    expect(new Set(days).size).toBe(days.length);
    const idx = days.map((d) => WEEK_ORDER.indexOf(d));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("is stable across calls for the same input", () => {
    const acts = [runOn("2026-08-03"), runOn("2026-08-05"), runOn("2026-07-27"), runOn("2026-07-29")];
    const a = deriveTrainingDaysFallback({ activities: acts, timezone: TZ, daysPerWeek: 4 }).days;
    const b = deriveTrainingDaysFallback({ activities: acts, timezone: TZ, daysPerWeek: 4 }).days;
    expect(a).toEqual(b);
  });

  it("never exceeds seven days", () => {
    const { days } = deriveTrainingDaysFallback({ activities: [], timezone: TZ, daysPerWeek: 99 });
    expect(days).toHaveLength(7);
  });
});
