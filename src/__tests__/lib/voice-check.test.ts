import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));

import { anthropic } from "@/lib/anthropic";
import { checkVoice } from "@/lib/voice-check";

const create = () => anthropic.messages.create as ReturnType<typeof vi.fn>;

function mockReport(input: Record<string, unknown>) {
  create().mockResolvedValue({
    content: [{ type: "tool_use", name: "report_voice", input }],
  });
}

describe("checkVoice", () => {
  beforeEach(() => vi.clearAllMocks());

  it("short-circuits with no API call on empty input", async () => {
    expect(await checkVoice("   ")).toEqual({ ok: true, category: null, issue: null });
    expect(create()).not.toHaveBeenCalled();
  });

  it("short-circuits with no API call on [NO_REPLY]", async () => {
    // The deliberate no-send sentinel is not a message and has no voice to judge.
    expect(await checkVoice("[NO_REPLY]")).toEqual({ ok: true, category: null, issue: null });
    expect(create()).not.toHaveBeenCalled();
  });

  it("forces the report_voice tool and passes the message through", async () => {
    mockReport({ ok: true, category: "none", issue: "" });
    await checkVoice("8:58/mi at 153bpm. Base work is landing.");

    const args = create().mock.calls[0][0] as Record<string, unknown>;
    expect(args.model).toBe("claude-haiku-4-5-20251001");
    expect(args.tool_choice).toEqual({ type: "tool", name: "report_voice" });
    const content = (args.messages as Array<{ content: string }>)[0].content;
    expect(content).toContain("8:58/mi at 153bpm");
  });

  it("parses a clean result", async () => {
    mockReport({ ok: true, category: "none", issue: "" });
    expect(await checkVoice("Solid session.")).toEqual({ ok: true, category: null, issue: null });
  });

  it("parses a violation with its category and issue", async () => {
    mockReport({ ok: false, category: "filler", issue: "Ends with 'Let me know if you have questions'." });
    expect(await checkVoice("Nice work. Let me know if you have questions!")).toEqual({
      ok: false,
      category: "filler",
      issue: "Ends with 'Let me know if you have questions'.",
    });
  });

  it("tells the judge when humor is disallowed, and why", async () => {
    mockReport({ ok: true, category: "none", issue: "" });
    await checkVoice("How's the shin?", { humorAllowed: false, humorSuppressionReason: "active_injury" });

    const content = (create().mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(content).toContain("HUMOR ALLOWED: no");
    expect(content).toContain("active_injury");
  });

  it("says humor is allowed when the gate is open", async () => {
    mockReport({ ok: true, category: "none", issue: "" });
    await checkVoice("Solid week.", { humorAllowed: true });

    const content = (create().mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(content).toContain("HUMOR ALLOWED: yes");
  });

  it("defaults to allowing humor when no options are given", async () => {
    mockReport({ ok: true, category: "none", issue: "" });
    await checkVoice("Solid week.");
    const content = (create().mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(content).toContain("HUMOR ALLOWED: yes");
  });

  it("normalizes an unrecognized category to null while keeping the violation", async () => {
    mockReport({ ok: false, category: "vibes", issue: "something is off" });
    expect(await checkVoice("hello")).toEqual({ ok: false, category: null, issue: "something is off" });
  });

  it("supplies a fallback issue when the judge reports a violation with no description", async () => {
    mockReport({ ok: false, category: "sycophancy", issue: "" });
    const result = await checkVoice("Amazing work!!");
    expect(result.ok).toBe(false);
    expect(result.issue).toBeTruthy();
  });

  it("fails open when the API call throws", async () => {
    create().mockRejectedValue(new Error("503"));
    expect(await checkVoice("anything")).toEqual({ ok: true, category: null, issue: null });
  });

  it("fails open when the tool block is missing", async () => {
    create().mockResolvedValue({ content: [{ type: "text", text: "sure" }] });
    expect(await checkVoice("anything")).toEqual({ ok: true, category: null, issue: null });
  });
});
