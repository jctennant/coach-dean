import { describe, it, expect } from "vitest";
import { computeLoadScores, computeRolling30dMaxRunningLoad, computeRecentFatigueLoad } from "@/lib/load-score";

describe("computeLoadScores", () => {
  const BASE = {
    moving_time_seconds: 3600, // 60 min
    average_heartrate: null,
    max_hr_estimate: null,
    average_pace: null,
    easy_pace: null,
    elevation_gain: null,
    distance_meters: null,
  };

  it("returns null scores for activities with no moving time", () => {
    const result = computeLoadScores({ ...BASE, activity_type: "Run", moving_time_seconds: 0 });
    expect(result.running_impact_load).toBeNull();
    expect(result.activity_fatigue_load).toBeNull();
  });

  it("flags WeightTraining as leg day with null scores", () => {
    const result = computeLoadScores({ ...BASE, activity_type: "WeightTraining" });
    expect(result.isLegDay).toBe(true);
    expect(result.running_impact_load).toBeNull();
    expect(result.activity_fatigue_load).toBeNull();
  });

  it("computes equal impact and fatigue for easy flat Run", () => {
    const result = computeLoadScores({
      ...BASE,
      activity_type: "Run",
      average_heartrate: 130,
      max_hr_estimate: 180, // 72% — zone 1-2, multiplier 1.0
    });
    expect(result.running_impact_load).toBe(60); // 60 min × 1.0
    expect(result.activity_fatigue_load).toBe(60);
    expect(result.isLegDay).toBe(false);
  });

  it("applies zone 4 multiplier for tempo HR", () => {
    const result = computeLoadScores({
      ...BASE,
      activity_type: "Run",
      average_heartrate: 162, // 90% of 180 → zone 4, ×2.0
      max_hr_estimate: 180,
    });
    expect(result.running_impact_load).toBe(120); // 60 × 2.0
    expect(result.activity_fatigue_load).toBe(120);
  });

  it("applies trail grade modifier for steep TrailRun", () => {
    // 10% average grade (1000m / 10000m) → modifier = 1.0 + (0.10 - 0.08) × 2 = 1.04
    const result = computeLoadScores({
      ...BASE,
      activity_type: "TrailRun",
      average_heartrate: 130,
      max_hr_estimate: 180,
      elevation_gain: 1000,
      distance_meters: 10000,
    });
    expect(result.running_impact_load).toBeGreaterThan(60); // should be higher than flat
    expect(result.grade_modifier_source).toBe("gps");
    // fatigue load is NOT grade-adjusted
    expect(result.activity_fatigue_load).toBe(60);
  });

  it("caps trail grade modifier at 1.4", () => {
    // Very steep — 50% grade
    const result = computeLoadScores({
      ...BASE,
      activity_type: "TrailRun",
      average_heartrate: 130,
      max_hr_estimate: 180,
      elevation_gain: 5000,
      distance_meters: 10000,
    });
    expect(result.running_impact_load).toBe(Math.round(60 * 1.4 * 10) / 10);
  });

  it("infers flat for treadmill with no elevation data", () => {
    const result = computeLoadScores({
      ...BASE,
      activity_type: "Treadmill",
      average_heartrate: 130,
      max_hr_estimate: 180,
      distance_meters: 8000,  // ~5 mph pace — not walking
    });
    expect(result.running_impact_load).toBe(60); // flat modifier = 1.0
    expect(result.grade_modifier_source).toBe("inferred_flat");
  });

  it("infers walking incline for slow treadmill with no elevation", () => {
    // < 1.8 m/s = walking pace → incline assumed
    const result = computeLoadScores({
      ...BASE,
      activity_type: "Treadmill",
      moving_time_seconds: 1800, // 30 min
      distance_meters: 2400, // 1.33 m/s = ~very slow
      elevation_gain: 0,
    });
    expect(result.grade_modifier_source).toBe("inferred_walk");
    // 30 min × 1.0 zone × 0.65 incline modifier = 19.5
    expect(result.running_impact_load).toBe(19.5);
  });

  it("applies 0.65 modifier for confirmed treadmill incline via GPS", () => {
    const result = computeLoadScores({
      ...BASE,
      activity_type: "Treadmill",
      average_heartrate: 130,
      max_hr_estimate: 180,
      elevation_gain: 200,
      distance_meters: 2000, // 10% grade > 5% threshold
    });
    expect(result.grade_modifier_source).toBe("gps");
    expect(result.running_impact_load).toBe(Math.round(60 * 0.65 * 10) / 10);
  });

  it("returns 0 running impact and ~0.8× fatigue for Ride", () => {
    const result = computeLoadScores({ ...BASE, activity_type: "Ride" });
    expect(result.running_impact_load).toBe(0);
    expect(result.activity_fatigue_load).toBe(48); // 60 × 0.8
  });

  it("applies 0.65× impact and 0.7× fatigue for Hike", () => {
    const result = computeLoadScores({ ...BASE, activity_type: "Hike" });
    expect(result.running_impact_load).toBe(Math.round(60 * 0.65 * 10) / 10);
    expect(result.activity_fatigue_load).toBe(Math.round(60 * 0.7 * 10) / 10);
  });

  it("falls back to pace-based zone when HR is not available", () => {
    // easy pace 9:00/mi = 540s/mi. tempo = 540 × 0.85 = 459s/mi.
    // avg pace 8:00/mi = 480s/mi — between tempo*0.92 (422) and easy (540) → zone 3 (1.5×)
    const result = computeLoadScores({
      ...BASE,
      activity_type: "Run",
      average_pace: "8:00/mi",
      easy_pace: "9:00/mi",
    });
    expect(result.running_impact_load).toBe(90); // 60 × 1.5
  });
});

describe("computeRolling30dMaxRunningLoad", () => {
  it("returns null for empty activity list", () => {
    expect(computeRolling30dMaxRunningLoad([])).toBeNull();
  });

  it("returns null for non-running activities", () => {
    const activities = [
      { running_impact_load: 80, start_date: new Date().toISOString(), activity_type: "Ride" },
    ];
    expect(computeRolling30dMaxRunningLoad(activities)).toBeNull();
  });

  it("returns max running_impact_load within 30 days", () => {
    const now = new Date();
    const recent = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86400000).toISOString();
    const activities = [
      { running_impact_load: 90, start_date: recent(5), activity_type: "Run" },
      { running_impact_load: 120, start_date: recent(10), activity_type: "TrailRun" },
      { running_impact_load: 200, start_date: recent(35), activity_type: "Run" }, // outside 30d
    ];
    expect(computeRolling30dMaxRunningLoad(activities)).toBe(120);
  });

  it("excludes activities older than 30 days", () => {
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    const activities = [{ running_impact_load: 150, start_date: old, activity_type: "Run" }];
    expect(computeRolling30dMaxRunningLoad(activities)).toBeNull();
  });
});

describe("computeRecentFatigueLoad", () => {
  it("sums activity_fatigue_load within the window", () => {
    const recent = new Date(Date.now() - 24 * 3600000).toISOString();
    const old = new Date(Date.now() - 72 * 3600000).toISOString();
    const activities = [
      { activity_fatigue_load: 50, start_date: recent },
      { activity_fatigue_load: 80, start_date: recent },
      { activity_fatigue_load: 200, start_date: old }, // outside 48h window
    ];
    expect(computeRecentFatigueLoad(activities, 48)).toBe(130);
  });

  it("returns 0 for empty list", () => {
    expect(computeRecentFatigueLoad([], 48)).toBe(0);
  });
});
