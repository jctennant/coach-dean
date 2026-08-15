import { describe, expect, it } from "vitest";
import { GOAL_POLL, RTR_GATE_POLL, PAIN_CHECKIN_POLL, POLLS_BY_TITLE } from "@/lib/polls";

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

describe("PAIN_CHECKIN_POLL", () => {
  it("has exactly 4 options", () => {
    expect(PAIN_CHECKIN_POLL.options).toHaveLength(4);
  });

  it("maps every option to a message containing an explicit number, so the existing pain_level extraction picks it up", () => {
    for (const option of PAIN_CHECKIN_POLL.options) {
      const message = PAIN_CHECKIN_POLL.optionToMessage(option);
      expect(message).toBeTruthy();
      expect(message).toMatch(/\d/);
    }
  });

  it("maps Pain-free to 0 out of 10", () => {
    expect(PAIN_CHECKIN_POLL.optionToMessage("Pain-free")).toMatch(/0 out of 10/);
  });

  it("maps the mild bucket to a value inside the PAIN THRESHOLD RULE's 0-2 monitor range", () => {
    expect(PAIN_CHECKIN_POLL.optionToMessage("Mild (1-2)")).toMatch(/2 out of 10/);
  });

  it("maps the moderate bucket to a value at/above the PAIN THRESHOLD RULE's stop threshold (3/10)", () => {
    expect(PAIN_CHECKIN_POLL.optionToMessage("Moderate (3-4)")).toMatch(/4 out of 10/);
  });

  it("maps the significant bucket to a clearly elevated value", () => {
    expect(PAIN_CHECKIN_POLL.optionToMessage("Significant (5+)")).toMatch(/6 or higher/);
  });

  it("keeps option label lengths close together so native iMessage polls don't auto-shrink one option's font relative to the others", () => {
    const lengths = PAIN_CHECKIN_POLL.options.map((o) => o.length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(10);
  });
});

describe("POLLS_BY_TITLE", () => {
  it("indexes all polls by their exact title", () => {
    expect(POLLS_BY_TITLE[GOAL_POLL.title]).toBe(GOAL_POLL);
    expect(POLLS_BY_TITLE[RTR_GATE_POLL.title]).toBe(RTR_GATE_POLL);
    expect(POLLS_BY_TITLE[PAIN_CHECKIN_POLL.title]).toBe(PAIN_CHECKIN_POLL);
  });
});
