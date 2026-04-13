import { describe, it, expect } from "vitest";
import {
  buildSplitAnalysis,
  selectActivityEmoji,
  processSplitsForMetrics,
  computeAerobicEfficiency,
  computeCardiacDecoupling,
  formatBestGapLine,
  type SplitMetrics,
} from "@/app/api/coach/respond/route";

// Helper: build a mock Strava split object from speed in m/s
function split(averageSpeed: number, averageGradeAdjustedSpeed?: number): Record<string, unknown> {
  return {
    distance: 1609.34,
    moving_time: Math.round(1609.34 / averageSpeed),
    average_speed: averageSpeed,
    average_grade_adjusted_speed: averageGradeAdjustedSpeed ?? averageSpeed,
    split: 1,
  };
}

// m/s → sec/mile
function mpsToSecPerMile(mps: number): number {
  return 1609.34 / mps;
}

// sec/mile → "M:SS/mi"
function formatMile(secPerMile: number): string {
  const m = Math.floor(secPerMile / 60);
  const s = Math.round(secPerMile % 60);
  return `${m}:${s.toString().padStart(2, "0")}/mi`;
}

// ─── buildSplitAnalysis ───────────────────────────────────────────────────────

describe("buildSplitAnalysis", () => {
  it("returns null for fewer than 2 splits", () => {
    expect(buildSplitAnalysis([], false)).toBeNull();
    expect(buildSplitAnalysis([split(3.0)], false)).toBeNull();
  });

  it("formats split paces correctly for imperial", () => {
    // 3.07 m/s → 1609.34 / 3.07 = 524.2s → 8:44/mi
    const splits = [split(3.07), split(3.20)];
    const result = buildSplitAnalysis(splits, false);
    expect(result).not.toBeNull();
    expect(result).toContain(formatMile(mpsToSecPerMile(3.07)));
    expect(result).toContain(formatMile(mpsToSecPerMile(3.20)));
    expect(result).toContain("/mi");
    expect(result).not.toContain("/km");
  });

  it("formats split paces correctly for metric", () => {
    // 3.07 m/s → 1000 / 3.07 = 325.7s → 5:26/km
    const splits = [split(3.07), split(3.20)];
    const result = buildSplitAnalysis(splits, true);
    expect(result).not.toBeNull();
    expect(result).toContain("/km");
    expect(result).not.toContain("/mi");
  });

  it("numbers the splits sequentially", () => {
    const splits = [split(3.0), split(3.1), split(3.2)];
    const result = buildSplitAnalysis(splits, false)!;
    expect(result).toContain("1:");
    expect(result).toContain("2:");
    expect(result).toContain("3:");
  });

  it("skips splits with zero or missing speed", () => {
    const splits = [split(3.0), { distance: 1609.34, average_speed: 0 }, split(3.1)];
    const result = buildSplitAnalysis(splits, false);
    // Only 2 valid splits — should still return a result (not null)
    expect(result).not.toBeNull();
    // Should only have 2 numbered entries
    expect(result).toContain("1:");
    expect(result).toContain("2:");
    expect(result).not.toContain("3:");
  });

  it("returns null if fewer than 2 valid speeds after filtering", () => {
    const splits = [{ distance: 1609.34, average_speed: 0 }, split(3.0)];
    // Only 1 valid speed → null
    expect(buildSplitAnalysis(splits, false)).toBeNull();
  });

  it("omits comparison for fewer than 4 splits", () => {
    const splits = [split(3.0), split(3.3)];
    const result = buildSplitAnalysis(splits, false)!;
    expect(result).not.toContain("split");
    expect(result).not.toContain("half");
  });

  it("detects negative split (second half faster)", () => {
    // First half: ~9:00/mi (2.98 m/s), second half: ~8:00/mi (3.35 m/s)
    const splits = [split(2.98), split(2.98), split(3.35), split(3.35)];
    const result = buildSplitAnalysis(splits, false)!;
    expect(result).toContain("negative split");
    expect(result).toContain("second");
  });

  it("detects positive split (second half slower)", () => {
    // First half: ~8:00/mi, second half: ~9:30/mi
    const splits = [split(3.35), split(3.35), split(2.83), split(2.83)];
    const result = buildSplitAnalysis(splits, false)!;
    expect(result).toContain("positive split");
    expect(result).toContain("first");
  });

  it("omits comparison when halves differ by less than 5 seconds", () => {
    // Negligible 2-second difference
    const splits = [split(3.07), split(3.07), split(3.08), split(3.08)];
    const result = buildSplitAnalysis(splits, false)!;
    expect(result).not.toContain("split —");
  });

  it("filters paused-device splits (pace > 20 min/mile)", () => {
    // 0.05 m/s ≈ 536 min/mile — athlete forgot to stop Strava
    const paused = { distance: 800, average_speed: 0.05 };
    const splits = [split(3.0), split(3.1), paused, split(3.2)];
    const result = buildSplitAnalysis(splits, false)!;
    // Paused split should be excluded — only 3 valid entries
    expect(result).toContain("1:");
    expect(result).toContain("2:");
    expect(result).toContain("3:");
    expect(result).not.toContain("4:");
  });

  it("handles a long run with many splits", () => {
    // 16-mile long run with a mild negative split
    const firstHalf = Array(8).fill(null).map(() => split(2.90)); // ~9:14/mi
    const secondHalf = Array(8).fill(null).map(() => split(3.00)); // ~8:57/mi
    const result = buildSplitAnalysis([...firstHalf, ...secondHalf], false)!;
    expect(result).toContain("negative split");
    // Should have 16 numbered splits
    expect(result).toContain("16:");
  });
});

