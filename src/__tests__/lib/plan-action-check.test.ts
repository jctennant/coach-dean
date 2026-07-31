import { describe, it, expect } from "vitest";
import { messageClaimsUnsignaledPlanChange } from "@/lib/plan-action-check";

describe("messageClaimsUnsignaledPlanChange", () => {
  it("flags a message confirming a swap with no plan_action set", () => {
    expect(messageClaimsUnsignaledPlanChange("I've swapped Thursday's run for an easy bike.", null)).toBe(true);
  });

  it("flags a message confirming a lighter week with an empty plan_action object", () => {
    expect(messageClaimsUnsignaledPlanChange("I've lightened this week's plan given the soreness.", {})).toBe(true);
  });

  it("does not flag when plan_action.session_swaps is actually set", () => {
    const planAction = { session_swaps: [{ day: "Thu", to: "40min easy bike" }] };
    expect(messageClaimsUnsignaledPlanChange("I've swapped Thursday's run for an easy bike.", planAction)).toBe(false);
  });

  it("does not flag when plan_action.lighter_week is true", () => {
    expect(messageClaimsUnsignaledPlanChange("I've lightened this week's plan.", { lighter_week: true })).toBe(false);
  });

  it("does not flag ordinary conversational text with no change language", () => {
    expect(messageClaimsUnsignaledPlanChange("Great run today! Keep the easy days easy.", null)).toBe(false);
  });

  it("does not flag a proposal that hasn't been confirmed yet", () => {
    expect(messageClaimsUnsignaledPlanChange("Want me to swap Thursday's run for an easy bike?", null)).toBe(false);
  });

  it("does not flag when an unrelated plan_action field is set but the message claims a different change", () => {
    // physio_referral is set, but the message confirms a session swap that never landed —
    // hasAnyPlanAction still short-circuits since the check is deliberately coarse (v1
    // advisory heuristic, not a per-field match) — documenting that limitation via test.
    expect(messageClaimsUnsignaledPlanChange("I've swapped Thursday's run for an easy bike.", { physio_referral: true })).toBe(false);
  });
});
