/**
 * Semantic repetition check — a focused Haiku call that judges whether a freshly
 * generated coaching message repeats the same underlying observation/advice as a
 * recent message of the same type, based on meaning rather than a maintained
 * phrase/regex list.
 *
 * This is the "Poke pattern" from CLAUDE.md applied to the repetition problem: a
 * pure execution agent judging one narrow question, called once per response,
 * instead of a growing FORBIDDEN PHRASES list or regex "lens" taxonomy in the main
 * coaching prompt that has to be hand-extended every time Dean finds a new way to
 * say "keep your easy runs truly easy."
 *
 * v1 is advisory-only: coach/respond fires this after a message is already queued
 * for send and logs the result (trackEvent) rather than blocking or rewriting the
 * message. That's a deliberate choice for a live SMS pipeline — it gives real
 * telemetry on how often semantic repetition slips past the existing regex lenses,
 * without introducing a regeneration loop (added latency, cost, and a new failure
 * mode) until that telemetry says it's worth it.
 */

import { anthropic } from "./anthropic";
import type Anthropic from "@anthropic-ai/sdk";

export interface RepetitionCheckResult {
  repeats: boolean;
  angle: string | null;
}

const REPORT_TOOL = {
  name: "report_repetition" as const,
  description: "Report whether the NEW message repeats a coaching angle already used in one of the PRIOR messages.",
  input_schema: {
    type: "object" as const,
    properties: {
      repeats: {
        type: "boolean",
        description: "True if the NEW message makes essentially the same observation, advice, or point as one of the PRIOR messages — even if worded completely differently. False if it's a genuinely different angle, even if some phrasing overlaps.",
      },
      angle: {
        type: "string",
        description: "If repeats is true, a short phrase naming the repeated angle (e.g. 'keep easy runs truly easy', 'cadence improvement'). Empty string if repeats is false.",
      },
    },
    required: ["repeats", "angle"],
  },
};

/**
 * Compare a new coaching message against up to a few recent messages of the same
 * type (most recent first) and report whether it repeats the same coaching angle.
 * Fails open — any error or malformed response returns { repeats: false }, since a
 * validator failure must never block or affect the actual SMS send.
 */
export async function checkSemanticRepetition(
  newMessage: string,
  recentSameTypeMessages: string[]
): Promise<RepetitionCheckResult> {
  if (!newMessage.trim() || recentSameTypeMessages.length === 0) {
    return { repeats: false, angle: null };
  }
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:
        "You are a QA classifier for a running coach's text messages to one athlete. Compare the NEW message " +
        "to the PRIOR messages (same athlete, same type of message, most recent first). Judge ONLY whether the " +
        "NEW message repeats the same underlying coaching observation or advice as a PRIOR one — different " +
        "wording of the same point still counts as a repeat. A different topic that happens to share a word or " +
        "two is not a repeat. Call report_repetition with your judgment and nothing else.",
      messages: [
        {
          role: "user",
          content:
            `PRIOR MESSAGES (most recent first):\n${recentSameTypeMessages.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n` +
            `NEW MESSAGE:\n${newMessage}`,
        },
      ],
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: "report_repetition" },
    });
    const block = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "report_repetition"
    );
    if (!block) return { repeats: false, angle: null };
    const input = block.input as { repeats?: boolean; angle?: string };
    return { repeats: !!input.repeats, angle: input.angle?.trim() || null };
  } catch (err) {
    console.error("[repetition-check] failed:", err);
    return { repeats: false, angle: null };
  }
}
