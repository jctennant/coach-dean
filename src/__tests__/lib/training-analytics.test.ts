import { describe, it, expect } from "vitest";
import {
  computeLoadTrend,
  computeAerobicEfficiencyTrend,
  computeCardiacDriftTrend,
  computeACWR,
  computeLongRunProgression,
  computeIntensityDistribution,
  computeCadenceTrend,
  computeElevationLoadTrend,
  buildRunExecutionAnalysis,
  buildLongitudinalBlock,
  type ActivityForAnalytics,
} from "@/lib/training-analytics";

const TZ = "America/New_York";

function makeActivity(opts: {
  daysAgo: number;
  miles: number;
  hr?: number;
  maxHr?: number;
  cadence?: number;
  elevGainM?: number;
  efficiency?: number;
  decoupling?: number;
  type?: string;
  workoutType?: number | null;
}): ActivityForAnalytics {
  // Anchor in the target TZ's current date (not UTC), since computeLoadTrend /
  // computeLongRunProgression group weeks in the target TZ. Using UTC midnight
  // caused drift at day boundaries (e.g. NY Sun 23:00 = UTC Mon 03:00 meant
  // daysAgo:7 landed in the wrong ISO week). Anchoring at noon in the TZ avoids
  // any time-of-day drift.
  const nowLocal = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const [ly, lm, ld] = nowLocal.split("-").map(Number);
  const d = new Date(Date.UTC(ly, lm - 1, ld - opts.daysAgo, 12, 0, 0));
  return {
    start_date: d.toISOString(),
    activity_type: opts.type ?? "Run",
    workout_type: opts.workoutType ?? null,
    distance_meters: opts.miles * 1609.34,
    moving_time_seconds: opts.miles * 9 * 60, // ~9 min/mi
    average_heartrate: opts.hr ?? null,
    max_heartrate: opts.maxHr ?? null,
    elevation_gain: opts.elevGainM ?? null,
    average_cadence: opts.cadence ?? null,
    aerobic_efficiency: opts.efficiency ?? null,
    cardiac_decoupling_pct: opts.decoupling ?? null,
  };
}

// ─── computeACWR ─────────────────────────────────────────────────────────────

describe("computeACWR", () => {
  it("returns null ACWR when insufficient data", () => {
    const result = computeACWR([], TZ);
    expect(result.acwr).toBeNull();
    expect(result.flagged).toBe(false);
  });

  it("computes ratio correctly and flags >1.3", () => {
    // 24mi in last 7 days, 8mi chronic avg → ACWR = 3.0
    const activities: ActivityForAnalytics[] = [
      makeActivity({ daysAgo: 1, miles: 8 }),
      makeActivity({ daysAgo: 3, miles: 8 }),
      makeActivity({ daysAgo: 5, miles: 8 }),
      // older runs to establish chronic baseline
      makeActivity({ daysAgo: 10, miles: 6 }),
      makeActivity({ daysAgo: 17, miles: 6 }),
      makeActivity({ daysAgo: 24, miles: 6 }),
    ];
    const result = computeACWR(activities, TZ);
    expect(result.acwr).not.toBeNull();
    expect(result.flagged).toBe(true);
    expect(result.summary).toContain("high injury-risk");
  });

  it("does not flag ACWR in the safe range", () => {
    // ~8mi each week for 4 weeks → ACWR ≈ 1.0
    const activities: ActivityForAnalytics[] = [
      makeActivity({ daysAgo: 2, miles: 4 }),
      makeActivity({ daysAgo: 4, miles: 4 }),
      makeActivity({ daysAgo: 9, miles: 4 }),
      makeActivity({ daysAgo: 11, miles: 4 }),
      makeActivity({ daysAgo: 16, miles: 4 }),
      makeActivity({ daysAgo: 18, miles: 4 }),
      makeActivity({ daysAgo: 23, miles: 4 }),
      makeActivity({ daysAgo: 25, miles: 4 }),
    ];
    const result = computeACWR(activities, TZ);
    expect(result.flagged).toBe(false);
  });
});

// ─── computeLongRunProgression ────────────────────────────────────────────────

