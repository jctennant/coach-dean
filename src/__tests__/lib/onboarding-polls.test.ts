import { describe, expect, it } from "vitest";
import { GOAL_POLL, ONBOARDING_POLLS_BY_TITLE } from "@/lib/onboarding-polls";

describe("GOAL_POLL", () => {
  it("maps every option to a non-empty message", () => {
    for (const option of GOAL_POLL.options) {
      expect(GOAL_POLL.optionToMessage(option)).toBeTruthy();
    }
  });

  it("maps an unrecognized option to the not-sure fallback", () => {
    expect(GOAL_POLL.optionToMessage("Not sure yet")).toMatch(/not totally sure/i);
  });
});

describe("ONBOARDING_POLLS_BY_TITLE", () => {
  it("indexes the goal poll by its exact title", () => {
    expect(ONBOARDING_POLLS_BY_TITLE[GOAL_POLL.title]).toBe(GOAL_POLL);
  });
});
