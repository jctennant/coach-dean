/**
 * Date/day-of-week consistency check — a focused Haiku call that judges whether a
 * freshly generated coaching message is internally consistent about which calendar
 * days are "rest/no-run" vs. "active/test" days, and consistent with the known
 * current date. Modeled directly on repetition-check.ts.
 *
 * "Dean doesn't know what day it is" surfaces as two related but distinct failures:
 *
 * 1. Absolute mismatch — stating the wrong weekday for today/tomorrow/yesterday.
 *    formatDateAnchor (timezone.ts) is now prepended to every generation turn
 *    specifically to prevent this, so it should be rare — but this check still
 *    catches it if the model free-associates a weekday instead of reading the
 *    anchor.
 * 2. Internal contradiction — correctly anchored on today/tomorrow, but assigning
 *    the *same* calendar day two conflicting labels within one message (e.g. "no
 *    running today or tomorrow" then "we'll test it Monday or Tuesday" when
 *    tomorrow IS Monday). There's no fixed ground truth for which days are "rest"
 *    vs. "test" days beyond what the message itself asserts, so — same rationale
 *    as repetition-check.ts — this needs a classifier judging meaning, not a
 *    regex/phrase list.
 *
 * v1 is advisory-only: coach/respond fires this after a message is already queued
 * for send and logs the result (trackEvent) rather than blocking or rewriting the
 * message — same deliberate choice as repetition-check.ts for a live SMS pipeline.
 */

import { anthropic } from "./anthropic";
import type Anthropic from "@anthropic-ai/sdk";
import type { DateFacts } from "./timezone";

export interface DateConsistencyResult {
  inconsistent: boolean;
  issue: string | null;
}

/** Cheap pre-filter so the Haiku call only fires on messages that reference relative days at all. */
const RELATIVE_DAY_RE =
  /\b(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

export function mentionsRelativeDay(text: string): boolean {
  return RELATIVE_DAY_RE.test(text);
}

const REPORT_TOOL = {
  name: "report_date_consistency" as const,
  description: "Report whether the MESSAGE is internally consistent and consistent with the KNOWN DATE FACTS about which calendar days are rest/no-run vs. active/test days.",
  input_schema: {
    type: "object" as const,
    properties: {
      inconsistent: {
        type: "boolean",
        description: "True if the MESSAGE either (a) states a weekday for today/tomorrow/yesterday that conflicts with KNOWN DATE FACTS, or (b) assigns the same calendar day conflicting labels within the message (e.g. calling a day both a rest day and a day to test/run). False if the message's day references are internally consistent and consistent with the known facts, even if phrased loosely.",
      },
      issue: {
        type: "string",
        description: "If inconsistent is true, a short phrase describing the specific contradiction (e.g. 'calls Monday both a rest day and a test-run day'). Empty string if inconsistent is false.",
      },
    },
    required: ["inconsistent", "issue"],
  },
};

/**
 * Check a freshly generated coaching message for date/weekday consistency.
 * Fails open — any error or malformed response returns { inconsistent: false },
 * since a validator failure must never block or affect the actual SMS send.
 */
export async function checkDateConsistency(
  message: string,
  dateFacts: DateFacts
): Promise<DateConsistencyResult> {
  if (!message.trim() || !mentionsRelativeDay(message)) {
    return { inconsistent: false, issue: null };
  }
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:
        "You are a QA classifier for a running coach's text messages to one athlete. You're given KNOWN DATE FACTS " +
        "(the real today/yesterday/tomorrow) and a MESSAGE the coach is about to send. Judge ONLY whether the MESSAGE's " +
        "day references are internally consistent and consistent with the KNOWN DATE FACTS — specifically, whether any " +
        "single calendar day is assigned two conflicting roles (e.g. told to rest AND told to run/test on the same day), " +
        "or whether today/tomorrow/yesterday is misstated relative to KNOWN DATE FACTS. Do not flag anything else — tone, " +
        "training advice, and phrasing style are out of scope. Call report_date_consistency with your judgment and nothing else.",
      messages: [
        {
          role: "user",
          content:
            `KNOWN DATE FACTS:\nToday: ${dateFacts.today}\nYesterday: ${dateFacts.yesterday}\nTomorrow: ${dateFacts.tomorrow}\n\n` +
            `MESSAGE:\n${message}`,
        },
      ],
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: "report_date_consistency" },
    });
    const block = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "report_date_consistency"
    );
    if (!block) return { inconsistent: false, issue: null };
    const input = block.input as { inconsistent?: boolean; issue?: string };
    return { inconsistent: !!input.inconsistent, issue: input.issue?.trim() || null };
  } catch (err) {
    console.error("[date-consistency-check] failed:", err);
    return { inconsistent: false, issue: null };
  }
}
