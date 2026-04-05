import { describe, it, expect } from "vitest";
import {
  parseSessionLines,
  enforceVolumeCaps,
  deduplicateSessionLines,
  fixSessionDistanceErrors,
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
