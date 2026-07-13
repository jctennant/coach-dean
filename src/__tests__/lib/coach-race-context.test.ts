import { describe, it, expect } from "vitest";
import { buildRaceContext, type UpcomingRaceInput } from "@/lib/coach-race-context";

const NOW = new Date("2026-07-12T15:00:00Z"); // Sunday, July 12, 2026

function base(overrides: Partial<Parameters<typeof buildRaceContext>[0]> = {}) {
  return buildRaceContext({
    now: NOW,
    raceDate: null,
    goal: null,
    profileRaceDaysUntil: null,
    avgWeeklyMileage: null,
    storedTaperPeakMiles: null,
    upcomingRaces: null,
    onboardingRaceName: null,
    isMetric: false,
    ...overrides,
  });
}

describe("buildRaceContext — race countdown / taper protocol", () => {
  it("returns empty text when there's no race date", () => {
    expect(base()).toBe("");
  });

  it("states the race countdown even outside the 21-day taper window", () => {
    const text = base({ raceDate: "2026-09-01", goal: "marathon", profileRaceDaysUntil: 51, avgWeeklyMileage: 30 });
    expect(text).toContain("- Race date: 2026-09-01 (51 days / ~7 weeks away)");
    expect(text).toContain("Plan backwards from race date");
    expect(text).not.toContain("TAPER PROTOCOL");
  });

  it("does not compute a taper without a stored or live avgWeeklyMileage", () => {
    const text = base({ raceDate: "2026-07-22", goal: "marathon", profileRaceDaysUntil: 10, avgWeeklyMileage: null });
    expect(text).not.toContain("TAPER PROTOCOL");
  });

  it("marathon taper: 3+ weeks-out tier (>14 days) uses 88/72/25 pct off peak", () => {
    const text = base({ raceDate: "2026-08-02", goal: "marathon", profileRaceDaysUntil: 21, avgWeeklyMileage: 40 });
    // peak = 40, w3 = round(40*0.88)=35, w2 = round(40*0.72)=29, w1 = round(40*0.25)=10
    expect(text).toContain("Peak volume ~40.0 mi. This week (3 weeks out): 35.0 mi total. Next week (2 weeks out): 29.0 mi total. Race week: 10.0 mi total");
    expect(text).toContain("allowed 10-12 days out");
  });

  it("marathon taper: 8-14 days tier uses the 2-weeks-out framing", () => {
    const text = base({ raceDate: "2026-07-22", goal: "marathon", profileRaceDaysUntil: 10, avgWeeklyMileage: 40 });
    expect(text).toContain("Peak volume ~40.0 mi. This week (2 weeks out): 29.0 mi total. Race week: 10.0 mi total");
    expect(text).toContain("is acceptable this week");
  });

  it("marathon taper: race-week tier (<=7 days) is easy-only with an optional shakeout", () => {
    const text = base({ raceDate: "2026-07-15", goal: "marathon", profileRaceDaysUntil: 3, avgWeeklyMileage: 40 });
    expect(text).toContain("Peak volume ~40.0 mi. Race week: 10.0 mi total. Easy miles only");
    expect(text).toContain("Shakeout run");
  });

  it("uses the stored taper_peak_miles instead of live avgWeeklyMileage once locked in", () => {
    const text = base({ raceDate: "2026-07-22", goal: "marathon", profileRaceDaysUntil: 10, avgWeeklyMileage: 55, storedTaperPeakMiles: 40 });
    expect(text).toContain("Peak volume ~40.0 mi"); // not 55
  });

  it("ultra taper uses 78/62/25 pct, distinct from marathon's 88/72/25", () => {
    const text = base({ raceDate: "2026-08-02", goal: "50k", profileRaceDaysUntil: 21, avgWeeklyMileage: 50 });
    // w3 = round(50*0.78)=39, w2 = round(50*0.62)=31, w1 = round(50*0.25)=13
    expect(text).toContain("Peak volume ~50.0 mi. This week (3 weeks out): 39.0 mi total. Next week (2 weeks out): 31.0 mi total. Race week: 13.0 mi total");
  });

  it("30k gets marathon-style taper, not short-race defaults", () => {
    const text = base({ raceDate: "2026-08-02", goal: "30k", profileRaceDaysUntil: 21, avgWeeklyMileage: 40 });
    expect(text).toContain("This week (3 weeks out): 35.0 mi total. Next week (2 weeks out): 29.0 mi total. Race week: 10.0 mi total");
  });

  it("half marathon uses 90/75/28 pct", () => {
    const text = base({ raceDate: "2026-08-02", goal: "half_marathon", profileRaceDaysUntil: 21, avgWeeklyMileage: 40 });
    // w3 = round(40*0.90)=36, w2 = round(40*0.75)=30, w1 = round(40*0.28)=11
    expect(text).toContain("This week (3 weeks out): 36.0 mi total. Next week (2 weeks out): 30.0 mi total. Race week: 11.0 mi total");
  });

  it("5k/10k (default bucket) uses 90/78/35 pct", () => {
    const text = base({ raceDate: "2026-08-02", goal: "10k", profileRaceDaysUntil: 21, avgWeeklyMileage: 40 });
    // w3 = round(40*0.90)=36, w2 = round(40*0.78)=31, w1 = round(40*0.35)=14
    expect(text).toContain("This week (3 weeks out): 36.0 mi total. Next week (2 weeks out): 31.0 mi total. Race week: 14.0 mi total");
  });

  it("mile: no sharpening note 8-21 days out, only within 7 days", () => {
    const far = base({ raceDate: "2026-07-30", goal: "mile", profileRaceDaysUntil: 18, avgWeeklyMileage: 30 });
    expect(far).not.toContain("MILE SHARPENING WEEK");
    expect(far).not.toContain("TAPER PROTOCOL");

    const close = base({ raceDate: "2026-07-17", goal: "mile", profileRaceDaysUntil: 5, avgWeeklyMileage: 30 });
    expect(close).toContain("MILE SHARPENING WEEK: Time trial is 5 days away");
  });

  it("formats in km when isMetric is true", () => {
    const text = base({ raceDate: "2026-07-22", goal: "marathon", profileRaceDaysUntil: 10, avgWeeklyMileage: 40, isMetric: true });
    expect(text).toContain("Peak volume ~64.4 km"); // 40 * 1.60934
    expect(text).not.toMatch(/\d+(\.\d+)?\s*mi\b/); // no imperial distance figures anywhere
  });
});

