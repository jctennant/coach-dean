import { describe, expect, it } from "vitest";
import { GOAL_POLL, RTR_GATE_POLL, POLLS_BY_TITLE } from "@/lib/polls";

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

describe("RTR_GATE_POLL", () => {
  it("maps Pain-free to a pain-free message", () => {
    expect(RTR_GATE_POLL.optionToMessage("Pain-free")).toMatch(/pain-free/i);
  });

  it("maps the pain option to a message reporting pain", () => {
    expect(RTR_GATE_POLL.optionToMessage("Some pain during or after")).toMatch(/some pain/i);
  });
});

describe("POLLS_BY_TITLE", () => {
  it("indexes both polls by their exact title", () => {
    expect(POLLS_BY_TITLE[GOAL_POLL.title]).toBe(GOAL_POLL);
    expect(POLLS_BY_TITLE[RTR_GATE_POLL.title]).toBe(RTR_GATE_POLL);
  });
});
