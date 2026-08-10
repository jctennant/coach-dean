import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computePhase, buildPeriodization } from "@/lib/periodization";

// Helper: date string N weeks from now
function weeksFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n * 7);
  return d.toISOString().slice(0, 10);
}

describe("computePhase — no race date", () => {
  it("returns base for weeks 1–6", () => {
    for (let w = 1; w <= 6; w++) {
      expect(computePhase(w, null)).toBe("base");
    }
  });

  it("returns build for weeks 7–12", () => {
    for (let w = 7; w <= 12; w++) {
      expect(computePhase(w, null)).toBe("build");
    }
  });

  it("cycles back to base on week 13", () => {
    expect(computePhase(13, null)).toBe("base");
  });

  it("cycles back to build on week 19", () => {
    expect(computePhase(19, null)).toBe("build");
  });
});

describe("computePhase — with race date", () => {
  it("returns taper when ≤2 weeks out", () => {
    expect(computePhase(5, weeksFromNow(1))).toBe("taper");
    expect(computePhase(5, weeksFromNow(2))).toBe("taper");
  });

  it("returns peak when 3–7 weeks out", () => {
    expect(computePhase(5, weeksFromNow(3))).toBe("peak");
    expect(computePhase(5, weeksFromNow(7))).toBe("peak");
  });

  it("returns build when 8–14 weeks out", () => {
    expect(computePhase(5, weeksFromNow(8))).toBe("build");
    expect(computePhase(5, weeksFromNow(14))).toBe("build");
  });

  it("returns base when >14 weeks out", () => {
    expect(computePhase(5, weeksFromNow(15))).toBe("base");
    expect(computePhase(5, weeksFromNow(30))).toBe("base");
  });
});

describe("buildPeriodization — effectiveWeek", () => {
  it("resets to week 1 for initial_plan regardless of stored week", () => {
    const p = buildPeriodization("initial_plan", 8, null, null);
    expect(p.effectiveWeek).toBe(1);
  });

  it("increments by 1 for weekly_recap when there's nothing to anchor to", () => {
    // No race date and/or no plan length — the calendar can't say which week this is.
    const p = buildPeriodization("weekly_recap", 3, null, null);
    expect(p.effectiveWeek).toBe(4);
    expect(buildPeriodization("weekly_recap", 3, "2026-09-30", null, { totalWeeks: null }).effectiveWeek).toBe(4);
  });

  it("defaults stored week to 1 when null for weekly_recap", () => {
    const p = buildPeriodization("weekly_recap", null, null, null);
    expect(p.effectiveWeek).toBe(2);
  });

  describe("with a race date and a plan length, the recap week comes from the calendar", () => {
    // 4-week plan, race Friday 2026-08-28, recap firing Sunday evening 2026-08-09.
    const RACE = "2026-08-28";
    const sundayEvening = new Date("2026-08-10T02:47:00Z");

    it("is idempotent — running the recap twice does not age the plan", () => {
      // The bug this replaced: effectiveWeek was storedWeek + 1, so two recaps 90 minutes
      // apart moved an athlete from week 2 to week 4 and dropped him onto race-week volume
      // (6 mi, a 2 mi long run) eighteen days out (2026-08-09).
      for (const stored of [1, 2, 3, 4]) {
        const p = buildPeriodization("weekly_recap", stored, RACE, 20, { totalWeeks: 4, now: sundayEvening });
        expect(p.effectiveWeek, `stored ${stored}`).toBe(2);
      }
    });

    it("advances one week per calendar week", () => {
      const at = (iso: string) =>
        buildPeriodization("weekly_recap", 2, RACE, 20, { totalWeeks: 4, now: new Date(iso) }).effectiveWeek;
      expect(at("2026-08-10T02:47:00Z")).toBe(2); // planning Aug 10–16
      expect(at("2026-08-16T23:00:00Z")).toBe(3); // planning Aug 17–23
      expect(at("2026-08-23T23:00:00Z")).toBe(4); // planning race week
    });

    it("self-corrects a stored week that drifted, in either direction", () => {
      expect(buildPeriodization("weekly_recap", 1, RACE, 20, { totalWeeks: 4, now: sundayEvening }).effectiveWeek).toBe(2);
      expect(buildPeriodization("weekly_recap", 9, RACE, 20, { totalWeeks: 4, now: sundayEvening }).effectiveWeek).toBe(2);
    });

    it("never runs off either end of the plan", () => {
      const farOut = buildPeriodization("weekly_recap", 1, "2027-01-01", 20, { totalWeeks: 4, now: sundayEvening });
      expect(farOut.effectiveWeek).toBe(1);
      const raceWeek = buildPeriodization("weekly_recap", 1, "2026-08-12", 20, { totalWeeks: 4, now: sundayEvening });
      expect(raceWeek.effectiveWeek).toBe(4);
    });

    it("falls back to incrementing once the race has passed", () => {
      const p = buildPeriodization("weekly_recap", 3, "2026-08-01", 20, { totalWeeks: 4, now: sundayEvening });
      expect(p.effectiveWeek).toBe(4);
    });
  });

  it("uses stored week as-is for other triggers", () => {
    const p = buildPeriodization("post_run", 5, null, null);
    expect(p.effectiveWeek).toBe(5);
  });
});