describe("computeLongRunProgression", () => {
  it("returns insufficient_data when <3 weeks of data", () => {
    const activities = [
      makeActivity({ daysAgo: 5, miles: 10 }),
      makeActivity({ daysAgo: 12, miles: 9 }),
    ];
    const result = computeLongRunProgression(activities, TZ);
    expect(result.trend).toBe("insufficient_data");
  });

  it("detects overreaching when long run jumps >25%", () => {
    // Long run was 10mi, jumped to 16mi (60% jump)
    const activities = [
      makeActivity({ daysAgo: 5, miles: 16 }),   // this week's long run
      makeActivity({ daysAgo: 12, miles: 10 }),
      makeActivity({ daysAgo: 19, miles: 10 }),
      makeActivity({ daysAgo: 26, miles: 9 }),
      makeActivity({ daysAgo: 33, miles: 9 }),
    ];
    const result = computeLongRunProgression(activities, TZ);
    expect(result.trend).toBe("overreaching");
    expect(result.summary).toContain("jumped");
  });

  it("detects stagnation when long run plateaus for 4+ weeks", () => {
    const activities: ActivityForAnalytics[] = [];
    // Same long run (10mi) for 5 consecutive weeks, with a short run each week
    for (let i = 1; i <= 5; i++) {
      activities.push(makeActivity({ daysAgo: i * 7 - 1, miles: 10 }));
      activities.push(makeActivity({ daysAgo: i * 7 - 4, miles: 4 }));
    }
    const result = computeLongRunProgression(activities, TZ);
    expect(result.trend).toBe("stagnating");
    expect(result.summary).toContain("plateaued");
  });
});

// ─── computeIntensityDistribution ────────────────────────────────────────────

describe("computeIntensityDistribution", () => {
  it("returns empty result when <5 runs with HR", () => {
    const activities = [
      makeActivity({ daysAgo: 2, miles: 5, hr: 145 }),
      makeActivity({ daysAgo: 5, miles: 5, hr: 150 }),
    ];
    const result = computeIntensityDistribution(activities);
    expect(result.observedMaxHR).toBeNull();
  });

  it("detects zone 3 trap when majority of runs are moderate intensity", () => {
    // Observed max HR = 180; moderate zone = 137-158 bpm (76-88%)
    // All runs at ~150 bpm = 83% of max → moderate zone
    const activities: ActivityForAnalytics[] = Array.from({ length: 8 }, (_, i) => ({
      ...makeActivity({ daysAgo: i * 3 + 1, miles: 5, hr: 150, maxHr: 180 }),
    }));
    const result = computeIntensityDistribution(activities);
    expect(result.inZone3Trap).toBe(true);
    expect(result.moderatePct).toBeGreaterThan(50);
    expect(result.summary).toContain("gray zone");
  });

  it("rejects single-run sensor spike when classifying intensity", () => {
    // Athlete's true max ≈ 180. One spike activity reads max_heartrate 220
    // (sensor artifact). With the old raw Math.max approach, 220 would become
    // the denominator: 150/220 = 68% → all runs classified easy (wrong).
    // With the tiered estimator, the spike's ratio (220/150=1.47) exceeds the
    // tier-3 cap (1.40), so it's filtered out and 180 is used: 150/180 = 83% → moderate.
    const activities: ActivityForAnalytics[] = [
      ...Array.from({ length: 7 }, (_, i) => makeActivity({ daysAgo: i * 3 + 1, miles: 5, hr: 150, maxHr: 180 })),
      makeActivity({ daysAgo: 25, miles: 5, hr: 150, maxHr: 220 }),
    ];
    const result = computeIntensityDistribution(activities);
    expect(result.observedMaxHR).toBeLessThan(200);
    expect(result.moderatePct).toBeGreaterThan(50);
  });

  it("uses caller-supplied estimatedMaxHR when provided", () => {
    const activities: ActivityForAnalytics[] = Array.from({ length: 6 }, (_, i) =>
      makeActivity({ daysAgo: i * 3 + 1, miles: 5, hr: 150, maxHr: 180 })
    );
    // Caller passes a much higher max → 150 / 200 = 75% → easy boundary
    const result = computeIntensityDistribution(activities, 200);
    expect(result.observedMaxHR).toBe(200);
    expect(result.easyPct + result.moderatePct).toBe(100);
  });

  it("identifies good polarized distribution", () => {
    // Mix: easy runs at 130 bpm (72% of 180) and hard at 170 bpm (94% of 180)
    const activities: ActivityForAnalytics[] = [
      ...Array.from({ length: 6 }, (_, i) => makeActivity({ daysAgo: i * 3 + 1, miles: 6, hr: 130, maxHr: 180 })),
      ...Array.from({ length: 2 }, (_, i) => makeActivity({ daysAgo: i * 7 + 5, miles: 4, hr: 170, maxHr: 180 })),
    ];
    const result = computeIntensityDistribution(activities);
    expect(result.inZone3Trap).toBe(false);
    expect(result.easyPct).toBeGreaterThanOrEqual(60);
  });
});

