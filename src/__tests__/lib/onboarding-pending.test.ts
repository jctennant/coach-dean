import { describe, it, expect } from "vitest";
import {
  pendingOnboarding,
  lastQuestionAsked,
  onboardingNudgeQuestion,
} from "@/lib/onboarding-pending";

describe("pendingOnboarding", () => {
  it("returns null once onboarding is complete", () => {
    expect(pendingOnboarding(null, {})).toBeNull();
  });

  it("returns null for stages that aren't waiting on the athlete", () => {
    expect(pendingOnboarding("awaiting_payment", {})).toBeNull();
  });

  it("identifies the awaiting_strava pause state", () => {
    expect(pendingOnboarding("awaiting_strava", {})?.stage).toBe("awaiting_strava");
  });

  it("identifies the injury_intake stage from onboarding_data", () => {
    const pending = pendingOnboarding("onboarding", { stage: "injury_intake", name: "Jake", goal: "trail_race" });
    expect(pending?.stage).toBe("injury_intake");
    expect(pending?.fallbackQuestion).toMatch(/injury/i);
  });

  it("identifies the schedule_confirm stage from onboarding_data", () => {
    const pending = pendingOnboarding("onboarding", { stage: "schedule_confirm", name: "Jake", goal: "trail_race" });
    expect(pending?.stage).toBe("schedule_confirm");
    expect(pending?.fallbackQuestion).toMatch(/days/i);
  });

  it("falls back to the goals stage in collection order", () => {
    expect(pendingOnboarding("onboarding", {})?.stage).toBe("goals_name");
    expect(pendingOnboarding("onboarding", { name: "Jake" })?.stage).toBe("goals_goal");
    expect(pendingOnboarding("onboarding", { name: "Jake", goal: "marathon" })?.stage).toBe("goals_strava");
    expect(
      pendingOnboarding("onboarding", { name: "Jake", goal: "marathon", strava_connected: true })?.stage
    ).toBe("goals_wrap");
  });
});

describe("lastQuestionAsked", () => {
  it("returns the last question from the most recent assistant message", () => {
    const q = lastQuestionAsked([
      { role: "assistant", content: "What's your name?" },
      { role: "user", content: "Jake" },
      { role: "assistant", content: "Got it. How many days a week do you run? And what shoes?" },
    ]);
    expect(q).toBe("And what shoes?");
  });

  it("returns null when the last assistant message asked nothing", () => {
    expect(
      lastQuestionAsked([
        { role: "assistant", content: "Plan's locked in." },
      ])
    ).toBeNull();
  });

  it("ignores questions in user messages", () => {
    expect(
      lastQuestionAsked([
        { role: "assistant", content: "Locked in." },
        { role: "user", content: "Can I move my long run?" },
      ])
    ).toBeNull();
  });
});

describe("onboardingNudgeQuestion", () => {
  const scheduleHistory = [
    { role: "assistant" as const, content: "Looks like you typically run Wed/Fri — sound right, or want different days?" },
  ];

  it("re-asks the outstanding question in Dean's own words", () => {
    const q = onboardingNudgeQuestion(
      "onboarding",
      { stage: "schedule_confirm", name: "Jake", goal: "trail_race" },
      scheduleHistory,
      ["4mi run today. 12mi running this week."]
    );
    expect(q).toBe("Looks like you typically run Wed/Fri — sound right, or want different days?");
  });

  it("falls back to the canned question when Dean's last message asked nothing", () => {
    const q = onboardingNudgeQuestion(
      "onboarding",
      { stage: "schedule_confirm", name: "Jake", goal: "trail_race" },
      [{ role: "assistant", content: "Plan's coming together." }],
      []
    );
    expect(q).toBe("What days of the week do you want to run?");
  });

  it("still nudges when the only prior ask was the onboarding message itself", () => {
    const q = onboardingNudgeQuestion(
      "onboarding",
      { stage: "schedule_confirm", name: "Jake", goal: "trail_race" },
      scheduleHistory,
      [] // no prior post-activity sends
    );
    expect(q).toBe("Looks like you typically run Wed/Fri — sound right, or want different days?");
  });

  it("does not repeat a question the previous post-activity message already carried", () => {
    const q = onboardingNudgeQuestion(
      "onboarding",
      { stage: "schedule_confirm", name: "Jake", goal: "trail_race" },
      scheduleHistory,
      ["5mi run today. 17mi running this week.\n\nLooks like you typically run Wed/Fri — sound right, or want different days?"]
    );
    expect(q).toBeNull();
  });

  it("stays silent for awaiting_strava — the pending action is a link, not a question", () => {
    expect(onboardingNudgeQuestion("awaiting_strava", {}, [], [])).toBeNull();
  });

  it("stays silent when nothing is actually missing", () => {
    expect(
      onboardingNudgeQuestion(
        "onboarding",
        { name: "Jake", goal: "marathon", strava_connected: true },
        [],
        []
      )
    ).toBeNull();
    expect(onboardingNudgeQuestion(null, {}, [], [])).toBeNull();
  });
});