// ─── selectActivityEmoji ─────────────────────────────────────────────────────

describe("selectActivityEmoji", () => {
  it("returns runner emoji for a standard road run", () => {
    expect(selectActivityEmoji("Run", 0, 0)).toBe("🏃");
  });

  it("returns lightning for interval workout (workout_type 3)", () => {
    expect(selectActivityEmoji("Run", 3, 0)).toBe("⚡️");
  });

  it("returns tree for trail run with low elevation", () => {
    expect(selectActivityEmoji("TrailRun", 0, 200)).toBe("🌲");
  });

  it("returns mountain when elevation >= 500ft (overrides trail)", () => {
    expect(selectActivityEmoji("TrailRun", 0, 500)).toBe("⛰️");
    expect(selectActivityEmoji("TrailRun", 0, 1200)).toBe("⛰️");
  });

  it("returns mountain when elevation >= 500ft on a road run", () => {
    expect(selectActivityEmoji("Run", 0, 600)).toBe("⛰️");
  });

  it("trail overrides interval emoji when elevation < 500ft", () => {
    // Trail interval with low elevation: 🌲 wins over ⚡️
    expect(selectActivityEmoji("TrailRun", 3, 200)).toBe("🌲");
  });

  it("mountain wins over interval emoji when elevation >= 500ft", () => {
    expect(selectActivityEmoji("TrailRun", 3, 600)).toBe("⛰️");
    expect(selectActivityEmoji("Run", 3, 600)).toBe("⛰️");
  });
});

// ─── processSplitsForMetrics ─────────────────────────────────────────────────

