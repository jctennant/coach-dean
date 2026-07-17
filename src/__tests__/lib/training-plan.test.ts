import { describe, it, expect, vi, afterEach } from "vitest";
import { computePhaseForPlan, computeWeekSessions, computeWeeklyStrength, computeArcWeekSkeleton, formatWeeklyPlanDigest, type UploadedPlanWeek, type ArcWeekSlot } from "@/lib/training-plan";

// ---------------------------------------------------------------------------
// computePhaseForPlan — no-race cycle
// ---------------------------------------------------------------------------
describe("computePhaseForPlan — no race", () => {
  it("returns base for weeks 1–6 of a 12-week cycle", () => {
    for (let w = 1; w <= 6; w++) {
      expect(computePhaseForPlan(w, 12, false), `week ${w}`).toBe("base");
    }
  });

  it("returns build for weeks 7–12 of a 12-week cycle", () => {
    for (let w = 7; w <= 12; w++) {
      expect(computePhaseForPlan(w, 12, false), `week ${w}`).toBe("build");
    }
  });

  it("cycles back to base on week 13", () => {
    expect(computePhaseForPlan(13, 24, false)).toBe("base");
  });

  it("cycles back to build on week 19", () => {
    expect(computePhaseForPlan(19, 24, false)).toBe("build");
  });
});

