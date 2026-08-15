import { describe, it, expect } from "vitest";
import { computePainTrend, buildPainTrendBlock, type PainCheckin } from "@/lib/pain-trend";

describe("computePainTrend", () => {
  it("returns an empty trend for no entries", () => {
    expect(computePainTrend([])).toEqual({ entries: [], latest: null, direction: null, lowPainStreak: 0 });
  });

  it("sorts unordered entries chronologically and reports the latest value", () => {
    const rows: PainCheckin[] = [
      { date: "2026-08-12", pain_level: 3 },
      { date: "2026-08-10", pain_level: 5 },
      { date: "2026-08-14", pain_level: 2 },
    ];
    const trend = computePainTrend(rows);
    expect(trend.entries.map((e) => e.date)).toEqual(["2026-08-10", "2026-08-12", "2026-08-14"]);
    expect(trend.latest).toBe(2);
  });

  it("marks direction as improving when latest is at least 1 point below the first reading", () => {
    const rows: PainCheckin[] = [
      { date: "2026-08-10", pain_level: 5 },
      { date: "2026-08-12", pain_level: 3 },
      { date: "2026-08-14", pain_level: 1 },
    ];
    expect(computePainTrend(rows).direction).toBe("improving");
  });

  it("marks direction as worsening when latest is at least 1 point above the first reading", () => {
    const rows: PainCheckin[] = [
      { date: "2026-08-10", pain_level: 1 },
      { date: "2026-08-14", pain_level: 4 },
    ];
    expect(computePainTrend(rows).direction).toBe("worsening");
  });

  it("marks direction as flat when the latest reading is within 1 point of the first", () => {
    const rows: PainCheckin[] = [
      { date: "2026-08-10", pain_level: 2 },
      { date: "2026-08-14", pain_level: 2 },
    ];
    expect(computePainTrend(rows).direction).toBe("flat");
  });

  it("returns null direction with only one entry", () => {
    expect(computePainTrend([{ date: "2026-08-14", pain_level: 2 }]).direction).toBeNull();
  });

  it("counts a trailing low-pain streak, stopping at the first higher reading going backward", () => {
    const rows: PainCheckin[] = [
      { date: "2026-08-10", pain_level: 4 },
      { date: "2026-08-11", pain_level: 3 },
      { date: "2026-08-12", pain_level: 1 },
      { date: "2026-08-13", pain_level: 0 },
      { date: "2026-08-14", pain_level: 1 },
    ];
    expect(computePainTrend(rows).lowPainStreak).toBe(3);
  });

  it("keeps only the most recent 14 entries", () => {
    const rows: PainCheckin[] = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      pain_level: 2,
    }));
    expect(computePainTrend(rows).entries).toHaveLength(14);
    expect(computePainTrend(rows).entries[0].date).toBe("2026-08-07");
  });
});

describe("buildPainTrendBlock", () => {
  it("returns empty string when there's no history", () => {
    expect(buildPainTrendBlock(computePainTrend([]), "some test")).toBe("");
  });

  it("includes the real numbers and trend direction without a progression gate below streak threshold", () => {
    const trend = computePainTrend([
      { date: "2026-08-10", pain_level: 4 },
      { date: "2026-08-14", pain_level: 2 },
    ]);
    const block = buildPainTrendBlock(trend, "single-leg hop test");
    expect(block).toContain("2026-08-10: 4/10");
    expect(block).toContain("2026-08-14: 2/10");
    expect(block).toContain("improving");
    expect(block).not.toContain("PROGRESSION GATE MET");
  });

  it("fires the progression gate with the functional test once low-pain streak reaches 3", () => {
    const trend = computePainTrend([
      { date: "2026-08-12", pain_level: 1 },
      { date: "2026-08-13", pain_level: 0 },
      { date: "2026-08-14", pain_level: 1 },
    ]);
    const block = buildPainTrendBlock(trend, "single-leg hop test");
    expect(block).toContain("PROGRESSION GATE MET");
    expect(block).toContain("single-leg hop test");
  });

  it("does not fire the progression gate when no functional test is available for the body part", () => {
    const trend = computePainTrend([
      { date: "2026-08-12", pain_level: 0 },
      { date: "2026-08-13", pain_level: 0 },
      { date: "2026-08-14", pain_level: 0 },
    ]);
    const block = buildPainTrendBlock(trend, null);
    expect(block).not.toContain("PROGRESSION GATE MET");
  });
});