describe("processSplitsForMetrics", () => {
  it("returns all nulls for empty splits", () => {
    const result = processSplitsForMetrics([], false);
    expect(result.validSplitMetrics).toHaveLength(0);
    expect(result.gaSpeedMs).toBeNull();
    expect(result.bestGas).toBeNull();
    expect(result.bestGapSplitNum).toBeNull();
  });

  it("filters out zero-speed splits", () => {
    const splits = [{ average_speed: 0, distance: 1609 }, split(3.0)];
    const result = processSplitsForMetrics(splits, false);
    expect(result.validSplitMetrics).toHaveLength(1);
    expect(result.validSplitMetrics[0].speed).toBe(3.0);
  });

  it("filters out paused-device splits (pace > 20 min/mile)", () => {
    // 0.05 m/s ≈ 536 min/mile
    const paused = { average_speed: 0.05, distance: 800 };
    const splits = [split(3.0), paused, split(3.1)];
    const result = processSplitsForMetrics(splits, false);
    expect(result.validSplitMetrics).toHaveLength(2);
  });

  it("paused threshold: keeps splits near but under 20 min/mile pace", () => {
    // 1.35 m/s ≈ 19.9 min/mile — just under the 20 min/mile cutoff → included
    const justUnder = { average_speed: 1.35, distance: 1609 };
    // 1.33 m/s ≈ 20.2 min/mile — just over the cutoff → filtered out
    const justOver = { average_speed: 1.33, distance: 1609 };
    expect(processSplitsForMetrics([justUnder], false).validSplitMetrics).toHaveLength(1);
    expect(processSplitsForMetrics([justOver], false).validSplitMetrics).toHaveLength(0);
  });

  it("computes weighted GA speed from distance", () => {
    // Two splits: 1000m @ 3.0 m/s GA, 2000m @ 4.0 m/s GA
    // Weighted avg = (3.0*1000 + 4.0*2000) / 3000 = 11000/3000 ≈ 3.667
    const s1 = { average_speed: 3.0, average_grade_adjusted_speed: 3.0, distance: 1000 };
    const s2 = { average_speed: 4.0, average_grade_adjusted_speed: 4.0, distance: 2000 };
    const result = processSplitsForMetrics([s1, s2], false);
    expect(result.gaSpeedMs).toBeCloseTo(11000 / 3000, 5);
  });

  it("returns null gaSpeedMs when no GA speed data", () => {
    const s = { average_speed: 3.0, distance: 1609 }; // no average_grade_adjusted_speed
    const result = processSplitsForMetrics([s], false);
    expect(result.gaSpeedMs).toBeNull();
  });

  it("identifies the fastest split as bestGas", () => {
    const s1 = { average_speed: 3.0, average_grade_adjusted_speed: 3.0, distance: 1609 };
    const s2 = { average_speed: 4.0, average_grade_adjusted_speed: 4.0, distance: 1609 }; // fastest
    const s3 = { average_speed: 3.5, average_grade_adjusted_speed: 3.5, distance: 1609 };
    const result = processSplitsForMetrics([s1, s2, s3], false);
    expect(result.bestGas).toBe(4.0);
    expect(result.bestGapSplitNum).toBe(2); // 1-indexed within valid splits
  });

  it("bestGapSplitNum is 1-indexed and tracks position after filtering", () => {
    const paused = { average_speed: 0.05, distance: 800 };
    // After filtering: valid split 1 = s1, valid split 2 = s2
    const s1 = { average_speed: 3.0, average_grade_adjusted_speed: 3.0, distance: 1609 };
    const s2 = { average_speed: 4.0, average_grade_adjusted_speed: 4.0, distance: 1609 };
    const result = processSplitsForMetrics([paused, s1, s2], false);
    expect(result.bestGapSplitNum).toBe(2);
  });
});

// ─── computeAerobicEfficiency ─────────────────────────────────────────────────

