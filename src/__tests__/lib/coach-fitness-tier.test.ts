import { describe, it, expect } from "vitest";
import { buildFitnessTierBlock } from "@/lib/coach-fitness-tier";

function base(overrides: Partial<Parameters<typeof buildFitnessTierBlock>[0]> = {}) {
  return buildFitnessTierBlock({
    avgWeeklyMileage: null,
    forceBeginnerTier: false,
    fitnessLevel: "beginner",
    daysPerWeek: null,
    isMetric: false,
    ...overrides,
  });
}

describe("buildFitnessTierBlock — no-history tiers", () => {
  it("advanced self-report: 25-35mi target range, 20mi hard floor, 5+ days default", () => {
    const text = base({ fitnessLevel: "advanced" });
    expect(text).toContain("FITNESS TIER: No Strava history yet, but athlete self-reports as ADVANCED");
    expect(text).toContain("Start at 25.0 mi–35.0 mi for the week");
    expect(text).toContain("Spread across 5+ days");
    expect(text).toContain("Do not prescribe fewer than 20.0 mi");
  });

  it("advanced self-report honors an explicit days_per_week over the 5-day default", () => {
    const text = base({ fitnessLevel: "advanced", daysPerWeek: 6 });
    expect(text).toContain("Spread across 6+ days");
  });

  it("intermediate self-report: 15-25mi target range, 12mi hard floor, 4+ days default", () => {
    const text = base({ fitnessLevel: "intermediate" });
    expect(text).toContain("FITNESS TIER: No Strava history yet, but athlete self-reports as INTERMEDIATE");
    expect(text).toContain("Start at 15.0 mi–25.0 mi for the week");
    expect(text).toContain("Spread across 4+ days");
    expect(text).toContain("Do not prescribe fewer than 12.0 mi");
  });

  it("genuinely no data (beginner, avgWeeklyMileage null): 10mi hard cap", () => {
    const text = base({ avgWeeklyMileage: null, forceBeginnerTier: false, fitnessLevel: "beginner" });
    expect(text).toContain("FITNESS TIER: No activity data yet");
    expect(text).toContain("Week 1 must not exceed 10.0 mi total");
    expect(text).not.toContain("Strava shows");
  });

  it("stale history (forceBeginnerTier, avgWeeklyMileage non-null): still a 10mi hard cap, but mentions the Strava average", () => {
    const text = base({ avgWeeklyMileage: 18, forceBeginnerTier: true, fitnessLevel: "beginner" });
    expect(text).toContain("FITNESS TIER: Beginner self-report");
    expect(text).toContain("Strava shows 18.0 mi avg");
    expect(text).toContain("Week 1 must not exceed 10.0 mi total"); // same hard cap as no-data case
  });
});

describe("buildFitnessTierBlock — data-backed tiers", () => {
  it("LOW VOLUME (<10mi): cap is current x1.3 floored at 6, long run cap is x0.35 floored at 3", () => {
    const text = base({ avgWeeklyMileage: 7 });
    expect(text).toContain("FITNESS TIER: LOW VOLUME (avg 7.0 mi)");
    expect(text).toContain("MUST NOT exceed 10.0 mi total"); // ceil(7*1.3)=10
    expect(text).toContain("must not exceed 3.0 mi (35%"); // max(ceil(7*0.35),3) = max(3,3) = 3
  });

  it("LOW VOLUME floors kick in for very low mileage (6mi cap, 3mi long-run floor)", () => {
    const text = base({ avgWeeklyMileage: 2 });
    expect(text).toContain("MUST NOT exceed 6.0 mi total"); // max(ceil(2*1.3),6) = max(3,6) = 6
    expect(text).toContain("must not exceed 3.0 mi (35%"); // max(ceil(2*0.35),3) = max(1,3) = 3
  });

  it("MODERATE VOLUME (10-30mi): target 1.05-1.15x, ceiling 1.2x, floor 0.90x", () => {
    const text = base({ avgWeeklyMileage: 20 });
    expect(text).toContain("FITNESS TIER: MODERATE VOLUME (avg 20.0 mi)");
    expect(text).toContain("target 21.0 mi–23.0 mi"); // round(20*1.05)=21, round(20*1.15)=23
    expect(text).toContain("Do not exceed 24.0 mi"); // round(20*1.2)=24
    expect(text).toContain("must not fall below 18.0 mi"); // round(20*0.90)=18
  });

  it("HIGH VOLUME (>=30mi): target 1.05-1.12x, floor 0.90x", () => {
    const text = base({ avgWeeklyMileage: 45 });
    expect(text).toContain("FITNESS TIER: HIGH VOLUME (avg 45.0 mi)");
    expect(text).toContain("Week 1 target: 47.0 mi–50.0 mi"); // round(45*1.05)=47, round(45*1.12)=50
    expect(text).toContain("must not fall below 41.0 mi"); // round(45*0.90)=40.5 -> 41 (round-half-up)
  });

  it("boundary: exactly 10mi is MODERATE, not LOW", () => {
    const text = base({ avgWeeklyMileage: 10 });
    expect(text).toContain("MODERATE VOLUME");
  });

  it("boundary: exactly 30mi is HIGH, not MODERATE", () => {
    const text = base({ avgWeeklyMileage: 30 });
    expect(text).toContain("HIGH VOLUME");
  });

  it("formats in km when isMetric is true", () => {
    const text = base({ avgWeeklyMileage: 20, isMetric: true });
    expect(text).toContain("avg 32.2 km"); // 20 * 1.60934
    expect(text).not.toMatch(/\d+(\.\d+)?\s*mi\b/);
  });
});