describe("buildPeriodization — deload logic", () => {
  it("marks week 4 as a deload week", () => {
    const p = buildPeriodization("weekly_recap", 3, null, 30);
    expect(p.effectiveWeek).toBe(4);
    expect(p.isDeloadWeek).toBe(true);
  });

  it("marks week 8 as a deload week", () => {
    const p = buildPeriodization("weekly_recap", 7, null, 30);
    expect(p.effectiveWeek).toBe(8);
    expect(p.isDeloadWeek).toBe(true);
  });

  it("does NOT mark non-multiples-of-4 as deload", () => {
    for (const stored of [1, 2, 4, 5, 6, 8, 9, 10]) {
      const p = buildPeriodization("weekly_recap", stored, null, 30);
      if (p.effectiveWeek % 4 !== 0) {
        expect(p.isDeloadWeek).toBe(false);
      }
    }
  });

  it("does NOT trigger deload during taper phase", () => {
    // week 4 but race is 2 weeks away → taper phase
    const p = buildPeriodization("weekly_recap", 3, weeksFromNow(2), 30);
    expect(p.effectiveWeek).toBe(4);
    expect(p.isDeloadWeek).toBe(false);
  });

  it("does NOT trigger deload during peak phase", () => {
    // week 4 (multiple of 4) but race is 5 weeks away → peak phase
    const p = buildPeriodization("weekly_recap", 3, weeksFromNow(5), 30);
    expect(p.effectiveWeek).toBe(4);
    expect(p.phase).toBe("peak");
    expect(p.isDeloadWeek).toBe(false);
  });
});

describe("buildPeriodization — suggestedWeeklyMiles", () => {
  it("returns null when no mileage data", () => {
    const p = buildPeriodization("weekly_recap", 2, null, null);
    expect(p.suggestedWeeklyMiles).toBeNull();
  });

  it("returns null during taper phase", () => {
    const p = buildPeriodization("weekly_recap", 2, weeksFromNow(2), 30);
    expect(p.suggestedWeeklyMiles).toBeNull();
  });

  it("reduces by ~30% on deload week", () => {
    const p = buildPeriodization("weekly_recap", 3, null, 30); // week 4 = deload
    expect(p.isDeloadWeek).toBe(true);
    // 30 * 0.70 = 21, rounded to nearest 0.5
    expect(p.suggestedWeeklyMiles).toBe(21);
  });

  it("increases by ~8% in base/build phases", () => {
    const p = buildPeriodization("weekly_recap", 1, null, 30); // week 2 = base
    expect(p.isDeloadWeek).toBe(false);
    // 30 * 1.08 = 32.4, rounded to nearest 0.5 = 32.5
    expect(p.suggestedWeeklyMiles).toBe(32.5);
  });

  it("increases by ~5% in peak phase", () => {
    const p = buildPeriodization("weekly_recap", 1, weeksFromNow(5), 30); // 5 weeks out = peak
    expect(p.phase).toBe("peak");
    expect(p.isDeloadWeek).toBe(false);
    // 30 * 1.05 = 31.5
    expect(p.suggestedWeeklyMiles).toBe(31.5);
  });
});
