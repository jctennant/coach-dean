import { describe, it, expect, vi, beforeEach } from "vitest";
import { gateProactiveResponse, repairCoachMessage } from "@/lib/response-gate";
import { checkDateConsistency } from "@/lib/date-consistency-check";
import { checkSemanticRepetition } from "@/lib/repetition-check";
import { checkVoice } from "@/lib/voice-check";
import { anthropic } from "@/lib/anthropic";

vi.mock("@/lib/date-consistency-check", () => ({
  checkDateConsistency: vi.fn(),
}));
vi.mock("@/lib/repetition-check", () => ({
  checkSemanticRepetition: vi.fn(),
}));
vi.mock("@/lib/voice-check", () => ({
  checkVoice: vi.fn(),
}));
vi.mock("@/lib/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));

const mockDateCheck = vi.mocked(checkDateConsistency);
const mockRepCheck = vi.mocked(checkSemanticRepetition);
const mockVoiceCheck = vi.mocked(checkVoice);
const mockCreate = vi.mocked(anthropic.messages.create);

const dateFacts = {
  today: "Friday, July 18",
  yesterday: "Thursday, July 17",
  tomorrow: "Saturday, July 19",
} as never;

function repairResponse(message: string) {
  return {
    content: [
      { type: "tool_use", name: "deliver_repaired_message", input: { message } },
    ],
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The voice check runs on every gated message, so every test needs a default.
  mockVoiceCheck.mockResolvedValue({ ok: true, category: null, issue: null });
});

describe("gateProactiveResponse", () => {
  it("passes a clean message through untouched with no events", async () => {
    mockDateCheck.mockResolvedValue({ inconsistent: false, issue: null });
    mockRepCheck.mockResolvedValue({ repeats: false, angle: null });

    const result = await gateProactiveResponse({
      message: "Easy 4 tomorrow. Keep it conversational.",
      dateFacts,
      priorSameTypeMessages: ["prior recap"],
    });

    expect(result.message).toBe("Easy 4 tomorrow. Keep it conversational.");
    expect(result.events).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips the repetition check when there are no prior same-type messages", async () => {
    mockDateCheck.mockResolvedValue({ inconsistent: false, issue: null });

    await gateProactiveResponse({
      message: "Rest day today.",
      dateFacts,
      priorSameTypeMessages: [],
    });

    expect(mockRepCheck).not.toHaveBeenCalled();
  });

  it("repairs a date inconsistency and sends the repaired text when the recheck passes", async () => {
    mockDateCheck
      .mockResolvedValueOnce({ inconsistent: true, issue: "calls Saturday both rest and test day" })
      .mockResolvedValueOnce({ inconsistent: false, issue: null });
    mockRepCheck.mockResolvedValue({ repeats: false, angle: null });
    mockCreate.mockResolvedValue(repairResponse("Fixed message. Test it Sunday."));

    const result = await gateProactiveResponse({
      message: "Rest Saturday. Test it Saturday.",
      dateFacts,
      priorSameTypeMessages: ["prior"],
    });

    expect(result.message).toBe("Fixed message. Test it Sunday.");
    expect(result.events.map((e) => e.event)).toEqual([
      "gate_date_inconsistency_detected",
      "gate_date_repaired",
    ]);
  });

  it("falls back to the original when the repaired text still fails the recheck", async () => {
    mockDateCheck
      .mockResolvedValueOnce({ inconsistent: true, issue: "wrong weekday for today" })
      .mockResolvedValueOnce({ inconsistent: true, issue: "still wrong" });
    mockRepCheck.mockResolvedValue({ repeats: false, angle: null });
    mockCreate.mockResolvedValue(repairResponse("Still-broken repair."));

    const result = await gateProactiveResponse({
      message: "Original message about Monday.",
      dateFacts,
      priorSameTypeMessages: [],
    });

    expect(result.message).toBe("Original message about Monday.");
    expect(result.events.map((e) => e.event)).toEqual([
      "gate_date_inconsistency_detected",
      "gate_date_repair_failed_sent_original",
    ]);
  });

  it("falls back to the original when the repair call itself fails", async () => {
    mockDateCheck.mockResolvedValueOnce({ inconsistent: true, issue: "issue" });
    mockCreate.mockRejectedValue(new Error("api down"));

    const result = await gateProactiveResponse({
      message: "Original.",
      dateFacts,
      priorSameTypeMessages: [],
    });

    expect(result.message).toBe("Original.");
    expect(result.events.map((e) => e.event)).toEqual([
      "gate_date_inconsistency_detected",
      "gate_date_repair_failed_sent_original",
    ]);
  });

  it("repairs semantic repetition and sends the repaired text when the recheck passes", async () => {
    mockDateCheck.mockResolvedValue({ inconsistent: false, issue: null });
    mockRepCheck
      .mockResolvedValueOnce({ repeats: true, angle: "keep easy runs easy" })
      .mockResolvedValueOnce({ repeats: false, angle: null });
    mockCreate.mockResolvedValue(repairResponse("New angle: your cadence held steady on tired legs."));

    const result = await gateProactiveResponse({
      message: "Keep those easy runs easy.",
      dateFacts,
      priorSameTypeMessages: ["Remember to keep easy runs truly easy."],
    });

    expect(result.message).toBe("New angle: your cadence held steady on tired legs.");
    expect(result.events.map((e) => e.event)).toEqual([
      "gate_repetition_detected",
      "gate_repetition_repaired",
    ]);
  });

  it("runs the repetition check on the date-repaired text", async () => {
    mockDateCheck
      .mockResolvedValueOnce({ inconsistent: true, issue: "wrong day" })
      .mockResolvedValueOnce({ inconsistent: false, issue: null });
    mockRepCheck.mockResolvedValue({ repeats: false, angle: null });
    mockCreate.mockResolvedValue(repairResponse("Date-fixed text."));

    await gateProactiveResponse({
      message: "Broken date text.",
      dateFacts,
      priorSameTypeMessages: ["prior"],
    });

    expect(mockRepCheck).toHaveBeenCalledWith("Date-fixed text.", ["prior"]);
  });
});

describe("repairCoachMessage", () => {
  it("returns null when the response has no tool_use block", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no tool" }] } as never);
    const result = await repairCoachMessage("msg", {
      kind: "date_consistency",
      issue: "x",
      dateFacts,
    });
    expect(result).toBeNull();
  });

  it("returns null when the repaired message is empty", async () => {
    mockCreate.mockResolvedValue(repairResponse("  "));
    const result = await repairCoachMessage("msg", {
      kind: "repetition",
      angle: "x",
      priorMessages: ["a"],
    });
    expect(result).toBeNull();
  });
});