// ---------------------------------------------------------------------------
// computePhaseForPlan — 12-week race plan (Dipsea-length scenario)
// ---------------------------------------------------------------------------
describe("computePhaseForPlan — 12-week race plan", () => {
  // scale = 12/24 = 0.5
  // peakThreshold = max(4, round(7*0.5)) = max(4, 4) = 4
  // buildThreshold = max(6, round(14*0.5)) = max(6, 7) = 7

  it("taper: last 2 weeks (weeks 11–12)", () => {
    expect(computePhaseForPlan(11, 12, true)).toBe("taper"); // weeksFromEnd=1
    expect(computePhaseForPlan(12, 12, true)).toBe("taper"); // weeksFromEnd=0
  });

  it("peak: weeks 9–10 (weeksFromEnd 3–2, both < peakThreshold=4)", () => {
    expect(computePhaseForPlan(9, 12, true)).toBe("peak");  // weeksFromEnd=3
    expect(computePhaseForPlan(10, 12, true)).toBe("peak"); // weeksFromEnd=2
  });

  it("build: weeks 6–8 (weeksFromEnd 6–4, all < buildThreshold=7 but ≥ peakThreshold=4)", () => {
    expect(computePhaseForPlan(6, 12, true)).toBe("build"); // weeksFromEnd=6
    expect(computePhaseForPlan(7, 12, true)).toBe("build"); // weeksFromEnd=5
    expect(computePhaseForPlan(8, 12, true)).toBe("build"); // weeksFromEnd=4
  });

  it("base: weeks 1–5 (weeksFromEnd 11–7, all ≥ buildThreshold=7)", () => {
    for (let w = 1; w <= 5; w++) {
      expect(computePhaseForPlan(w, 12, true), `week ${w}`).toBe("base");
    }
  });

  it("all four phases are present in a 12-week plan", () => {
    const phases = new Set(
      Array.from({ length: 12 }, (_, i) => computePhaseForPlan(i + 1, 12, true))
    );
    expect(phases.has("base")).toBe(true);
    expect(phases.has("build")).toBe(true);
    expect(phases.has("peak")).toBe(true);
    expect(phases.has("taper")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computePhaseForPlan — 24-week race plan (full-length scenario)
// ---------------------------------------------------------------------------
describe("computePhaseForPlan — 24-week race plan", () => {
  // scale = 1.0 (capped)
  // peakThreshold = max(4, round(7)) = 7
  // buildThreshold = max(9, round(14)) = 14

  it("taper: last 2 weeks (23–24)", () => {
    expect(computePhaseForPlan(23, 24, true)).toBe("taper"); // weeksFromEnd=1
    expect(computePhaseForPlan(24, 24, true)).toBe("taper"); // weeksFromEnd=0
  });

  it("peak: weeks 18–22 (weeksFromEnd 6–2)", () => {
    expect(computePhaseForPlan(18, 24, true)).toBe("peak"); // weeksFromEnd=6
    expect(computePhaseForPlan(22, 24, true)).toBe("peak"); // weeksFromEnd=2
  });

  it("build: weeks 11–17 (weeksFromEnd 13–7)", () => {
    expect(computePhaseForPlan(11, 24, true)).toBe("build"); // weeksFromEnd=13
    expect(computePhaseForPlan(17, 24, true)).toBe("build"); // weeksFromEnd=7
  });

  it("base: weeks 1–10 (weeksFromEnd 23–14)", () => {
    expect(computePhaseForPlan(1, 24, true)).toBe("base");
    expect(computePhaseForPlan(10, 24, true)).toBe("base"); // weeksFromEnd=14
  });
});

// ---------------------------------------------------------------------------
// computePhaseForPlan — taper is always 2 weeks regardless of plan length
// ---------------------------------------------------------------------------
describe("computePhaseForPlan — taper is always 2 weeks", () => {
  const lengths = [6, 8, 12, 16, 24, 40, 52];

  for (const total of lengths) {
    it(`last 2 weeks of a ${total}-week plan are all taper`, () => {
      expect(computePhaseForPlan(total, total, true)).toBe("taper");
      expect(computePhaseForPlan(total - 1, total, true)).toBe("taper");
    });

    it(`week ${total - 2} of a ${total}-week plan is NOT taper`, () => {
      const phase = computePhaseForPlan(total - 2, total, true);
      expect(phase).not.toBe("taper");
    });
  }
});

// ---------------------------------------------------------------------------
// fixKeyWorkoutMath
// ---------------------------------------------------------------------------
import { fixKeyWorkoutMath } from "@/lib/training-plan";

describe("fixKeyWorkoutMath", () => {
  it("is a no-op when the prefix matches the component sum", () => {
    const kw = "Tempo 3.5mi (1mi WU + 1.5mi @ threshold + 1mi CD)";
    expect(fixKeyWorkoutMath(kw, "mi")).toBe(kw);
  });

  it("corrects a wrong prefix to match component sum", () => {
    const kw = "Tempo 2mi (1mi WU + 1.5mi @ threshold + 1mi CD)";
    const result = fixKeyWorkoutMath(kw, "mi");
    expect(result).toBe("Tempo 3.5mi (1mi WU + 1.5mi @ threshold + 1mi CD)");
  });

  it("leaves ambiguous time-based workouts unchanged", () => {
    // 4×3min middle segment makes total uncertain
    const kw = "Intervals 3mi (1mi WU + 4×3min @ 5K effort + 1mi CD)";
    expect(fixKeyWorkoutMath(kw, "mi")).toBe(kw);
  });

  it("leaves rep-count intervals unchanged", () => {
    // 6×800m has no explicit mi value — can't sum
    const kw = "Intervals 4mi (1mi WU + 6×800m @ 5K pace + 1mi CD)";
    expect(fixKeyWorkoutMath(kw, "mi")).toBe(kw);
  });

  it("is a no-op for simple key workouts with no prefix pattern", () => {
    const kw = "6×800m @ 5K pace";
    expect(fixKeyWorkoutMath(kw, "mi")).toBe(kw);
  });

  it("works with km unit label", () => {
    const kw = "Tempo 2km (1km WU + 1.5km @ threshold + 1km CD)";
    const result = fixKeyWorkoutMath(kw, "km");
    expect(result).toBe("Tempo 3.5km (1km WU + 1.5km @ threshold + 1km CD)");
  });
});

// ---------------------------------------------------------------------------
// computeWeekSessions
// ---------------------------------------------------------------------------
describe("computeWeekSessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Pin system time to Wednesday 2026-05-27 so week dates are deterministic.
  // Week starts Mon 5/25, ends Sun 5/31.
  function pinToWednesday() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00Z")); // Wednesday UTC
  }

  const sampleWeeks: UploadedPlanWeek[] = [
    {
      week_number: 1,
      sessions: [
        { day: "Mon", label: "Rest" },
        { day: "Tue", label: "Easy 6mi" },
        { day: "Wed", label: "Tempo 8mi (2mi WU + 4mi @ 7:45/mi + 2mi CD)" },
        { day: "Thu", label: "Easy 5mi" },
        { day: "Fri", label: "Rest" },
        { day: "Sat", label: "Long run 14mi" },
        { day: "Sun", label: "Easy 4mi recovery" },
      ],
    },
    {
      week_number: 2,
      sessions: [
        { day: "Tue", label: "Easy 7mi" },
        { day: "Thu", label: "Intervals 6mi" },
        { day: "Sat", label: "Long run 16mi" },
      ],
    },
  ];

  it("returns correct M/D dates for each day of the week", () => {
    pinToWednesday();
    const result = computeWeekSessions(sampleWeeks, 1, "UTC");

    expect(result).toHaveLength(7);
    expect(result.find(s => s.day === "Mon")?.date).toBe("5/25");
    expect(result.find(s => s.day === "Tue")?.date).toBe("5/26");
    expect(result.find(s => s.day === "Wed")?.date).toBe("5/27");
    expect(result.find(s => s.day === "Thu")?.date).toBe("5/28");
    expect(result.find(s => s.day === "Fri")?.date).toBe("5/29");
    expect(result.find(s => s.day === "Sat")?.date).toBe("5/30");
    expect(result.find(s => s.day === "Sun")?.date).toBe("5/31");
  });

  it("preserves session labels unchanged", () => {
    pinToWednesday();
    const result = computeWeekSessions(sampleWeeks, 1, "UTC");

    expect(result.find(s => s.day === "Wed")?.label).toBe(
      "Tempo 8mi (2mi WU + 4mi @ 7:45/mi + 2mi CD)"
    );
  });

  it("returns only the sessions for the requested week", () => {
    pinToWednesday();
    const result = computeWeekSessions(sampleWeeks, 2, "UTC");

    expect(result).toHaveLength(3);
    expect(result.map(s => s.day)).toEqual(["Tue", "Thu", "Sat"]);
  });

  it("returns [] when week_number is not found", () => {
    pinToWednesday();
    expect(computeWeekSessions(sampleWeeks, 99, "UTC")).toEqual([]);
  });

  it("returns [] for empty allWeeks array", () => {
    pinToWednesday();
    expect(computeWeekSessions([], 1, "UTC")).toEqual([]);
  });

  it("computes correct Monday when today is Sunday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T12:00:00Z")); // Sunday
    const result = computeWeekSessions(sampleWeeks, 1, "UTC");
    // Monday of the week containing Sun 5/31 is Mon 5/25
    expect(result.find(s => s.day === "Mon")?.date).toBe("5/25");
    expect(result.find(s => s.day === "Sun")?.date).toBe("5/31");
  });

  it("computes correct Monday when today is Monday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00Z")); // Monday
    const result = computeWeekSessions(sampleWeeks, 1, "UTC");
    expect(result.find(s => s.day === "Mon")?.date).toBe("5/25");
  });

  it("handles month boundary correctly (Mon in one month, Sun in next)", () => {
    vi.useFakeTimers();
    // Wednesday 2026-06-03 → week is Mon 6/1 – Sun 6/7
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    const result = computeWeekSessions(sampleWeeks, 1, "UTC");
    expect(result.find(s => s.day === "Mon")?.date).toBe("6/1");
    expect(result.find(s => s.day === "Sun")?.date).toBe("6/7");
  });
});

