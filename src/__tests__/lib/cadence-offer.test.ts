import { describe, it, expect } from "vitest";
import { buildCadenceOffer, isCadenceOffer, parseCadenceReply } from "@/lib/cadence-offer";

describe("buildCadenceOffer", () => {
  it("states both always-on touchpoints and offers the optional reminder", () => {
    const msg = buildCadenceOffer({ activeInjury: false });
    expect(msg).toContain("after every run");
    expect(msg).toContain("every Sunday");
    expect(msg).toContain("MORNING / NIGHT");
  });

  it("adds the first-run caution for an active injury, naming the body part", () => {
    const msg = buildCadenceOffer({ activeInjury: true, bodyPart: "left shin" });
    expect(msg).toContain("stop if the left shin flares up");
  });

  it("omits the body part clause when the injury has no named part", () => {
    const msg = buildCadenceOffer({ activeInjury: true, bodyPart: null });
    expect(msg).toContain("keep it easy");
    expect(msg).not.toContain("flares up");
  });

  it("is recognized by isCadenceOffer in every variant", () => {
    expect(isCadenceOffer(buildCadenceOffer({ activeInjury: false }))).toBe(true);
    expect(isCadenceOffer(buildCadenceOffer({ activeInjury: true, bodyPart: "achilles" }))).toBe(true);
  });

  it("does not match generateAndSaveFullPlan's plan-ready SMS, which shares its message_type", () => {
    expect(isCadenceOffer("Your plan is ready. From here: 20, 22, 24mi. Ask me about any week.")).toBe(false);
  });
});

describe("parseCadenceReply", () => {
  it("reads MORNING", () => {
    expect(parseCadenceReply("MORNING")).toBe("morning_reminders");
    expect(parseCadenceReply("morning please")).toBe("morning_reminders");
    expect(parseCadenceReply("yes, morning would be great")).toBe("morning_reminders");
  });

  it("reads NIGHT", () => {
    expect(parseCadenceReply("NIGHT")).toBe("nightly_reminders");
    expect(parseCadenceReply("night before is better for me")).toBe("nightly_reminders");
    expect(parseCadenceReply("evening")).toBe("nightly_reminders");
  });

  it("returns null for a bare plan confirmation so it falls through to normal coaching", () => {
    // "yes" confirms the plan, not a cadence — answering it with "I'll keep to Sunday
    // recaps" would be a non-sequitur, and weekly_only is already what onboarding wrote.
    expect(parseCadenceReply("YES")).toBeNull();
    expect(parseCadenceReply("yes looks good")).toBeNull();
    expect(parseCadenceReply("no thanks")).toBeNull();
  });

  it("returns null for an unrelated reply", () => {
    expect(parseCadenceReply("can we move the long run to Saturday?")).toBeNull();
  });
});
