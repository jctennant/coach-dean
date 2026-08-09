import { describe, it, expect } from "vitest";
import { buildScheduleDigest, countDayLabeledLines, type SchedulePlanWeek, type PersistedSession } from "@/lib/schedule-digest";

// Sat Aug 8 2026, 18:00 UTC = 12:00 MDT. Week of Mon Aug 3; next week Mon Aug 10–Sun Aug 16.
const SAT = Date.UTC(2026, 7, 8, 18, 0, 0);
// Tue Aug 4 2026, 18:00 UTC — 6 days left in the current week.
const TUE = Date.UTC(2026, 7, 4, 18, 0, 0);

const weeks: SchedulePlanWeek[] = [
  { week_number: 1, mileage_target: 20, long_run_target: 7, key_workout: "Fartlek 5mi (varied 2-3 min pickups)" },
  { week_number: 2, mileage_target: 16, long_run_target: 8, key_workout: "Fartlek 6mi (varied 2-3 min pickups)" },
];

// What the mid-week starter slice persists to training_state.weekly_plan_sessions.
const persisted: PersistedSession[] = [
  { day: "Tue", date: "8/4", label: "Strength + mobility" },
  { day: "Wed", date: "8/5", label: "Fartlek 5mi (varied 2-3 min pickups)" },
  { day: "Thu", date: "8/6", label: "Easy 3mi" },
  { day: "Sat", date: "8/8", label: "Long run 7mi" },
];

const base = {
  weeks,
  currentWeekNumber: 1,
  persistedSessions: persisted,
  trainingDays: ["monday", "wednesday", "thursday", "saturday"],
  strengthDay: "Tue",
  crosstrainingTools: ["bike", "elliptical"],
  timezone: "America/Denver",
  isMetric: false,
  weekMileageSoFar: 0,
  avgWeeklyMileage: 25,
  ranToday: false,
};

describe("buildScheduleDigest", () => {
  describe("rest of the current week", () => {
    it("renders the persisted sessions rather than re-deriving them", () => {
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4 })!;
      expect(out).toContain("Rest of this week:");
      expect(out).toContain("Tue 8/4 — Strength + mobility");
      expect(out).toContain("Sat 8/8 — Long run 7mi");
    });

    it("drops today when the athlete has already run today", () => {
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, ranToday: true })!;
      expect(out).not.toContain("Tue 8/4");
      expect(out).toContain("Wed 8/5");
    });

    it("never shows a day that's already passed", () => {
      const withMonday = [{ day: "Mon", date: "8/3", label: "Easy 4mi" }, ...persisted];
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, persistedSessions: withMonday })!;
      expect(out).not.toContain("Mon 8/3");
    });

    it("orders lines Mon→Sun regardless of stored order", () => {
      const shuffled = [persisted[3], persisted[1], persisted[0], persisted[2]];
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, persistedSessions: shuffled })!;
      const days = out.split("\n").slice(1).map((l) => l.slice(0, 3));
      expect(days).toEqual(["Tue", "Wed", "Thu", "Sat"]);
    });
  });

  describe("falling through to next week", () => {
    it("shows next week when the current week's mileage budget is already met", () => {
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 20.3, avgWeeklyMileage: 8 })!;
      expect(out).toContain("Next week (Aug 10–16):");
      expect(out).toContain("Long run 8mi"); // week 2's, not week 1's
    });

    it("shows next week when too few days remain", () => {
      const out = buildScheduleDigest({ ...base, nowMs: SAT })!;
      expect(out).toContain("Next week (Aug 10–16):");
      expect(out).toContain("Mon 8/10");
      expect(out).toContain("Sat 8/15");
    });

    it("shows next week when nothing is left in the persisted current week", () => {
      const spent = [{ day: "Mon", date: "8/3", label: "Easy 4mi" }];
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, persistedSessions: spent })!;
      expect(out).toContain("Next week (Aug 10–16):");
    });

    it("skips the current week when the athlete asked about next week", () => {
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, preferNextWeek: true })!;
      expect(out).toContain("Next week (Aug 10–16):");
      expect(out).not.toContain("Rest of this week");
    });

    it("shows next week when no sessions were persisted at all", () => {
      const out = buildScheduleDigest({ ...base, nowMs: TUE, persistedSessions: null })!;
      expect(out).toContain("Next week (Aug 10–16):");
    });

    it("renders distances in km for metric athletes", () => {
      const out = buildScheduleDigest({ ...base, nowMs: SAT, isMetric: true })!;
      expect(out).toContain("Long run 12.9km");
      // key_workout text keeps whatever units it was generated in — see arcWeekSlotLabel.
      expect(out).toContain("Fartlek 6mi");
    });

    it("returns null when next week isn't in the plan", () => {
      expect(buildScheduleDigest({ ...base, nowMs: SAT, weeks: [weeks[0]] })).toBeNull();
      expect(buildScheduleDigest({ ...base, nowMs: SAT, weeks: [] })).toBeNull();
    });

    it("returns null when the athlete has no training days set", () => {
      expect(buildScheduleDigest({ ...base, nowMs: SAT, trainingDays: [] })).toBeNull();
    });
  });

  it("lists one line per session with day, date and label", () => {
    const out = buildScheduleDigest({ ...base, nowMs: SAT })!;
    const lines = out.split("\n").slice(1);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+\/\d+ — .+/);
  });
});

describe("countDayLabeledLines", () => {
  it("counts a day-by-day schedule Dean wrote himself", () => {
    const msg = [
      "Next week (3 weeks out from Teton Crest):",
      "",
      "Monday, Aug 10: Easy 2.5 mi + 5×20sec strides",
      "Wednesday, Aug 12: Easy 3.5 mi",
      "Thursday, Aug 13: Easy 4 mi",
      "Saturday, Aug 15: Long run 7 mi easy",
      "",
      "Total: 17 mi.",
    ].join("\n");
    expect(countDayLabeledLines(msg)).toBe(4);
  });

  it("counts the abbreviated dash form too", () => {
    expect(countDayLabeledLines("Mon - Easy 4mi\nWed - Tempo 5mi\nSat - Long run 9mi")).toBe(3);
  });

  it("does not count a passing mention of a single day", () => {
    expect(countDayLabeledLines("Saturday's long run is the one that matters this week."))
      .toBeLessThan(2);
    expect(countDayLabeledLines("You could move Thursday to Friday if that works better."))
      .toBeLessThan(2);
  });

  it("returns 0 for prose with no day lines", () => {
    expect(countDayLabeledLines("17 mi next week — long run 7, one strides session, rest easy."))
      .toBe(0);
  });
});
