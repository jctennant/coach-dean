import { describe, it, expect } from "vitest";
import { computePhaseForPlan } from "@/lib/training-plan";

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
