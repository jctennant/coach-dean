import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));

import { anthropic } from "@/lib/anthropic";
import { checkDateConsistency, mentionsRelativeDay } from "@/lib/date-consistency-check";

const dateFacts = { today: "Sunday, Jul 12", yesterday: "Saturday, Jul 11", tomorrow: "Monday, Jul 13" };

describe("mentionsRelativeDay", () => {
  it("matches relative day words and weekday names", () => {
    expect(mentionsRelativeDay("no running today or tomorrow")).toBe(true);
    expect(mentionsRelativeDay("test it Monday or Tuesday")).toBe(true);
    expect(mentionsRelativeDay("Great effort out there!")).toBe(false);
  });
});

describe("checkDateConsistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits with no API call when the message doesn't mention a relative day", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    const result = await checkDateConsistency("Great effort out there — keep it up!", dateFacts);
    expect(result).toEqual({ inconsistent: false, issue: null });
    expect(create).not.toHaveBeenCalled();
  });

  it("short-circuits with no API call when the message is empty", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    const result = await checkDateConsistency("   ", dateFacts);
    expect(result).toEqual({ inconsistent: false, issue: null });
    expect(create).not.toHaveBeenCalled();
  });

  it("forces the report_date_consistency tool and parses a positive (contradiction) result", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({
      content: [{
        type: "tool_use", id: "tu-1", name: "report_date_consistency",
        input: { inconsistent: true, issue: "calls Monday both a rest day and a test-run day" },
      }],
    });

    const result = await checkDateConsistency(
      "Keep today and tomorrow as rest days — we'll test a short jog Monday or Tuesday.",
      dateFacts
    );

    expect(result).toEqual({ inconsistent: true, issue: "calls Monday both a rest day and a test-run day" });
    const params = create.mock.calls[0][0] as { tool_choice?: unknown; tools?: Array<{ name?: string }> };
    expect(params.tool_choice).toEqual({ type: "tool", name: "report_date_consistency" });
    expect(params.tools?.some((t) => t.name === "report_date_consistency")).toBe(true);
  });

  it("parses a negative (consistent) result", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({
      content: [{ type: "tool_use", id: "tu-1", name: "report_date_consistency", input: { inconsistent: false, issue: "" } }],
    });
    const result = await checkDateConsistency("Rest today, easy jog tomorrow.", dateFacts);
    expect(result).toEqual({ inconsistent: false, issue: null });
  });

  it("fails open (never throws, returns inconsistent:false) if the API call errors", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockRejectedValue(new Error("rate limited"));
    const result = await checkDateConsistency("No running today or tomorrow.", dateFacts);
    expect(result).toEqual({ inconsistent: false, issue: null });
  });

  it("fails open if the model doesn't call the tool", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ content: [{ type: "text", text: "no tool call" }] });
    const result = await checkDateConsistency("No running today or tomorrow.", dateFacts);
    expect(result).toEqual({ inconsistent: false, issue: null });
  });
});
