/**
 * Voice check — a focused Haiku call that judges whether a coaching message sounds
 * like Dean, semantically, rather than matching it against a phrase list.
 *
 * This is the CLAUDE.md decision-order step 2 applied to persona: `route.ts` currently
 * defends its voice with maintained enumerations (the `weekly_recap` FORBIDDEN PHRASES
 * block, the NO SIGN-OFFS lines repeated across three OUTPUT CONTRACTs, the
 * recentPostRunInsights lens array). Every one of those needs a new entry the next time
 * the model invents new wording for the same failure, which is exactly the treadmill
 * CLAUDE.md warns about. A validator that judges MEANING doesn't need the list.
 *
 * It checks four things, all things a phrase list is bad at:
 *   - sycophancy: warmth that wasn't earned by anything specific
 *   - humor that's forced, unfunny, or badly timed (and any humor at all when the
 *     structural gate in coach-voice.ts is closed for this turn)
 *   - sign-offs, filler, and generic openers, however they're phrased
 *   - corporate/customer-service register
 *
 * Fails open: any error returns ok, since a validator failure must never block a
 * coaching message. Callers decide whether to gate on the result — response-gate.ts
 * gates proactive sends (nobody is waiting) and the inbound path runs it advisory.
 */

import { anthropic } from "./anthropic";
import type Anthropic from "@anthropic-ai/sdk";

export type VoiceIssueCategory = "sycophancy" | "humor" | "filler" | "corporate";

export interface VoiceCheckResult {
  ok: boolean;
  category: VoiceIssueCategory | null;
  /** Short description of what's off, used to steer the repair call. */
  issue: string | null;
}

const REPORT_TOOL = {
  name: "report_voice" as const,
  description: "Report whether the message violates the coach's voice rules.",
  input_schema: {
    type: "object" as const,
    properties: {
      ok: {
        type: "boolean",
        description: "True if the message is in voice. False if it clearly breaks one of the four rules.",
      },
      category: {
        type: "string",
        enum: ["sycophancy", "humor", "filler", "corporate", "none"],
        description: "Which rule it breaks, or \"none\" when ok is true.",
      },
      issue: {
        type: "string",
        description:
          "If ok is false, one short sentence naming the specific problem and quoting the offending words. Empty string when ok is true.",
      },
    },
    required: ["ok", "category", "issue"],
  },
};

const SYSTEM = `You are a voice QA checker for a running coach named Dean who texts his athletes.

Dean's voice: a coach five to ten years older than the athlete. Experienced, direct, unhurried. Warm when the moment earns it. Dry humor occasionally. Texts like a person, not a company.

Judge the message against these four rules ONLY. Report a violation only when it CLEARLY breaks one — you are catching real failures, not tightening good writing. A blunt, plain, or unadorned message is correct and is never a violation.

1. SYCOPHANCY — warmth not earned by anything specific. Generic praise as a greeting or social lubricant ("Great job!", "Amazing work!", "Love to see it!"), flattery, gushing, or eagerness to please. NOT a violation: specific earned praise tied to something in the data ("that negative split shows real discipline").

2. HUMOR — a joke that is forced, obvious, well-worn, at the athlete's expense, or badly timed. Also a violation: ANY attempt at humor when HUMOR ALLOWED is "no" below. NOT a violation: a dry aside that lands naturally, or no humor at all.

3. FILLER — sign-offs and closing invitations ("Let me know if you have questions", "You've got this!", "Keep it up", "Feel free to reach out"), a preamble before getting to the point ("Saw your run come through, here's what I noticed"), or a closing sentence that just restates what was already said. The message should end on its actual content.

4. CORPORATE — customer-service or business register: "I apologize for any confusion", "Great question!", "happy to help", "circle back", "reach out", "per your request". NOT a violation: normal plain English.

Judge meaning, not specific wording — a sign-off you've never seen phrased that way is still a sign-off. Call report_voice and nothing else.`;

/**
 * Judge one outbound coaching message. `humorAllowed` comes from the structural gate
 * in coach-voice.ts — when it's false, any humor at all is a violation, which is how
 * the gate gets enforced rather than merely requested.
 */
export async function checkVoice(
  message: string,
  opts: { humorAllowed: boolean; humorSuppressionReason?: string | null } = { humorAllowed: true }
): Promise<VoiceCheckResult> {
  const trimmed = message.trim();
  if (!trimmed || trimmed === "[NO_REPLY]") return { ok: true, category: null, issue: null };

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `HUMOR ALLOWED: ${opts.humorAllowed ? "yes" : "no"}${
              opts.humorAllowed ? "" : ` (this turn involves: ${opts.humorSuppressionReason ?? "a serious topic"})`
            }\n\nMESSAGE:\n${trimmed}`,
        },
      ],
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: "report_voice" },
    });
    const block = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "report_voice"
    );
    if (!block) return { ok: true, category: null, issue: null };
    const input = block.input as { ok?: boolean; category?: string; issue?: string };
    if (input.ok !== false) return { ok: true, category: null, issue: null };
    const category = (["sycophancy", "humor", "filler", "corporate"] as const).find(
      (c) => c === input.category
    );
    return {
      ok: false,
      category: category ?? null,
      issue: input.issue?.trim() || "message is off-voice",
    };
  } catch (err) {
    console.error("[voice-check] failed:", err);
    return { ok: true, category: null, issue: null };
  }
}