describe("buildRaceContext — B/C race context", () => {
  it("labels a close B race as a tune-up with volume reduction guidance", () => {
    const races: UpcomingRaceInput[] = [{ priority: "B", race_date: "2026-07-20", race_name: "Prep 10-Miler", goal: null }];
    const text = base({ upcomingRaces: races });
    expect(text).toContain("B RACE (tune-up): Prep 10-Miler on 2026-07-20 (8 days away)");
    expect(text).toContain("Reduce total volume 10-15%");
  });

  it("labels a distant B race with the lighter 'upcoming' framing", () => {
    const races: UpcomingRaceInput[] = [{ priority: "B", race_date: "2026-08-20", race_name: "Prep 10-Miler", goal: null }];
    const text = base({ upcomingRaces: races });
    expect(text).toContain("Upcoming B race (tune-up): Prep 10-Miler on 2026-08-20");
    expect(text).not.toContain("B RACE (tune-up):");
  });

  it("labels a close C race as a workout day, not a taper", () => {
    const races: UpcomingRaceInput[] = [{ priority: "C", race_date: "2026-07-17", race_name: "Turkey Trot", goal: null }];
    const text = base({ upcomingRaces: races });
    expect(text).toContain("C RACE (for-fun): Turkey Trot on 2026-07-17 (5 days away). No taper");
  });

  it("falls back to a formatted goal label when the race has no name", () => {
    const races: UpcomingRaceInput[] = [{ priority: "C", race_date: "2026-07-13", race_name: null, goal: "10k" }];
    const text = base({ upcomingRaces: races });
    expect(text).toContain("C RACE (for-fun): a 10K on 2026-07-13");
  });

  it("ignores A-priority races entirely (handled by the main taper section, not here)", () => {
    const races: UpcomingRaceInput[] = [{ priority: "A", race_date: "2026-07-20", race_name: "Goal Marathon", goal: null }];
    const text = base({ upcomingRaces: races });
    expect(text).toBe("");
  });
});

describe("buildRaceContext — post-race recovery", () => {
  it("gives week-1 guidance for a race within the last 7 days", () => {
    const text = base({ raceDate: "2026-07-08", goal: "marathon", profileRaceDaysUntil: -4, onboardingRaceName: "City Marathon" });
    expect(text).toContain("POST-RACE CONTEXT:");
    expect(text).toContain("City Marathon on 2026-07-08 (4 days ago)");
    expect(text).toContain("Week 1 post-race: easy running only");
  });

  it("gives week-2 guidance for 8-14 days post-race", () => {
    const text = base({ raceDate: "2026-07-01", goal: "marathon", profileRaceDaysUntil: -11 });
    expect(text).toContain("Week 2 post-race: reduced volume");
  });

  it("gives weeks-3-6 guidance beyond 14 days post-race, up to 42", () => {
    const text = base({ raceDate: "2026-06-01", goal: "marathon", profileRaceDaysUntil: -41 });
    expect(text).toContain("Weeks 3–6 post-race: fairly normal training");
  });

  it("stops firing beyond 6 weeks post-race", () => {
    const text = base({ raceDate: "2026-05-01", goal: "marathon", profileRaceDaysUntil: -43 });
    expect(text).not.toContain("POST-RACE CONTEXT");
  });

  it("falls back to a formatted goal label when there's no onboarding race name", () => {
    const text = base({ raceDate: "2026-07-08", goal: "half_marathon", profileRaceDaysUntil: -4, onboardingRaceName: null });
    expect(text).toContain("completed their goal race — a half marathon on 2026-07-08");
  });
});