// ─── computeCadenceTrend ──────────────────────────────────────────────────────

describe("computeCadenceTrend", () => {
  it("returns insufficient_data when <4 runs with cadence", () => {
    const result = computeCadenceTrend([
      makeActivity({ daysAgo: 1, miles: 5, cadence: 165 }),
      makeActivity({ daysAgo: 4, miles: 5, cadence: 163 }),
    ]);
    expect(result.trend).toBe("insufficient_data");
  });

  it("flags cadence below 170 spm", () => {
    const activities = Array.from({ length: 6 }, (_, i) =>
      makeActivity({ daysAgo: i * 3 + 1, miles: 5, cadence: 162 })
    );
    const result = computeCadenceTrend(activities);
    expect(result.flaggedLow).toBe(true);
    expect(result.summary).toContain("170");
  });

  it("does not flag cadence at or above 170 spm", () => {
    const activities = Array.from({ length: 6 }, (_, i) =>
      makeActivity({ daysAgo: i * 3 + 1, miles: 5, cadence: 175 })
    );
    const result = computeCadenceTrend(activities);
    expect(result.flaggedLow).toBe(false);
  });
});

// ─── computeElevationLoadTrend ────────────────────────────────────────────────

describe("computeElevationLoadTrend", () => {
  it("returns insufficient_data when avg vert is very low", () => {
    // Flat runs ~30m gain each = ~100ft/week — below 200ft threshold
    const activities = Array.from({ length: 10 }, (_, i) =>
      makeActivity({ daysAgo: i * 4 + 1, miles: 5, elevGainM: 30 })
    );
    const result = computeElevationLoadTrend(activities, TZ);
    expect(result.trend).toBe("insufficient_data");
  });

  it("detects increasing elevation trend for trail runners", () => {
    // Recent 4 weeks averaging ~700m/week, prior 4 weeks ~300m/week
    const activities: ActivityForAnalytics[] = [
      // recent (high vert)
      makeActivity({ daysAgo: 3, miles: 10, elevGainM: 700 }),
      makeActivity({ daysAgo: 10, miles: 10, elevGainM: 700 }),
      makeActivity({ daysAgo: 17, miles: 10, elevGainM: 700 }),
      makeActivity({ daysAgo: 24, miles: 10, elevGainM: 700 }),
      // prior (low vert)
      makeActivity({ daysAgo: 31, miles: 10, elevGainM: 300 }),
      makeActivity({ daysAgo: 38, miles: 10, elevGainM: 300 }),
      makeActivity({ daysAgo: 45, miles: 10, elevGainM: 300 }),
      makeActivity({ daysAgo: 52, miles: 10, elevGainM: 300 }),
    ];
    const result = computeElevationLoadTrend(activities, TZ);
    expect(result.trend).toBe("increasing");
    expect(result.avgWeeklyVertFeet).toBeGreaterThan(500);
  });
});

// ─── buildRunExecutionAnalysis ────────────────────────────────────────────────