describe("computeAerobicEfficiency", () => {
  it("returns all nulls when HR is null", () => {
    const result = computeAerobicEfficiency(null, 3.0, 3.0);
    expect(result.rawEff).toBeNull();
    expect(result.gaEff).toBeNull();
    expect(result.storedEff).toBeNull();
    expect(result.efficiencyLine).toBeNull();
  });

  it("returns all nulls when both speeds are null", () => {
    const result = computeAerobicEfficiency(150, null, null);
    expect(result.rawEff).toBeNull();
    expect(result.gaEff).toBeNull();
    expect(result.storedEff).toBeNull();
    expect(result.efficiencyLine).toBeNull();
  });

  it("computes raw efficiency when only avgSpeedMs is available", () => {
    // 3.0 m/s, 150 bpm → 3.0 / 150 * 60 = 1.2 m/beat
    const result = computeAerobicEfficiency(150, 3.0, null);
    expect(result.rawEff).toBeCloseTo(1.2, 5);
    expect(result.gaEff).toBeNull();
    expect(result.storedEff).toBeCloseTo(1.2, 5);
    expect(result.efficiencyLine).toBe("Aerobic eff: 1.20 m/beat");
    expect(result.efficiencyLine).not.toContain("(GA)");
  });

  it("prefers GA speed over raw speed when both are available", () => {
    // avgSpeed = 3.0, gaSpeed = 3.5, hr = 150
    // rawEff = 3.0/150*60 = 1.2, gaEff = 3.5/150*60 = 1.4
    const result = computeAerobicEfficiency(150, 3.0, 3.5);
    expect(result.rawEff).toBeCloseTo(1.2, 5);
    expect(result.gaEff).toBeCloseTo(1.4, 5);
    expect(result.storedEff).toBeCloseTo(1.4, 5); // GA wins
    expect(result.efficiencyLine).toContain("(GA)");
    expect(result.efficiencyLine).toContain("1.40 m/beat");
  });

  it("storedEff falls back to rawEff when gaEff is null", () => {
    const result = computeAerobicEfficiency(150, 3.0, null);
    expect(result.storedEff).toBeCloseTo(1.2, 5);
  });
});

// ─── computeCardiacDecoupling ─────────────────────────────────────────────────

describe("computeCardiacDecoupling", () => {
  function makeSplit(speed: number, gas: number, hr: number): SplitMetrics {
    return { speed, gas, hr };
  }

  it("returns nulls for fewer than 4 splits", () => {
    expect(computeCardiacDecoupling([])).toEqual({ decouplingPct: null, decouplingLine: null });
    expect(computeCardiacDecoupling([makeSplit(3, 3, 150)])).toEqual({ decouplingPct: null, decouplingLine: null });
    const three = [makeSplit(3, 3, 150), makeSplit(3, 3, 150), makeSplit(3, 3, 150)];
    expect(computeCardiacDecoupling(three)).toEqual({ decouplingPct: null, decouplingLine: null });
  });

  it("returns nulls when no HR data present in splits", () => {
    const splits: SplitMetrics[] = [
      { speed: 3.0, gas: 3.0, hr: null },
      { speed: 3.0, gas: 3.0, hr: null },
      { speed: 3.0, gas: 3.0, hr: null },
      { speed: 3.0, gas: 3.0, hr: null },
    ];
    const result = computeCardiacDecoupling(splits);
    expect(result.decouplingPct).toBeNull();
    expect(result.decouplingLine).toBeNull();
  });

  it("returns nulls when no GA speed data present in splits", () => {
    const splits: SplitMetrics[] = [
      { speed: 3.0, gas: null, hr: 150 },
      { speed: 3.0, gas: null, hr: 150 },
      { speed: 3.0, gas: null, hr: 150 },
      { speed: 3.0, gas: null, hr: 150 },
    ];
    const result = computeCardiacDecoupling(splits);
    expect(result.decouplingPct).toBeNull();
  });

  it("labels <5% drift as 'aerobic system held steady'", () => {
    // First half EF = 3.0/150 = 0.02, second half EF = 3.09/150 = 0.0206
    // Diff ≈ 3% — well within "held steady"
    const splits: SplitMetrics[] = [
      makeSplit(3.0, 3.0, 150),
      makeSplit(3.0, 3.0, 150),
      makeSplit(3.09, 3.09, 150),
      makeSplit(3.09, 3.09, 150),
    ];
    const result = computeCardiacDecoupling(splits);
    expect(result.decouplingLine).toContain("aerobic system held steady");
    expect(result.decouplingPct).toBeLessThan(5);
  });

  it("labels 5–10% drift as 'moderate drift'", () => {
    // EF1 = 3.0/150 = 0.02, EF2 = 3.0/160 = 0.01875 → drift ≈ 6.25%
    const splits: SplitMetrics[] = [
      makeSplit(3.0, 3.0, 150),
      makeSplit(3.0, 3.0, 150),
      makeSplit(3.0, 3.0, 160),
      makeSplit(3.0, 3.0, 160),
    ];
    const result = computeCardiacDecoupling(splits);
    expect(result.decouplingLine).toContain("moderate drift");
    expect(result.decouplingPct).toBeGreaterThanOrEqual(5);
    expect(result.decouplingPct).toBeLessThan(10);
  });

  it("labels >10% drift as 'high drift'", () => {
    // EF1 = 3.0/140 ≈ 0.0214, EF2 = 3.0/165 ≈ 0.0182 → drift ≈ 15%
    const splits: SplitMetrics[] = [
      makeSplit(3.0, 3.0, 140),
      makeSplit(3.0, 3.0, 140),
      makeSplit(3.0, 3.0, 165),
      makeSplit(3.0, 3.0, 165),
    ];
    const result = computeCardiacDecoupling(splits);
    expect(result.decouplingLine).toContain("high drift");
    expect(result.decouplingPct).toBeGreaterThanOrEqual(10);
  });

  it("formats decoupling percentage to 1 decimal place", () => {
    const splits: SplitMetrics[] = [
      makeSplit(3.0, 3.0, 150),
      makeSplit(3.0, 3.0, 150),
      makeSplit(3.0, 3.0, 160),
      makeSplit(3.0, 3.0, 160),
    ];
    const result = computeCardiacDecoupling(splits);
    expect(result.decouplingLine).toMatch(/\d+\.\d%/);
  });

  it("uses only splits that have both GA speed and HR", () => {
    // Mix of splits with and without HR/GA — only fully-qualified ones contribute
    const splits: SplitMetrics[] = [
      makeSplit(3.0, 3.0, 150),  // valid
      { speed: 3.0, gas: null, hr: 150 },  // no GA — excluded
      makeSplit(3.0, 3.0, 150),  // valid
      { speed: 3.0, gas: 3.0, hr: null },  // no HR — excluded
      makeSplit(3.0, 3.0, 165),  // valid
      makeSplit(3.0, 3.0, 165),  // valid
    ];
    // With 4 fully-valid splits, drift should be computable
    const result = computeCardiacDecoupling(splits);
    expect(result.decouplingPct).not.toBeNull();
  });
});

