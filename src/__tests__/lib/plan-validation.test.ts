import { describe, it, expect } from "vitest";
import {
  parseSessionLines,
  enforceVolumeCaps,
  deduplicateSessionLines,
  fixSessionDistanceErrors,
  fixSessionDayAbbreviations,
  countRunningSessions,
  applyStructuredWeeklyTotal,
  applyStructuredLongRun,
  computeWeekOneVolumeCap,
  computeLongRunCap,
  parsePaceStrToSecPerMile,
  reconcilePlanComponents,
} from "@/lib/plan-validation";

// ---------------------------------------------------------------------------
// parseSessionLines
// ---------------------------------------------------------------------------

describe("parseSessionLines", () => {
  it("extracts running sessions with mileage", () => {
    const msg = `Here's your plan:
Tue 3/24 · Easy 4mi + Strength
Wed 3/25 · HIIT class
Thu 3/26 · Easy 5mi
Sat 3/28 · Long run 9mi
Total: 18 mi.`;
    const sessions = parseSessionLines(msg);
    expect(sessions).toHaveLength(4);
    expect(sessions[0]).toMatchObject({ miles: 4, desc: "Easy 4mi + Strength" });
    expect(sessions[1]).toMatchObject({ miles: 0, desc: "HIIT class" }); // no mi marker
    expect(sessions[2]).toMatchObject({ miles: 5, desc: "Easy 5mi" });
    expect(sessions[3]).toMatchObject({ miles: 9, desc: "Long run 9mi" });
  });

  it("returns empty array when no session lines present", () => {
    expect(parseSessionLines("Just chatting, no plan here.")).toHaveLength(0);
  });

  it("handles decimal mileage", () => {
    const msg = "Mon 3/3 · Easy 3.5mi @ 10:00/mi";
    const [s] = parseSessionLines(msg);
    expect(s.miles).toBe(3.5);
  });
});

// ---------------------------------------------------------------------------
// enforceVolumeCaps — no violation
// ---------------------------------------------------------------------------