describe("buildRunExecutionAnalysis", () => {
  it("returns insufficient_data for null splits", () => {
    const result = buildRunExecutionAnalysis(null);
    expect(result.executionQuality).toBe("insufficient_data");
    expect(result.summary).toBe("");
  });

  it("returns insufficient_data for <4 splits", () => {
    const splits = [
      { average_speed: 3.0, moving_time: 537, distance: 1609 },
      { average_speed: 3.0, moving_time: 537, distance: 1609 },
    ];
    const result = buildRunExecutionAnalysis(splits);
    expect(result.executionQuality).toBe("insufficient_data");
  });

  it("detects significant fade when second half is >15s/mi slower", () => {
    // First 3 miles at ~9min/mi (2.99 m/s), last 3 at ~11min/mi (2.44 m/s)
    const splits = [
      { average_speed: 2.99, moving_time: 537, distance: 1609 },
      { average_speed: 2.99, moving_time: 537, distance: 1609 },
      { average_speed: 2.99, moving_time: 537, distance: 1609 },
      { average_speed: 2.44, moving_time: 659, distance: 1609 },
      { average_speed: 2.44, moving_time: 659, distance: 1609 },
      { average_speed: 2.44, moving_time: 659, distance: 1609 },
    ];
    const result = buildRunExecutionAnalysis(splits);
    expect(result.executionQuality).toBe("significant_fade");
    expect(result.fadeSecs).toBeGreaterThan(15);
    expect(result.summary).toContain("faded");
  });

  it("detects negative split when second half is ≥6s/mi faster", () => {
    // First 3 miles at 10min/mi (2.68 m/s), last 3 at 9min/mi (2.99 m/s)
    const splits = [
      { average_speed: 2.68, moving_time: 600, distance: 1609 },
      { average_speed: 2.68, moving_time: 600, distance: 1609 },
      { average_speed: 2.68, moving_time: 600, distance: 1609 },
      { average_speed: 2.99, moving_time: 537, distance: 1609 },
      { average_speed: 2.99, moving_time: 537, distance: 1609 },
      { average_speed: 2.99, moving_time: 537, distance: 1609 },
    ];
    const result = buildRunExecutionAnalysis(splits);
    expect(result.executionQuality).toBe("negative_split");
    expect(result.fadeSecs).toBeLessThan(-5);
    expect(result.summary).toContain("negative split");
  });

  it("classifies even pacing when halves are within 6s/mi", () => {
    const splits = Array.from({ length: 6 }, () => ({
      average_speed: 2.99,
      moving_time: 537,
      distance: 1609,
    }));
    const result = buildRunExecutionAnalysis(splits);
    expect(result.executionQuality).toBe("even");
    expect(result.summary).toContain("even");
  });

  it("uses grade-adjusted speed (GAP) when available and calls it grade-adjusted", () => {
    // Raw pace looks like a negative split (slower first half, faster second half)
    // but GAP shows even effort — first half was uphill, second was downhill.
    // average_grade_adjusted_speed ~= 3.0 m/s (9:00/mi) throughout.
    const splits = [
      { average_speed: 2.68, moving_time: 600, distance: 1609, elevation_difference: 40, average_grade_adjusted_speed: 3.0 },
      { average_speed: 2.68, moving_time: 600, distance: 1609, elevation_difference: 40, average_grade_adjusted_speed: 3.0 },
      { average_speed: 2.68, moving_time: 600, distance: 1609, elevation_difference: 40, average_grade_adjusted_speed: 3.0 },
      { average_speed: 2.99, moving_time: 537, distance: 1609, elevation_difference: -40, average_grade_adjusted_speed: 3.0 },
      { average_speed: 2.99, moving_time: 537, distance: 1609, elevation_difference: -40, average_grade_adjusted_speed: 3.0 },
      { average_speed: 2.99, moving_time: 537, distance: 1609, elevation_difference: -40, average_grade_adjusted_speed: 3.0 },
    ];
    const result = buildRunExecutionAnalysis(splits);
    // GAP shows even effort despite raw pace looking like negative split
    expect(result.executionQuality).toBe("even");
    expect(result.summary).toContain("grade-adjusted");
  });

  it("flags elevation-assisted second half as downhill when GAP unavailable but elevation favors second half", () => {
    // Raw pace negative split, no GAP, but second half clearly descending
    const splits = [
      { average_speed: 2.68, moving_time: 600, distance: 1609, elevation_difference: 60 },
      { average_speed: 2.68, moving_time: 600, distance: 1609, elevation_difference: 60 },
      { average_speed: 2.68, moving_time: 600, distance: 1609, elevation_difference: 60 },
      { average_speed: 2.99, moving_time: 537, distance: 1609, elevation_difference: -60 },
      { average_speed: 2.99, moving_time: 537, distance: 1609, elevation_difference: -60 },
      { average_speed: 2.99, moving_time: 537, distance: 1609, elevation_difference: -60 },
    ];
    const result = buildRunExecutionAnalysis(splits);
    expect(result.executionQuality).toBe("negative_split");
    expect(result.summary).toContain("downhill");
    expect(result.summary).not.toContain("pacing discipline");
  });
});

