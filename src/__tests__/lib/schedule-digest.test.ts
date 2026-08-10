import { describe, it, expect } from "vitest";
import { buildScheduleDigest, countDayLabeledLines, stripDayLabeledLines, type SchedulePlanWeek, type PersistedSession } from "@/lib/schedule-digest";

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
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4 })!.text;
      expect(out).toContain("Rest of this week:");
      expect(out).toContain("Tue 8/4 — Strength + mobility");
      expect(out).toContain("Sat 8/8 — Long run 7mi");
    });

    it("drops today when the athlete has already run today", () => {
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, ranToday: true })!.text;
      expect(out).not.toContain("Tue 8/4");
      expect(out).toContain("Wed 8/5");
    });

    it("never shows a day that's already passed", () => {
      const withMonday = [{ day: "Mon", date: "8/3", label: "Easy 4mi" }, ...persisted];
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, persistedSessions: withMonday })!.text;
      expect(out).not.toContain("Mon 8/3");
    });

    it("orders lines Mon→Sun regardless of stored order", () => {
      const shuffled = [persisted[3], persisted[1], persisted[0], persisted[2]];
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, persistedSessions: shuffled })!.text;
      const days = out.split("\n").slice(1).map((l) => l.slice(0, 3));
      expect(days).toEqual(["Tue", "Wed", "Thu", "Sat"]);
    });
  });

  describe("falling through to next week", () => {
    it("shows next week when the current week's mileage budget is already met", () => {
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 20.3, avgWeeklyMileage: 8 })!.text;
      expect(out).toContain("Next week (Aug 10–16):");
      expect(out).toContain("Long run 8mi"); // week 2's, not week 1's
    });

    it("shows next week when nothing is left in the persisted current week", () => {
      const spent = [{ day: "Mon", date: "8/3", label: "Easy 4mi" }];
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, persistedSessions: spent })!.text;
      expect(out).toContain("Next week (Aug 10–16):");
    });

    it("shows next week when no sessions were persisted at all", () => {
      const out = buildScheduleDigest({ ...base, nowMs: TUE, persistedSessions: null })!.text;
      expect(out).toContain("Next week (Aug 10–16):");
    });

    it("skips the current week when the athlete asked about next week", () => {
      const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, preferNextWeek: true })!.text;
      expect(out).toContain("Next week (Aug 10–16):");
      expect(out).not.toContain("Rest of this week");
    });

    it("renders distances in km for metric athletes", () => {
      const out = buildScheduleDigest({ ...base, nowMs: SAT, persistedSessions: null, isMetric: true })!.text;
      expect(out).toContain("Long run 12.9km");
      // key_workout text keeps whatever units it was generated in — see arcWeekSlotLabel.
      expect(out).toContain("Fartlek 6mi");
    });

    it("returns null when next week isn't in the plan", () => {
      expect(buildScheduleDigest({ ...base, nowMs: SAT, persistedSessions: null, weeks: [weeks[0]] })).toBeNull();
      expect(buildScheduleDigest({ ...base, nowMs: SAT, persistedSessions: null, weeks: [] })).toBeNull();
    });

    it("returns null when the athlete has no training days set", () => {
      expect(buildScheduleDigest({ ...base, nowMs: SAT, persistedSessions: null, trainingDays: [] })).toBeNull();
    });
  });

  describe("Sunday evening, when the stored week is already next week's", () => {
    // The recap runs Sunday evening and stores the UPCOMING week, so on Sunday the stored
    // sessions are dated Mon–Sun of the week ahead. Deciding by "days left in the calendar
    // week" sent this case to the arc instead, which discarded the athlete's just-applied
    // swaps and rendered week N+1's numbers against next week's dates (2026-08-10).
    const SUN = Date.UTC(2026, 7, 9, 20, 0, 0); // Sunday Aug 9, 2pm MDT
    const nextWeek: PersistedSession[] = [
      { day: "Mon", date: "8/10", label: "Easy run (treadmill) 2mi + bike", rehab_routine_key: "shin" },
      { day: "Tue", date: "8/11", label: "Elliptical 30 min + strength", rehab_routine_key: "shin" },
      { day: "Sat", date: "8/15", label: "Long run 7mi" },
    ];

    it("renders the stored week rather than recomputing it from the arc", () => {
      const out = buildScheduleDigest({ ...base, nowMs: SUN, persistedSessions: nextWeek })!;
      expect(out.text).toContain("Easy run (treadmill) 2mi + bike");
      expect(out.text).toContain("Elliptical 30 min + strength");
      expect(out.text).toContain("Long run 7mi");
    });

    it("names the rehab routine on stored lines, same as the computed path", () => {
      const out = buildScheduleDigest({ ...base, nowMs: SUN, persistedSessions: nextWeek })!;
      expect(out.text).toContain("Easy run (treadmill) 2mi + bike + shin routine");
      // Saturday has no rehab stored — no suffix invented for it.
      expect(out.text).toContain("Sat 8/15 — Long run 7mi");
      expect(out.rehabRoutineKey).toBe("shin");
      expect(out.rehabDays).toEqual(["Mon", "Tue"]);
    });

    it("does not repeat the routine when the stored label already names it", () => {
      const named = [{ day: "Tue", date: "8/11", label: "Shin routine", rehab_routine_key: "shin" }];
      const out = buildScheduleDigest({ ...base, nowMs: SUN, persistedSessions: named })!;
      expect(out.text).toBe("Next week (Aug 11–11):\nTue 8/11 — Shin routine");
    });

    it("labels it as next week, from the dates being shown", () => {
      const out = buildScheduleDigest({ ...base, nowMs: SUN, persistedSessions: nextWeek })!;
      expect(out.text).toContain("Next week (Aug 10–15):");
    });

    it("derives the weekday from the date, so a drifted day label can't contradict it", () => {
      const drifted = [{ day: "Fri", date: "8/10", label: "Easy 3mi" }];
      const out = buildScheduleDigest({ ...base, nowMs: SUN, persistedSessions: drifted })!;
      expect(out.text).toContain("Mon 8/10 — Easy 3mi");
    });
  });

  it("lists one line per session with day, date and label", () => {
    const out = buildScheduleDigest({ ...base, nowMs: SAT, persistedSessions: null })!.text;
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

describe("stripDayLabeledLines", () => {
  it("strips the day list Dean writes when a real schedule is about to follow", () => {
    // Verbatim from the transcript that exposed this: the two schedules disagreed, his prose
    // putting the long run Wednesday while the stored plan had it Saturday.
    const msg = [
      "Mon 8/10 · Easy 5mi",
      "Wed 8/12 · Long run 7mi easy",
      "Thu 8/13 · Easy 2.5mi + 5×20sec strides",
      "Sat 8/15 · Easy 2.5mi",
      "",
      "Two cross-training sessions and strength 2× spread across the week.",
    ].join("\n");
    expect(stripDayLabeledLines(msg)).toBe("Two cross-training sessions and strength 2× spread across the week.");
  });

  it("recognises the separators Dean actually uses", () => {
    for (const line of ["Mon 8/10 · Easy 5mi", "Mon 8/10. Easy 5mi", "Monday, Aug 10: Easy 5mi", "Mon - Easy 5mi", "Tue 8/11 — Bike"]) {
      expect(countDayLabeledLines(`${line}\n${line.replace(/Mon|Tue/, "Wed")}`), line).toBe(2);
    }
  });

  it("leaves prose that merely mentions a day alone", () => {
    const prose = "Saturday's long run is the key one this week. Move Thursday to Friday if travel gets in the way.";
    expect(stripDayLabeledLines(prose)).toBe(prose);
  });

  it("leaves a single day line alone — that's a mention, not a schedule", () => {
    const one = "Here's the plan.\nSat 8/15 · Long run 7mi\nThat's the one that matters.";
    expect(stripDayLabeledLines(one)).toBe(one);
  });

  it("collapses the blank lines the strip leaves behind", () => {
    const msg = "Here's next week.\n\nMon 8/10 · Easy 5mi\nWed 8/12 · Easy 3mi\n\nKeep the shin routine going.";
    expect(stripDayLabeledLines(msg)).toBe("Here's next week.\n\nKeep the shin routine going.");
  });
});

describe("buildScheduleDigest — rehab reporting", () => {
  it("reports the rehab routine and days so the routine can follow as its own message", () => {
    const withRehab = persisted.map(p => ({ ...p, rehab_routine_key: "shin" }));
    const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4, persistedSessions: withRehab })!;
    expect(out.rehabRoutineKey).toBe("shin");
    expect(out.rehabDays).toEqual(["Tue", "Wed", "Thu", "Sat"]);
  });

  it("reports no routine when the week has none", () => {
    const out = buildScheduleDigest({ ...base, nowMs: TUE, weekMileageSoFar: 4 })!;
    expect(out.rehabRoutineKey).toBeNull();
    expect(out.rehabDays).toEqual([]);
  });
});
