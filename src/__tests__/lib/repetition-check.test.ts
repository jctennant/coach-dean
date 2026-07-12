import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));

import { anthropic } from "@/lib/anthropic";
import { checkSemanticRepetition } from "@/lib/repetition-check";

describe("checkSemanticRepetition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits with no API call when there are no prior messages", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    const result = await checkSemanticRepetition("Great run today!", []);
    expect(result).toEqual({ repeats: false, angle: null });
    expect(create).not.toHaveBeenCalled();
  });

  it("short-circuits with no API call when the new message is empty", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    const result = await checkSemanticRepetition("   ", ["Keep your easy runs truly easy."]);
    expect(result).toEqual({ repeats: false, angle: null });
    expect(create).not.toHaveBeenCalled();
  });

  it("forces the report_repetition tool and parses a positive result", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({
      content: [{ type: "tool_use", id: "tu-1", name: "report_repetition", input: { repeats: true, angle: "keep easy runs truly easy" } }],
    });

    const result = await checkSemanticRepetition(
      "Remember to keep those easy days nice and relaxed.",
      ["Make sure your easy runs stay truly easy this week."]
    );

    expect(result).toEqual({ repeats: true, angle: "keep easy runs truly easy" });
    const params = create.mock.calls[0][0] as { tool_choice?: unknown; tools?: Array<{ name?: string }> };
    expect(params.tool_choice).toEqual({ type: "tool", name: "report_repetition" });
    expect(params.tools?.some((t) => t.name === "report_repetition")).toBe(true);
  });

  it("parses a negative result", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({
      content: [{ type: "tool_use", id: "tu-1", name: "report_repetition", input: { repeats: false, angle: "" } }],
    });
    const result = await checkSemanticRepetition("Cadence looked strong today.", ["Great negative split yesterday."]);
    expect(result).toEqual({ repeats: false, angle: null });
  });

  it("fails open (never throws, returns repeats:false) if the API call errors", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockRejectedValue(new Error("rate limited"));
    const result = await checkSemanticRepetition("Great run!", ["Nice pacing yesterday."]);
    expect(result).toEqual({ repeats: false, angle: null });
  });

  it("fails open if the model doesn't call the tool", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ content: [{ type: "text", text: "no tool call" }] });
    const result = await checkSemanticRepetition("Great run!", ["Nice pacing yesterday."]);
    expect(result).toEqual({ repeats: false, angle: null });
  });
});