// ─── formatBestGapLine ────────────────────────────────────────────────────────

describe("formatBestGapLine", () => {
  it("returns null when bestGas is null", () => {
    expect(formatBestGapLine(null, 1, false)).toBeNull();
  });

  it("returns null when bestGapSplitNum is null", () => {
    expect(formatBestGapLine(3.0, null, false)).toBeNull();
  });

  it("formats correctly in imperial", () => {
    // 3.35 m/s → 1609.34 / 3.35 = 480.4s → 8:00/mi
    const line = formatBestGapLine(3.35, 3, false);
    expect(line).not.toBeNull();
    expect(line).toContain("/mi");
    expect(line).toContain("mi 3");
    expect(line).toContain("Best GAP:");
    expect(line).not.toContain("/km");
  });

  it("formats correctly in metric", () => {
    // 3.0 m/s → 1000 / 3.0 = 333.3s → 5:33/km
    const line = formatBestGapLine(3.0, 2, true);
    expect(line).not.toBeNull();
    expect(line).toContain("/km");
    expect(line).toContain("km 2");
    expect(line).not.toContain("/mi");
  });

  it("pads seconds to 2 digits", () => {
    // 3.5 m/s → 1609.34 / 3.5 = 459.8s → 7:40/mi (seconds ≥ 10, no padding needed)
    // Use a speed that gives single-digit seconds: 1609.34 / (1609.34/484) = 484s → 8:04/mi
    const mps = 1609.34 / 484; // exactly 484 s/mi = 8:04
    const line = formatBestGapLine(mps, 1, false);
    expect(line).toContain("8:04/mi");
  });
});