describe("enforceVolumeCaps — no violation", () => {
  it("returns violated=false and original message when total is under cap", () => {
    const msg = `Tue 3/24 · Easy 2mi
Thu 3/26 · Easy 2mi
Sat 3/28 · Long run 3mi
Total: 7 mi.`;
    const result = enforceVolumeCaps(msg, 7, 3);
    expect(result.violated).toBe(false);
    expect(result.message).toBe(msg);
    expect(result.totalMiles).toBeCloseTo(7, 1);
  });

  it("is a no-op when both caps are null", () => {
    const msg = "Mon 3/3 · Easy 20mi\nTotal: 20 mi.";
    const result = enforceVolumeCaps(msg, null, null);
    expect(result.violated).toBe(false);
    expect(result.message).toBe(msg);
  });

  it("allows plan that is right at the cap boundary (±0.4 tolerance)", () => {
    const msg = "Tue 3/4 · Easy 3mi\nThu 3/6 · Easy 4mi\nTotal: 7 mi.";
    const result = enforceVolumeCaps(msg, 7, 4);
    expect(result.violated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enforceVolumeCaps — weekly cap violation (Issue 1 scenario)
// ---------------------------------------------------------------------------

describe("enforceVolumeCaps — weekly cap violation", () => {
  const ISSUE_1_PLAN = `You're at 5 mi/week right now, so we need to build volume carefully first. Week 1 this week is capped at 7 mi to keep you healthy while we ramp.

Here's your updated plan for this week:
Tue 3/24 · Easy 4mi + Strength
Wed 3/25 · HIIT class
Thu 3/26 · Easy 5mi
Sat 3/28 · Long run 9mi
Total: 18 mi. This keeps you at that Week 1 safe cap...`;

  it("detects the violation from Issue 1", () => {
    const result = enforceVolumeCaps(ISSUE_1_PLAN, 7, 3);
    expect(result.violated).toBe(true);
    expect(result.totalMiles).toBeCloseTo(18, 0);
    expect(result.maxSessionMiles).toBeCloseTo(9, 0);
  });

  it("corrects total mileage to be at or below weekly cap", () => {
    const result = enforceVolumeCaps(ISSUE_1_PLAN, 7, 3);
    const sessions = parseSessionLines(result.message);
    const total = sessions.reduce((s, r) => s + r.miles, 0);
    // Floor-rounding guarantees sum never exceeds cap
    expect(total).toBeLessThanOrEqual(7);
  });

  it("caps the long run to longRunCapMiles", () => {
    const result = enforceVolumeCaps(ISSUE_1_PLAN, 7, 3);
    const sessions = parseSessionLines(result.message);
    const maxSession = Math.max(...sessions.map((s) => s.miles));
    expect(maxSession).toBeLessThanOrEqual(3 + 0.01);
  });

  it("rewrites the stated total in the message text", () => {
    const result = enforceVolumeCaps(ISSUE_1_PLAN, 7, 3);
    // "Total: 18 mi" should be gone; new total should appear
    expect(result.message).not.toMatch(/Total:\s*18/);
  });

  it("non-running sessions are unchanged", () => {
    const result = enforceVolumeCaps(ISSUE_1_PLAN, 7, 3);
    expect(result.message).toContain("HIIT class");
    // HIIT should still have no mileage
    const sessions = parseSessionLines(result.message);
    const hiit = sessions.find((s) => s.desc.includes("HIIT"));
    expect(hiit?.miles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// enforceVolumeCaps — only long run violated (weekly total is fine)
// ---------------------------------------------------------------------------

describe("enforceVolumeCaps — only long run violated", () => {
  it("caps single long run without scaling other sessions", () => {
    // Weekly total is 9mi (under 10mi cap), but long run is 7mi (over 3mi cap)
    const msg = `Tue 3/4 · Easy 2mi
Sat 3/8 · Long run 7mi
Total: 9 mi.`;
    const result = enforceVolumeCaps(msg, 10, 3);
    expect(result.violated).toBe(true);
    const sessions = parseSessionLines(result.message);
    const longRun = sessions.find((s) => s.desc.includes("Long run"));
    expect(longRun?.miles).toBeLessThanOrEqual(3);
    // Easy run should be unchanged
    const easy = sessions.find((s) => s.desc.includes("Easy"));
    expect(easy?.miles).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// deduplicateSessionLines — Issue 5
// ---------------------------------------------------------------------------

describe("deduplicateSessionLines", () => {
  it("removes exact duplicate session lines", () => {
    const msg = `Here's your adjusted week:
Thu 3/26 · Easy 2mi @ easy effort
Thu 3/26 · Easy 2mi @ easy effort
Sat 3/28 · Easy 2.5mi @ easy effort`;
    const result = deduplicateSessionLines(msg);
    // Should only have one Thu 3/26 line
    const matches = result.match(/Thu 3\/26/g);
    expect(matches).toHaveLength(1);
    expect(result).toContain("Sat 3/28 · Easy 2.5mi @ easy effort");
  });

  it("preserves unique lines unchanged", () => {
    const msg = `Mon 3/3 · Easy 3mi
Tue 3/4 · Tempo 4mi
Wed 3/5 · Rest`;
    expect(deduplicateSessionLines(msg)).toBe(msg);
  });

  it("keeps first occurrence, removes subsequent duplicates", () => {
    const msg = `Mon 3/3 · Easy 3mi
Mon 3/3 · Easy 3mi
Mon 3/3 · Easy 3mi`;
    const result = deduplicateSessionLines(msg);
    const matches = result.match(/Mon 3\/3/g);
    expect(matches).toHaveLength(1);
  });

  it("does not deduplicate non-session lines even if identical", () => {
    const msg = `Great week ahead!\nGreat week ahead!\nMon 3/3 · Easy 3mi`;
    const result = deduplicateSessionLines(msg);
    // Both non-session lines should be preserved
    expect(result.split("Great week ahead!")).toHaveLength(3);
  });

  it("is a no-op when there are no session lines", () => {
    const msg = "No plan, just chatting.";
    expect(deduplicateSessionLines(msg)).toBe(msg);
  });

  it("handles different sessions on the same day without deduplicating them", () => {
    const msg = `Tue 3/4 · Easy 3mi
Tue 3/4 · Strength 30 min`;
    expect(deduplicateSessionLines(msg)).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// fixSessionDistanceErrors — Issue 3 (hill reps "33mi total" bug)
// ---------------------------------------------------------------------------

describe("fixSessionDistanceErrors", () => {
  const JULIA_PLAN = `Here's your week:
Mon 4/6 · Easy 6mi
Tue 4/7 · Tempo 7mi (1mi WU + 5mi @ 6:45 + 1mi CD)
Thu 4/9 · Hill reps 33mi total (8x90sec uphill @ hard effort, jog down recovery)
Sat 4/11 · Easy 7mi
Sun 4/12 · Long run 13mi
Total: 33mi`;

  it("detects session mileage that matches the weekly total", () => {
    const result = fixSessionDistanceErrors(JULIA_PLAN);
    expect(result).not.toContain("Hill reps 33mi");
    expect(result).toContain("?mi (check distance)");
  });

  it("does not touch legitimate long runs that happen to be large", () => {
    const plan = `Sat 4/11 · Long run 20mi
Total: 35mi`;
    // Long run 20mi with total 35mi — not a copy-paste error
    const result = fixSessionDistanceErrors(plan);
    expect(result).toContain("Long run 20mi");
  });

  it("is a no-op when no session equals the total", () => {
    const msg = `Mon 4/6 · Easy 5mi
Wed 4/8 · Tempo 6mi
Sat 4/11 · Long run 10mi
Total: 21mi`;
    expect(fixSessionDistanceErrors(msg)).toBe(msg);
  });

  it("is a no-op when no Total line is present", () => {
    const msg = `Mon 4/6 · Easy 5mi\nWed 4/8 · Tempo 6mi`;
    expect(fixSessionDistanceErrors(msg)).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// fixSessionDayAbbreviations
// ---------------------------------------------------------------------------

describe("fixSessionDayAbbreviations", () => {
  // April 2026: refYear=2026, refMonth=4
  // April 7, 2026 is a Tuesday. April 14 is a Monday. April 21 is a Tuesday.

  it("is a no-op when all day abbreviations are correct", () => {
    // Tue 4/7/2026 ✓, Thu 4/9/2026 ✓, Sat 4/11/2026 ✓
    const msg = `Tue 4/7 · Easy 4mi\nThu 4/9 · Tempo 6mi\nSat 4/11 · Long run 9mi`;
    expect(fixSessionDayAbbreviations(msg, 2026, 4)).toBe(msg);
  });

  it("corrects a wrong day abbreviation", () => {
    // 4/7/2026 is a Tuesday, not a Monday
    const msg = `Mon 4/7 · Easy 4mi`;
    const result = fixSessionDayAbbreviations(msg, 2026, 4);
    expect(result).toBe("Tue 4/7 · Easy 4mi");
  });

  it("corrects multiple wrong day abbreviations in the same plan", () => {
    // 4/7 = Tue, 4/9 = Thu — both labelled wrong
    const msg = `Wed 4/7 · Easy 4mi\nMon 4/9 · Tempo 6mi`;
    const result = fixSessionDayAbbreviations(msg, 2026, 4);
    expect(result).toContain("Tue 4/7 · Easy 4mi");
    expect(result).toContain("Thu 4/9 · Tempo 6mi");
  });

  it("handles year rollover: session month earlier than ref month → next year", () => {
    // Plan generated in December 2026 (refMonth=12), session on 1/5/2027
    // Jan 5, 2027 is a Tuesday — if labelled as Mon it should be corrected
    const msg = `Mon 1/5 · Easy 4mi`;
    const result = fixSessionDayAbbreviations(msg, 2026, 12);
    // Jan 5, 2027 = Tuesday
    expect(result).toBe("Tue 1/5 · Easy 4mi");
  });

  it("leaves non-session lines unchanged", () => {
    const msg = `Great week ahead!\nTue 4/7 · Easy 4mi\nSee you soon.`;
    const result = fixSessionDayAbbreviations(msg, 2026, 4);
    expect(result).toContain("Great week ahead!");
    expect(result).toContain("See you soon.");
  });

  it("is a no-op when there are no session lines", () => {
    const msg = "No plan, just chatting.";
    expect(fixSessionDayAbbreviations(msg, 2026, 4)).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// countRunningSessions
// ---------------------------------------------------------------------------

describe("countRunningSessions", () => {
  it("counts only running sessions (sessions with mileage)", () => {
    const msg = `Tue 4/7 · Easy 4mi\nWed 4/8 · Strength 45min\nThu 4/9 · Tempo 6mi\nSat 4/11 · Long run 9mi`;
    expect(countRunningSessions(msg)).toBe(3);
  });

  it("returns 0 when no running sessions", () => {
    const msg = `Wed 4/8 · Strength 45min\nFri 4/10 · Rest`;
    expect(countRunningSessions(msg)).toBe(0);
  });

  it("returns 0 for non-plan messages", () => {
    expect(countRunningSessions("Good run today!")).toBe(0);
  });

  it("does not count cross-training sessions as running", () => {
    const msg = `Mon 4/6 · Easy 5mi\nTue 4/7 · Bike 45min\nThu 4/9 · Swim 30min`;
    expect(countRunningSessions(msg)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyStructuredWeeklyTotal
// ---------------------------------------------------------------------------

describe("applyStructuredWeeklyTotal", () => {
  it("corrects a wrong Total: figure to the validated number", () => {
    const msg = "This week I'd aim for 32 miles, one quality session mid-week. Total: 25 mi.";
    expect(applyStructuredWeeklyTotal(msg, 32)).toContain("Total: 32 mi");
  });

  it("leaves an already-correct total untouched", () => {
    const msg = "Total: 32 mi this week — long run and one tempo.";
    expect(applyStructuredWeeklyTotal(msg, 32)).toBe(msg);
  });

  it("recognizes 'puts you at X miles' phrasing", () => {
    const msg = "That puts you at 40 miles for the week.";
    expect(applyStructuredWeeklyTotal(msg, 36)).toContain("puts you at 36 miles");
  });

  it("does not touch the upper bound of a stated range", () => {
    const msg = "Aim for 20-25 miles this week.";
    expect(applyStructuredWeeklyTotal(msg, 32)).toBe(msg);
  });

  it("is a no-op when no total phrasing is present", () => {
    const msg = "Great week of running! Keep the easy days easy.";
    expect(applyStructuredWeeklyTotal(msg, 32)).toBe(msg);
  });

  it("rounds to one decimal place", () => {
    const msg = "Total: 20 mi.";
    expect(applyStructuredWeeklyTotal(msg, 22.34)).toContain("Total: 22.3 mi");
  });
});

describe("applyStructuredLongRun", () => {
  it("corrects a long-run distance that exceeds the cap", () => {
    const msg = "Long run: 8.5mi easy. Keeps the legs sharp without loading the shin.";
    expect(applyStructuredLongRun(msg, 4)).toContain("Long run: 4mi easy");
  });

  it("leaves an already-within-cap long run untouched", () => {
    const msg = "Long run: 4mi easy on trails.";
    expect(applyStructuredLongRun(msg, 4)).toBe(msg);
  });

  it("is a no-op when no long-run phrasing is present", () => {
    const msg = "Great week of running! Keep the easy days easy.";
    expect(applyStructuredLongRun(msg, 4)).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// reconcilePlanComponents
// ---------------------------------------------------------------------------

describe("reconcilePlanComponents", () => {
  it("is consistent when long run + quality sessions fit within the total", () => {
    expect(reconcilePlanComponents(20, 8, [4])).toEqual({ consistent: true, correctedLongRun: null });
  });

  it("is consistent with no long run reported", () => {
    expect(reconcilePlanComponents(20, null, [4, 5])).toEqual({ consistent: true, correctedLongRun: null });
  });

  it("flags and clamps when long run + quality sessions exceed the total", () => {
    // Total: 20mi, Long run: 14mi, tempo: 6mi — components alone sum to 20mi, leaving
    // 0mi for any easy days, but the long run being 14 while the true remainder is only
    // 14mi (20 - 6mi quality) is fine; push it further over to trigger a real violation.
    const result = reconcilePlanComponents(20, 16, [6]);
    expect(result.consistent).toBe(false);
    expect(result.correctedLongRun).toBe(14); // 20 - 6mi quality
  });

  it("floors the corrected long run at 0 when quality sessions alone exceed the total", () => {
    const result = reconcilePlanComponents(10, 8, [12]);
    expect(result.consistent).toBe(false);
    expect(result.correctedLongRun).toBe(0);
  });

  it("tolerates rounding within 0.5mi", () => {
    expect(reconcilePlanComponents(20, 14, [6.4])).toEqual({ consistent: true, correctedLongRun: null });
  });
});

// ---------------------------------------------------------------------------
// computeWeekOneVolumeCap
// ---------------------------------------------------------------------------

describe("computeWeekOneVolumeCap", () => {
  it("caps beginners with no Strava history at 10mi, no floor", () => {
    expect(computeWeekOneVolumeCap(null, "beginner", false)).toEqual({ min: 0, max: 10 });
  });

  it("caps beginners with stale/forced-beginner history at 10mi", () => {
    expect(computeWeekOneVolumeCap(15, "beginner", true)).toEqual({ min: 0, max: 10 });
  });

  it("gives advanced no-history athletes a floor of 20 and no ceiling", () => {
    expect(computeWeekOneVolumeCap(null, "advanced", false)).toEqual({ min: 20, max: null });
  });

  it("gives intermediate no-history athletes a floor of 12 and no ceiling", () => {
    expect(computeWeekOneVolumeCap(null, "intermediate", false)).toEqual({ min: 12, max: null });
  });

  it("caps low-volume athletes (<10mi avg) at current × 1.3, floor 6", () => {
    expect(computeWeekOneVolumeCap(5, null, false)).toEqual({ min: 0, max: 7 }); // ceil(5*1.3)=7
    expect(computeWeekOneVolumeCap(2, null, false)).toEqual({ min: 0, max: 6 }); // floor of 6 applies
  });

  it("bounds moderate-volume athletes (10-30mi avg) to 0.90x-1.2x", () => {
    expect(computeWeekOneVolumeCap(20, null, false)).toEqual({ min: 18, max: 24 });
  });

  it("bounds high-volume athletes (30mi+ avg) to 0.90x-1.12x", () => {
    expect(computeWeekOneVolumeCap(40, null, false)).toEqual({ min: 36, max: 45 });
  });

  it("ignores a short gap since last run (<7 days) — normal week-to-week noise", () => {
    expect(computeWeekOneVolumeCap(20, null, false, 5)).toEqual({ min: 18, max: 24 });
  });

  it("reduces the cap for a real layoff — a high pre-layoff average shouldn't hand back full volume (the reported bug: 11-day gap, 25mi avg, shin splints)", () => {
    expect(computeWeekOneVolumeCap(25, null, false, 11)).toEqual({ min: 15, max: 18 });
  });

  it("reduces the cap further for a longer layoff (14-20 days → 60%, 21+ days → 50%)", () => {
    expect(computeWeekOneVolumeCap(20, null, false, 14)).toEqual({ min: 10, max: 12 });
    expect(computeWeekOneVolumeCap(20, null, false, 21)).toEqual({ min: 9, max: 10 });
  });

  it("gap reduction still respects the beginner/no-history floor logic (forceBeginnerTier short-circuits before the gap check)", () => {
    expect(computeWeekOneVolumeCap(15, "beginner", true, 30)).toEqual({ min: 0, max: 10 });
  });

  it("an active injury forces the same gap-adjusted reduction even with no real day-count gap (the gradual-taper case)", () => {
    // avg 18mi/week, daysSinceLastRun null, activeInjury true -> defaults to the 0.60 factor
    expect(computeWeekOneVolumeCap(18, null, false, null, true)).toEqual({ min: 9, max: 11 });
    // a small, sub-7-day gap plus an active injury still gets the injury-driven 0.60 default,
    // not the (inapplicable) day-count factor
    expect(computeWeekOneVolumeCap(18, null, false, 2, true)).toEqual({ min: 9, max: 11 });
  });

  it("a real day-count gap still takes priority over the injury default when both are present", () => {
    // 21-day gap -> 0.50 factor wins over the injury-only 0.60 default
    expect(computeWeekOneVolumeCap(18, null, false, 21, true)).toEqual({ min: 8, max: 9 });
  });
});

// ---------------------------------------------------------------------------
// computeLongRunCap
// ---------------------------------------------------------------------------

describe("computeLongRunCap", () => {
  it("caps low-volume athletes at 35% of current weekly mileage, floor 3", () => {
    expect(computeLongRunCap(5)).toBe(3); // ceil(5*0.35)=2 -> floor of 3 applies
    expect(computeLongRunCap(9)).toBe(4); // ceil(9*0.35)=4
  });

  it("returns null for athletes at or above 10mi/week with no layoff gap — no stated cap for that tier", () => {
    expect(computeLongRunCap(10)).toBeNull();
    expect(computeLongRunCap(40)).toBeNull();
    expect(computeLongRunCap(18, 3)).toBeNull(); // 3-day gap is normal noise, not a real layoff
  });

  it("returns null when average mileage is unknown", () => {
    expect(computeLongRunCap(null)).toBeNull();
  });

  it("applies a cap for moderate/high-volume athletes with a real layoff gap (>=7 days)", () => {
    // avg 18mi/week, 14-day gap -> weekOneVolumeCap.max = round(18*0.6) = 11 -> ceil(11*0.35) = 4
    expect(computeLongRunCap(18, 14)).toBe(4);
    // avg 18mi/week, 21+ day gap -> weekOneVolumeCap.max = round(18*0.5) = 9 -> ceil(9*0.35) = 4
    expect(computeLongRunCap(18, 21)).toBe(4);
  });

  it("an active injury forces a cap above 10mi/week even with no real layoff gap — the gradual-taper case", () => {
    // avg 18mi/week, no gap, active injury -> weekOneVolumeCap.max = 11 (0.60 default) -> ceil(11*0.35) = 4
    expect(computeLongRunCap(18, null, true)).toBe(4);
    expect(computeLongRunCap(18, 3, true)).toBe(4); // small gap doesn't override the injury flag
  });
});

// ---------------------------------------------------------------------------
// parsePaceStrToSecPerMile
// ---------------------------------------------------------------------------

describe("parsePaceStrToSecPerMile", () => {
  it("parses a mile pace as-is", () => {
    expect(parsePaceStrToSecPerMile("8:15/mi")).toBe(8 * 60 + 15);
  });

  it("converts a km pace to mile-equivalent seconds", () => {
    // 4:30/km = 270s/km * 1.60934 = 434.5s/mi -> rounds to 435 (7:15/mi)
    const result = parsePaceStrToSecPerMile("4:30/km");
    expect(result).toBe(435);
  });

  it("assumes min/mile when no unit is present", () => {
    expect(parsePaceStrToSecPerMile("9:00")).toBe(9 * 60);
  });

  it("returns null for unparseable or missing input", () => {
    expect(parsePaceStrToSecPerMile(null)).toBeNull();
    expect(parsePaceStrToSecPerMile("easy effort")).toBeNull();
  });
});