// ---------------------------------------------------------------------------
// computeWeeklyStrength
// ---------------------------------------------------------------------------
describe("computeWeeklyStrength", () => {
  it("picks the first day off (not in training_days) as the strength day", () => {
    const result = computeWeeklyStrength({ training_days: ["monday", "wednesday", "friday", "sunday"] });
    // First day-off in Mon..Sun order is Tuesday
    expect(result.day).toBe("Tue");
  });

  it("returns null day when the athlete trains all 7 days", () => {
    const result = computeWeeklyStrength({
      training_days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });
    expect(result.day).toBeNull();
  });

  it("returns Monday when no training_days are set (everyone has a day off)", () => {
    const result = computeWeeklyStrength({ training_days: [] });
    expect(result.day).toBe("Mon");
  });

  it("normalizes casing/whitespace when matching training_days", () => {
    const result = computeWeeklyStrength({ training_days: [" Monday ", "TUESDAY"] });
    expect(result.day).toBe("Wed");
  });

  it("routes to an injury-specific routine when body part is known", () => {
    const result = computeWeeklyStrength({ training_days: [], injury_body_part: "left achilles" });
    expect(result.routineKey).toBe("calf");
  });

  it("falls back to hip_core when there's no injury signal", () => {
    const result = computeWeeklyStrength({ training_days: [] });
    expect(result.routineKey).toBe("hip_core");
  });

  it("re-evaluates from injury_notes free text too", () => {
    const result = computeWeeklyStrength({ training_days: [], injury_notes: "IT band flare-up last week" });
    expect(result.routineKey).toBe("it_band");
  });
});

