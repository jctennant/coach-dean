import { describe, it, expect } from "vitest";
import { resolveWeekMode, type WeekModeInput } from "@/lib/week-mode";

const base: WeekModeInput = {
  injuryHoldSince: null,
  returnToRunPhase: null,
  activeInjury: false,
  isComplementMode: false,
  isAnalystMode: false,
};

describe("resolveWeekMode", () => {
  it("gives a healthy athlete the normal arc week with both quality sessions", () => {
    expect(resolveWeekMode(base)).toEqual({ mode: "arc", qualityPolicy: "both" });
  });

  it("gives an athlete running through an injury one quality session, not two", () => {
    // The case this resolver exists for: active_injury with no hold used to get the fully
    // injury-blind skeleton — two quality days and unsafe cross-training.
    expect(resolveWeekMode({ ...base, activeInjury: true }))
      .toEqual({ mode: "arc", qualityPolicy: "one" });
  });

  it("gives a held athlete the recovery week", () => {
    expect(resolveWeekMode({ ...base, injuryHoldSince: "2026-08-01", activeInjury: true }))
      .toEqual({ mode: "recovery", qualityPolicy: "none" });
  });

  it("yields to the return-to-run prompt in phase 1 rather than contradicting it", () => {
    expect(resolveWeekMode({ ...base, returnToRunPhase: 1 }))
      .toEqual({ mode: "none", qualityPolicy: "none" });
  });

  it("gives return-to-run phase 2 easy running only", () => {
    expect(resolveWeekMode({ ...base, returnToRunPhase: 2 }))
      .toEqual({ mode: "arc", qualityPolicy: "none" });
  });

  it("schedules nothing for complement and analyst athletes", () => {
    expect(resolveWeekMode({ ...base, isComplementMode: true }))
      .toEqual({ mode: "none", qualityPolicy: "none" });
    expect(resolveWeekMode({ ...base, isAnalystMode: true }))
      .toEqual({ mode: "none", qualityPolicy: "none" });
  });

  describe("precedence", () => {
    it("puts complement/analyst above everything, including a hold", () => {
      expect(resolveWeekMode({ ...base, isComplementMode: true, injuryHoldSince: "2026-08-01" }))
        .toEqual({ mode: "none", qualityPolicy: "none" });
    });

    it("puts a hold above a return-to-run phase", () => {
      expect(resolveWeekMode({ ...base, injuryHoldSince: "2026-08-01", returnToRunPhase: 2 }))
        .toEqual({ mode: "recovery", qualityPolicy: "none" });
    });

    it("puts a return-to-run phase above the bare active-injury flag", () => {
      // handleInjuryClear leaves active_injury set through the RTR phases, so these co-occur
      // constantly — phase 2's easy-only rule has to win over active_injury's one-quality rule.
      expect(resolveWeekMode({ ...base, returnToRunPhase: 2, activeInjury: true }))
        .toEqual({ mode: "arc", qualityPolicy: "none" });
      expect(resolveWeekMode({ ...base, returnToRunPhase: 1, activeInjury: true }))
        .toEqual({ mode: "none", qualityPolicy: "none" });
    });
  });
});
