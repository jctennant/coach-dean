import { describe, it, expect } from "vitest";
import { buildSplitAnalysis } from "@/app/api/coach/respond/route";

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
