import { describe, it, expect } from "vitest";
import { parseSessionMiles, recomputeWeekTotalsFromSessions, parseStoredSessionDate } from "@/lib/session-mileage";

describe("parseSessionMiles", () => {
  it("parses a bare mileage figure", () => {
    expect(parseSessionMiles("Easy 5mi")).toBe(5);
  });

  it("prefers an explicit '≈X mi total' marker over the first bare figure", () => {
    expect(parseSessionMiles("Easy 5mi + strides ≈6mi total")).toBe(6);
  });

  it("prefers a parenthesized '(X mi total)' marker over the first bare figure", () => {
    expect(parseSessionMiles("Warm-up 1mi, 6x800m, cooldown 1mi (7mi total)")).toBe(7);
  });

  it("handles a '~X mi' marker", () => {
    expect(parseSessionMiles("Long run ~12mi")).toBe(12);
  });

  it("handles decimal mileage", () => {
    expect(parseSessionMiles("Tempo 6.5mi")).toBe(6.5);
  });

  it("falls back to km, converted to miles, when there's no mi marker", () => {
    expect(parseSessionMiles("Easy 8km")).toBeCloseTo(4.97, 2);
  });

  it("prefers an explicit '≈X km total' marker over the first bare km figure", () => {
    expect(parseSessionMiles("Easy 8km + strides ≈10km total")).toBeCloseTo(6.21, 2);
  });

  it("returns 0 for a session with no distance marker at all (e.g. rest, strength)", () => {
    expect(parseSessionMiles("Rest")).toBe(0);
    expect(parseSessionMiles("Strength — full body")).toBe(0);
  });

  it("does not misread '35 min' as 35 miles — the (?!n) guard", () => {
    expect(parseSessionMiles("Strength circuit, 35 min")).toBe(0);
  });

  it("does not misread 'min' inside an explicit-total marker as mileage", () => {
    expect(parseSessionMiles("Mobility work (35 min total)")).toBe(0);
  });
});

describe("recomputeWeekTotalsFromSessions", () => {
  const week = [
    { day: "Mon", date: "8/10", label: "Fartlek 6mi (varied 2-3 min pickups)", type: "run" },
    { day: "Tue", date: "8/11", label: "Strength + mobility", type: "strength" },
    { day: "Wed", date: "8/12", label: "Easy 3mi", type: "run" },
    { day: "Fri", date: "8/14", label: "Bike", type: "cross_train" },
    { day: "Sat", date: "8/15", label: "Long run 7mi", type: "run" },
  ];

  it("sums the running sessions and reports the longest as the long run", () => {
    expect(recomputeWeekTotalsFromSessions(week)).toEqual({ totalMiles: 16, longRunMiles: 7 });
  });

  it("follows a swap that changes a session's distance", () => {
    const swapped = week.map(s => s.day === "Wed" ? { ...s, label: "Long run 9mi" } : s);
    expect(recomputeWeekTotalsFromSessions(swapped)).toEqual({ totalMiles: 22, longRunMiles: 9 });
  });

  it("ignores cross-training and strength slots", () => {
    const ctHeavy = [
      { day: "Mon", date: "8/10", label: "Easy 4mi", type: "run" },
      { day: "Tue", date: "8/11", label: "Bike 20mi", type: "cross_train" },
      { day: "Wed", date: "8/12", label: "Strength + mobility", type: "strength" },
    ];
    expect(recomputeWeekTotalsFromSessions(ctHeavy)).toEqual({ totalMiles: 4, longRunMiles: 4 });
  });

  it("returns nulls when nothing in the week carries a distance", () => {
    expect(recomputeWeekTotalsFromSessions([{ day: "Mon", date: "8/10", label: "Rest" }]))
      .toEqual({ totalMiles: null, longRunMiles: null });
    expect(recomputeWeekTotalsFromSessions([])).toEqual({ totalMiles: null, longRunMiles: null });
  });

  it("counts an untyped session (swap inserts carry no type) as a run", () => {
    expect(recomputeWeekTotalsFromSessions([{ day: "Sun", date: "8/16", label: "Easy 5mi" }]))
      .toEqual({ totalMiles: 5, longRunMiles: 5 });
  });
});

describe("parseStoredSessionDate", () => {
  const AUG_9 = Date.UTC(2026, 7, 9, 12);

  it("parses the M/D format the skeleton writes", () => {
    const d = parseStoredSessionDate("8/15", AUG_9)!;
    expect(d.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("still parses legacy ISO rows written by the old swap-insert path", () => {
    const d = parseStoredSessionDate("2026-08-15", AUG_9)!;
    expect(d.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("resolves a January session against a late-December reference as next year", () => {
    const d = parseStoredSessionDate("1/2", Date.UTC(2026, 11, 30, 12))!;
    expect(d.toISOString().slice(0, 10)).toBe("2027-01-02");
  });

  it("resolves a December session against an early-January reference as last year", () => {
    const d = parseStoredSessionDate("12/30", Date.UTC(2027, 0, 2, 12))!;
    expect(d.toISOString().slice(0, 10)).toBe("2026-12-30");
  });

  it("returns null for anything it can't parse", () => {
    expect(parseStoredSessionDate("Saturday", AUG_9)).toBeNull();
    expect(parseStoredSessionDate("13/40", AUG_9)).toBeNull();
    expect(parseStoredSessionDate("", AUG_9)).toBeNull();
  });
});