// ─── buildLongitudinalBlock ───────────────────────────────────────────────────

describe("buildLongitudinalBlock", () => {
  it("returns empty string when no activity data", () => {
    const result = buildLongitudinalBlock([], TZ);
    expect(result).toBe("");
  });

  it("includes load trend when mileage data is available", () => {
    const activities = Array.from({ length: 10 }, (_, i) =>
      makeActivity({ daysAgo: i * 5 + 2, miles: 5 })
    );
    const result = buildLongitudinalBlock(activities, TZ);
    expect(result).toContain("LONGITUDINAL TRAINING ANALYSIS");
    expect(result).toContain("8-week mileage trend");
  });

  it("includes ACWR flag when load is dangerously high", () => {
    // Spike this week: 24mi in last 7 days vs ~6mi chronic avg
    const activities: ActivityForAnalytics[] = [
      makeActivity({ daysAgo: 1, miles: 8 }),
      makeActivity({ daysAgo: 3, miles: 8 }),
      makeActivity({ daysAgo: 5, miles: 8 }),
      makeActivity({ daysAgo: 14, miles: 5 }),
      makeActivity({ daysAgo: 21, miles: 5 }),
      makeActivity({ daysAgo: 28, miles: 4 }),
    ];
    const result = buildLongitudinalBlock(activities, TZ);
    expect(result).toContain("injury-risk");
  });

  it("includes zone 3 trap when intensity distribution is flagged", () => {
    const activities: ActivityForAnalytics[] = Array.from({ length: 10 }, (_, i) => ({
      ...makeActivity({ daysAgo: i * 3 + 1, miles: 5, hr: 152, maxHr: 185 }),
    }));
    const result = buildLongitudinalBlock(activities, TZ);
    expect(result).toContain("gray zone");
  });
});

// ─── existing functions still pass ───────────────────────────────────────────

describe("computeLoadTrend (regression)", () => {
  it("returns all-zero weeks and no flag for empty activities", () => {
    const result = computeLoadTrend([], TZ);
    expect(result.weeklyMiles.every(m => m === 0)).toBe(true);
    expect(result.flagged).toBe(false);
  });

  it("flags week-over-week jump >10%", () => {
    // daysAgo:7 / daysAgo:14 land exactly one/two ISO weeks back regardless of
    // which day of the week the test runs — computeLoadTrend excludes the
    // current partial week, so daysAgo:3 would silently be dropped on Thu–Sun.
    const activities: ActivityForAnalytics[] = [
      makeActivity({ daysAgo: 7, miles: 30 }),  // most recent complete week
      makeActivity({ daysAgo: 14, miles: 20 }), // prior complete week
    ];
    const result = computeLoadTrend(activities, TZ);
    expect(result.flagged).toBe(true);
    expect(result.summary).toContain("⚠️");
  });
});

describe("computeAerobicEfficiencyTrend (regression)", () => {
  it("returns insufficient_data for <4 qualifying runs", () => {
    const result = computeAerobicEfficiencyTrend([], TZ);
    expect(result.trend).toBe("insufficient_data");
  });
});

describe("computeCardiacDriftTrend (regression)", () => {
  it("returns insufficient_data for <3 long runs", () => {
    const result = computeCardiacDriftTrend([]);
    expect(result.trend).toBe("insufficient_data");
  });
});
