import { describe, it, expect } from "vitest";
import { parseKeyWorkoutMiles } from "@/lib/parse-key-workout-miles";

// ---------------------------------------------------------------------------
// 1. Explicit total at start
// ---------------------------------------------------------------------------
describe("parseKeyWorkoutMiles — explicit total at start", () => {
  it("parses integer mi at start", () => {
    expect(parseKeyWorkoutMiles("4mi tempo @ threshold")).toBe(4);
  });

  it("parses decimal mi at start", () => {
    expect(parseKeyWorkoutMiles("3.5mi easy run")).toBe(3.5);
  });
});

// ---------------------------------------------------------------------------
// 2. Explicit total after label word: "Tempo 3.5mi (...)"
// ---------------------------------------------------------------------------
describe("parseKeyWorkoutMiles — label-prefixed total", () => {
  it("parses 'Tempo 3.5mi (...)' as 3.5", () => {
    expect(parseKeyWorkoutMiles("Tempo 3.5mi (1mi WU + 1.5mi @ 9:30/mi + 1mi CD)")).toBe(3.5);
  });

  it("parses 'Intervals 4mi (...)' as 4", () => {
    expect(parseKeyWorkoutMiles("Intervals 4mi (1mi WU + 4×400m + 1mi CD)")).toBe(4);
  });

  it("parses 'Race simulation 5.5mi (...)' as 5.5", () => {
    expect(parseKeyWorkoutMiles("Race simulation 5.5mi (1mi WU + 3.5mi @ goal pace + 1mi CD)")).toBe(5.5);
  });

  it("does NOT grab rep count distance from '6×1mi repeats'", () => {
    // "6×1mi" — the × before the number should suppress label-dist extraction
    const result = parseKeyWorkoutMiles("6×1mi repeats @ 5K pace");
    // Falls through to distance-based reps: 6 × 1mi = 6
    expect(result).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 3. Distance-based reps
// ---------------------------------------------------------------------------
describe("parseKeyWorkoutMiles — distance-based reps", () => {
  it("4×800m → ~2mi", () => {
    expect(parseKeyWorkoutMiles("4×800m @ 5K pace")).toBeCloseTo(2.0, 0);
  });

  it("5×1000m → ~3.1mi", () => {
    expect(parseKeyWorkoutMiles("5×1000m @ threshold")).toBeCloseTo(3.1, 0);
  });

  it("6×1mi → 6mi", () => {
    expect(parseKeyWorkoutMiles("6×1mi repeats")).toBe(6);
  });

  it("does NOT parse '4×3min' as distance-based (min ≠ meters)", () => {
    // "4×3min" must not match as 4×3m ≈ 0mi
    const result = parseKeyWorkoutMiles("4×3min @ 8:30/mi with 2min recovery jog");
    expect(result).not.toBe(0);
    expect(result).toBeGreaterThan(1);
  });

  it("adds WU/CD when present with distance reps", () => {
    // 4×800m ≈ 2mi, + 1mi WU + 1mi CD = 4mi
    const result = parseKeyWorkoutMiles("4×800m @ 5K pace (1mi WU + 4×800m + 1mi CD)");
    expect(result).toBeCloseTo(4.0, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Time-based reps with pace — the main new case
// ---------------------------------------------------------------------------
describe("parseKeyWorkoutMiles — time-based reps with pace", () => {
  it("4×3min @ 8:30/mi with 2min recovery → ~2mi main set", () => {
    // work: 4 × 3/8.5 = 1.41mi, recovery: 3 × 2/10.5 = 0.57mi → ~2mi
    const result = parseKeyWorkoutMiles("4×3min @ 8:30/mi with 2min recovery jog");
    expect(result).toBeGreaterThanOrEqual(1.5);
    expect(result).toBeLessThanOrEqual(2.5);
  });

  it("adds WU/CD to time-based estimate", () => {
    // same as above + 1mi WU + 1mi CD = ~4mi
    const result = parseKeyWorkoutMiles("Intervals (1mi WU + 4×3min @ 8:30/mi with 2min recovery jog + 1mi CD)");
    expect(result).toBeGreaterThanOrEqual(3.5);
    expect(result).toBeLessThanOrEqual(4.5);
  });

  it("uses stated recovery time when present", () => {
    const with2min = parseKeyWorkoutMiles("6×2min @ 8:30/mi with 2min recovery");
    const with3min = parseKeyWorkoutMiles("6×2min @ 8:30/mi with 3min recovery");
    // More recovery time → more distance
    expect(with3min!).toBeGreaterThan(with2min!);
  });

  it("defaults to 2min recovery when not stated", () => {
    const explicit = parseKeyWorkoutMiles("4×3min @ 8:30/mi with 2min recovery");
    const implicit = parseKeyWorkoutMiles("4×3min @ 8:30/mi");
    expect(implicit).toBeCloseTo(explicit!, 1);
  });

  it("handles km pace correctly", () => {
    // 4×3min @ 5:17/km (≈ 8:30/mi) should give similar result to mi pace version
    const mi = parseKeyWorkoutMiles("4×3min @ 8:30/mi with 2min recovery");
    const km = parseKeyWorkoutMiles("4×3min @ 5:17/km with 2min recovery");
    expect(km!).toBeCloseTo(mi!, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. WU/CD only (no parseable main set distance or pace)
// ---------------------------------------------------------------------------
describe("parseKeyWorkoutMiles — WU/CD only", () => {
  it("sums WU + CD when main set has no pace", () => {
    expect(parseKeyWorkoutMiles("Intervals (1mi WU + 4×3min + 1mi CD)")).toBe(2);
  });

  it("handles 0.75mi WU/CD", () => {
    expect(parseKeyWorkoutMiles("Tempo (0.75mi WU + main set + 0.75mi CD)")).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// 6. Returns null for unparseable inputs → caller uses 20% fallback
// ---------------------------------------------------------------------------
describe("parseKeyWorkoutMiles — returns null for unparseable", () => {
  it("returns null for strides", () => {
    expect(parseKeyWorkoutMiles("6×strides @ 90% effort")).toBeNull();
  });

  it("returns null for fartlek without distance or pace", () => {
    expect(parseKeyWorkoutMiles("20min fartlek")).toBeNull();
  });

  it("returns null for pure easy description", () => {
    // "Easy" key_workouts are handled upstream (isEasyKeyWorkout), but just in case
    // a non-Easy string slips through with no parseable info, return null
    expect(parseKeyWorkoutMiles("Hill repeats 6×90sec uphill")).toBeNull();
  });
});