describe("gateProactiveResponse — voice check", () => {
  beforeEach(() => {
    mockDateCheck.mockResolvedValue({ inconsistent: false, issue: null });
    mockRepCheck.mockResolvedValue({ repeats: false, angle: null });
  });

  it("passes the humor gate through to the checker", async () => {
    await gateProactiveResponse({
      message: "How's the shin today?",
      dateFacts,
      priorSameTypeMessages: [],
      humor: { allowed: false, reason: "active_injury" },
    });

    expect(mockVoiceCheck).toHaveBeenCalledWith("How's the shin today?", {
      humorAllowed: false,
      humorSuppressionReason: "active_injury",
    });
  });

  it("defaults to allowing humor when no gate is supplied", async () => {
    await gateProactiveResponse({ message: "Solid week.", dateFacts, priorSameTypeMessages: [] });
    expect(mockVoiceCheck).toHaveBeenCalledWith("Solid week.", {
      humorAllowed: true,
      humorSuppressionReason: null,
    });
  });

  it("repairs an off-voice message and sends the repaired version", async () => {
    mockVoiceCheck
      .mockResolvedValueOnce({ ok: false, category: "filler", issue: "ends with a sign-off" })
      .mockResolvedValueOnce({ ok: true, category: null, issue: null });
    mockCreate.mockResolvedValue(repairResponse("Easy 4 tomorrow."));

    const result = await gateProactiveResponse({
      message: "Easy 4 tomorrow. Let me know if you have questions!",
      dateFacts,
      priorSameTypeMessages: [],
    });

    expect(result.message).toBe("Easy 4 tomorrow.");
    expect(result.events.map((e) => e.event)).toEqual([
      "gate_voice_issue_detected",
      "gate_voice_repaired",
    ]);
  });

  it("sends the ORIGINAL when the repair is still off-voice", async () => {
    const original = "Easy 4 tomorrow. You've got this!";
    mockVoiceCheck.mockResolvedValue({ ok: false, category: "sycophancy", issue: "unearned praise" });
    mockCreate.mockResolvedValue(repairResponse("Easy 4 tomorrow. Keep it up!"));

    const result = await gateProactiveResponse({
      message: original, dateFacts, priorSameTypeMessages: [],
    });

    // Fail-open: the original has already been through every deterministic correction.
    expect(result.message).toBe(original);
    expect(result.events.map((e) => e.event)).toContain("gate_voice_repair_failed_sent_original");
  });

  it("judges the text produced by an earlier repair, not the original", async () => {
    // A date/repetition rewrite can reintroduce a sign-off, so voice must run last.
    mockDateCheck
      .mockResolvedValueOnce({ inconsistent: true, issue: "said Friday, today is Thursday" })
      .mockResolvedValueOnce({ inconsistent: false, issue: null });
    mockCreate.mockResolvedValue(repairResponse("Easy 4 Thursday."));

    await gateProactiveResponse({ message: "Easy 4 Friday.", dateFacts, priorSameTypeMessages: [] });

    expect(mockVoiceCheck).toHaveBeenCalledWith("Easy 4 Thursday.", expect.anything());
  });

  it("propagates a checker error for the caller's fail-open handler", async () => {
    // checkVoice fails open internally, so this only happens on a genuine crash. The
    // gate deliberately doesn't swallow it — route.ts wraps gateProactiveResponse in a
    // try/catch that sends the original message, matching the date/repetition checks.
    mockVoiceCheck.mockRejectedValue(new Error("boom"));
    await expect(
      gateProactiveResponse({ message: "Solid week.", dateFacts, priorSameTypeMessages: [] })
    ).rejects.toThrow("boom");
  });
});
