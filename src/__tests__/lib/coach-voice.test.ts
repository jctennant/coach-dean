import { describe, it, expect } from "vitest";
import { computeHumorGate, buildVoiceBlock, buildVoiceContext } from "@/lib/coach-voice";

const okCtx = {
  activeInjury: false,
  injuryHold: false,
  askedAboutInjury: false,
  daysUntilRace: null,
  messageCount: 40,
};

describe("computeHumorGate", () => {
  it("allows humor for a healthy athlete with rapport and no imminent race", () => {
    expect(computeHumorGate(okCtx)).toEqual({ allowed: true, reason: null });
  });

  it("suppresses humor on an injury hold", () => {
    expect(computeHumorGate({ ...okCtx, injuryHold: true })).toEqual({
      allowed: false, reason: "injury_hold",
    });
  });

  it("suppresses humor with an active injury", () => {
    expect(computeHumorGate({ ...okCtx, activeInjury: true }).allowed).toBe(false);
  });

  it("suppresses humor when the athlete raised pain this turn", () => {
    expect(computeHumorGate({ ...okCtx, askedAboutInjury: true })).toEqual({
      allowed: false, reason: "pain_raised_this_turn",
    });
  });

  it("suppresses humor during race week", () => {
    expect(computeHumorGate({ ...okCtx, daysUntilRace: 3 }).reason).toBe("race_week");
    expect(computeHumorGate({ ...okCtx, daysUntilRace: 0 }).reason).toBe("race_week");
    expect(computeHumorGate({ ...okCtx, daysUntilRace: 7 }).reason).toBe("race_week");
  });

  it("allows humor outside race week and for races already past", () => {
    expect(computeHumorGate({ ...okCtx, daysUntilRace: 8 }).allowed).toBe(true);
    // A negative countdown is a stale race row, not an imminent one.
    expect(computeHumorGate({ ...okCtx, daysUntilRace: -3 }).allowed).toBe(true);
  });

  it("suppresses humor before any rapport exists", () => {
    expect(computeHumorGate({ ...okCtx, messageCount: 2 })).toEqual({
      allowed: false, reason: "no_rapport_yet",
    });
    expect(computeHumorGate({ ...okCtx, messageCount: 6 }).allowed).toBe(true);
  });

  it("prioritizes injury over every other suppression reason", () => {
    const gate = computeHumorGate({
      ...okCtx, injuryHold: true, activeInjury: true, daysUntilRace: 2, messageCount: 1,
    });
    expect(gate.reason).toBe("injury_hold");
  });
});

describe("buildVoiceBlock", () => {
  it("describes the persona in both gate states", () => {
    for (const gate of [{ allowed: true, reason: null }, { allowed: false, reason: "race_week" }]) {
      const block = buildVoiceBlock(gate);
      expect(block).toContain("VOICE:");
      expect(block).toContain("five to ten years older");
      expect(block).toContain("Warmth is earned");
    }
  });

  it("invites throttled humor when the gate is open", () => {
    const block = buildVoiceBlock({ allowed: true, reason: null });
    expect(block).toContain("HUMOR — allowed here");
    // The Poke throttle, which is the whole point of allowing humor at all.
    expect(block).toContain("Never two in a row unless the athlete jokes back");
  });

  it("does not invite humor at all when the gate is closed", () => {
    const block = buildVoiceBlock({ allowed: false, reason: "active_injury" });
    expect(block).toContain("HUMOR — not here");
    expect(block).not.toContain("HUMOR — allowed here");
    // Names the actual reason so the instruction reads as situational, not arbitrary.
    expect(block).toContain("an injury they're actively dealing with");
  });

  it("has a sane phrase for every suppression reason", () => {
    for (const reason of ["injury_hold", "active_injury", "pain_raised_this_turn", "race_week", "no_rapport_yet", null]) {
      const block = buildVoiceBlock({ allowed: false, reason });
      expect(block).toContain("HUMOR — not here");
      expect(block).not.toContain("undefined");
    }
  });
});

describe("buildVoiceContext", () => {
  const base = { profile: null, state: null, messageCount: 10, timezone: "America/Denver" };

  it("reads injury flags off the profile and state rows", () => {
    const ctx = buildVoiceContext({
      ...base,
      profile: { active_injury: true },
      state: { injury_hold_since: "2026-08-01" },
    });
    expect(ctx.activeInjury).toBe(true);
    expect(ctx.injuryHold).toBe(true);
  });

  it("treats missing rows as healthy rather than throwing", () => {
    const ctx = buildVoiceContext(base);
    expect(ctx).toEqual({
      activeInjury: false, injuryHold: false, askedAboutInjury: false,
      daysUntilRace: null, messageCount: 10,
    });
  });

  it("computes days until race from the first upcoming race", () => {
    const inFive = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const ctx = buildVoiceContext({ ...base, upcomingRaces: [{ race_date: inFive }] });
    expect(ctx.daysUntilRace).toBe(5);
  });

  it("leaves daysUntilRace null for a missing or unparseable race date", () => {
    expect(buildVoiceContext({ ...base, upcomingRaces: [] }).daysUntilRace).toBeNull();
    expect(buildVoiceContext({ ...base, upcomingRaces: [{ race_date: null }] }).daysUntilRace).toBeNull();
    expect(buildVoiceContext({ ...base, upcomingRaces: [{ race_date: "not-a-date" }] }).daysUntilRace).toBeNull();
  });
});