// ---------------------------------------------------------------------------
// computeArcWeekSkeleton
// ---------------------------------------------------------------------------
describe("computeArcWeekSkeleton", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Pin to Wednesday 2026-05-27 — week is Mon 5/25 .. Sun 5/31, same anchor as
  // the computeWeekSessions tests above.
  function pinToWednesday() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00Z"));
  }

  const fiveDayTraining = ["monday", "tuesday", "wednesday", "friday", "sunday"];

  it("places the long run on Sunday when Sunday is a training day", () => {
    pinToWednesday();
    const slots = computeArcWeekSkeleton({
      trainingDays: fiveDayTraining,
      weeklyTotalMiles: 30,
      longRunMiles: 10,
      keyWorkoutText: "Tempo 5mi (1mi WU + 3mi @ 7:45/mi + 1mi CD)",
      strengthDay: "Thu",
      timezone: "UTC",
    });
    const longRun = slots.find(s => s.type === "long_run");
    expect(longRun?.day).toBe("Sun");
    expect(longRun?.date).toBe("5/31");
    expect(longRun?.distanceMiles).toBe(10);
  });

  it("falls back to the last training day for the long run when neither Sat nor Sun train", () => {
    pinToWednesday();
    const slots = computeArcWeekSkeleton({
      trainingDays: ["monday", "tuesday", "wednesday", "thursday"],
      weeklyTotalMiles: 20,
      longRunMiles: 8,
      keyWorkoutText: null,
      strengthDay: "Fri",
      timezone: "UTC",
    });
    expect(slots.find(s => s.type === "long_run")?.day).toBe("Thu");
  });

  it("parses the quality session distance from the key_workout prefix", () => {
    pinToWednesday();
    const slots = computeArcWeekSkeleton({
      trainingDays: fiveDayTraining,
      weeklyTotalMiles: 30,
      longRunMiles: 10,
      keyWorkoutText: "Tempo 5mi (1mi WU + 3mi @ 7:45/mi + 1mi CD)",
      strengthDay: "Thu",
      timezone: "UTC",
    });
    const quality = slots.find(s => s.type === "quality");
    expect(quality?.distanceMiles).toBe(5);
    expect(quality?.keyWorkoutText).toBe("Tempo 5mi (1mi WU + 3mi @ 7:45/mi + 1mi CD)");
    // Quality day must not be the long-run day.
    expect(quality?.day).not.toBe("Sun");
  });

  it("splits leftover mileage across easy days so the total is exact", () => {
    pinToWednesday();
    const slots = computeArcWeekSkeleton({
      trainingDays: fiveDayTraining, // Mon, Tue, Wed, Fri, Sun
      weeklyTotalMiles: 30,
      longRunMiles: 10,
      keyWorkoutText: "Tempo 5mi (1mi WU + 3mi @ 7:45/mi + 1mi CD)",
      strengthDay: "Thu",
      timezone: "UTC",
    });
    const runningTotal = slots
      .filter(s => s.type === "long_run" || s.type === "quality" || s.type === "easy")
      .reduce((sum, s) => sum + (s.distanceMiles ?? 0), 0);
    expect(runningTotal).toBeCloseTo(30, 5);
  });

  it("assigns rest to non-training days and strength to the computed strength day", () => {
    pinToWednesday();
    const slots = computeArcWeekSkeleton({
      trainingDays: fiveDayTraining, // Mon, Tue, Wed, Fri, Sun — Thu and Sat are off
      weeklyTotalMiles: 30,
      longRunMiles: 10,
      keyWorkoutText: "Tempo 5mi (1mi WU + 3mi @ 7:45/mi + 1mi CD)",
      strengthDay: "Thu",
      timezone: "UTC",
    });
    expect(slots.find(s => s.day === "Thu")?.type).toBe("strength");
    expect(slots.find(s => s.day === "Sat")?.type).toBe("rest");
  });

  it("returns slots sorted chronologically Mon through Sun", () => {
    pinToWednesday();
    const slots = computeArcWeekSkeleton({
      trainingDays: fiveDayTraining,
      weeklyTotalMiles: 30,
      longRunMiles: 10,
      keyWorkoutText: "Tempo 5mi (1mi WU + 3mi @ 7:45/mi + 1mi CD)",
      strengthDay: "Thu",
      timezone: "UTC",
    });
    expect(slots).toHaveLength(7);
    const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    expect(slots.map(s => s.day)).toEqual(order);
  });

  it("returns [] when the athlete has no training days set", () => {
    pinToWednesday();
    const slots = computeArcWeekSkeleton({
      trainingDays: [],
      weeklyTotalMiles: 20,
      longRunMiles: 8,
      keyWorkoutText: null,
      strengthDay: "Mon",
      timezone: "UTC",
    });
    expect(slots).toEqual([]);
  });

  it("falls back to a loose distance scan when the key_workout has no parenthetical breakdown", () => {
    pinToWednesday();
    const slots = computeArcWeekSkeleton({
      trainingDays: fiveDayTraining,
      weeklyTotalMiles: 30,
      longRunMiles: 10,
      keyWorkoutText: "6x800m repeats, roughly 4mi total",
      strengthDay: "Thu",
      timezone: "UTC",
    });
    expect(slots.find(s => s.type === "quality")?.distanceMiles).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// formatWeeklyPlanDigest — deterministic SMS text, no LLM call
// ---------------------------------------------------------------------------
describe("formatWeeklyPlanDigest", () => {
  const skeleton: ArcWeekSlot[] = [
    { day: "Mon", date: "7/20", type: "rest", distanceMiles: null },
    { day: "Wed", date: "7/22", type: "quality", distanceMiles: 4, keyWorkoutText: "Tempo 4mi (1mi WU + 2mi @ threshold + 1mi CD)" },
    { day: "Thu", date: "7/23", type: "strength", distanceMiles: null },
    { day: "Fri", date: "7/24", type: "easy", distanceMiles: 5 },
    { day: "Sat", date: "7/25", type: "long_run", distanceMiles: 12 },
  ];

  it("lists each non-rest slot on its own line, using the same label mapping as syncWeekFromArc", () => {
    const digest = formatWeeklyPlanDigest(skeleton);
    expect(digest).toContain("Wed 7/22 — Tempo 4mi (1mi WU + 2mi @ threshold + 1mi CD)");
    expect(digest).toContain("Thu 7/23 — Strength + mobility");
    expect(digest).toContain("Fri 7/24 — Easy 5mi");
    expect(digest).toContain("Sat 7/25 — Long run 12mi");
  });

  it("omits rest days entirely", () => {
    const digest = formatWeeklyPlanDigest(skeleton);
    expect(digest).not.toContain("Mon 7/20");
  });

  it("merges in pace from slotAnnotations when present, matched by day", () => {
    const digest = formatWeeklyPlanDigest(skeleton, [
      { day: "Wed", pace: "8:15/mi", why: "build lactate threshold" },
    ]);
    expect(digest).toContain("Wed 7/22 — Tempo 4mi (1mi WU + 2mi @ threshold + 1mi CD) (8:15/mi)");
    // No annotation for Sat — no parenthetical appended.
    expect(digest).toContain("Sat 7/25 — Long run 12mi");
    expect(digest).not.toContain("Sat 7/25 — Long run 12mi (");
  });

  it("omits pace entirely when slotAnnotations is null or has no match for a day", () => {
    const digest = formatWeeklyPlanDigest(skeleton, null);
    expect(digest).not.toContain("(8:15/mi)");
    const digestNoMatch = formatWeeklyPlanDigest(skeleton, [{ day: "Mon", pace: "9:00/mi" }]);
    expect(digestNoMatch).not.toContain("9:00/mi");
  });

  it("falls back to a generic quality label when keyWorkoutText is absent", () => {
    const noText: ArcWeekSlot[] = [{ day: "Wed", date: "7/22", type: "quality", distanceMiles: 4 }];
    expect(formatWeeklyPlanDigest(noText)).toContain("Wed 7/22 — Quality 4mi");
  });

  it("returns just the header when the skeleton is empty or all-rest", () => {
    expect(formatWeeklyPlanDigest([])).toBe("This week's plan:\n");
    expect(formatWeeklyPlanDigest([{ day: "Mon", date: "7/20", type: "rest", distanceMiles: null }])).toBe("This week's plan:\n");
  });

  it("converts long-run/easy/quality-fallback distances to km for metric users, matching route.ts's recapMi conversion", () => {
    const digest = formatWeeklyPlanDigest(skeleton, null, true);
    expect(digest).toContain("Fri 7/24 — Easy 8.0km"); // 5mi * 1.60934 = 8.0468 -> 8.0
    expect(digest).toContain("Sat 7/25 — Long run 19.3km"); // 12mi * 1.60934 = 19.312 -> 19.3
    // keyWorkoutText (quality with a stored workout string) is left as-is — it's already
    // baked in the athlete's preferred units at plan-generation time.
    expect(digest).toContain("Wed 7/22 — Tempo 4mi (1mi WU + 2mi @ threshold + 1mi CD)");
  });

  it("converts the quality fallback label to km for metric users when keyWorkoutText is absent", () => {
    const noText: ArcWeekSlot[] = [{ day: "Wed", date: "7/22", type: "quality", distanceMiles: 4 }];
    expect(formatWeeklyPlanDigest(noText, null, true)).toContain("Wed 7/22 — Quality 6.4km"); // 4mi * 1.60934 = 6.437 -> 6.4
  });
});
