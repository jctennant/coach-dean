/**
 * Blocking validator gate for proactive (cron-driven) coaching messages.
 *
 * repetition-check.ts and date-consistency-check.ts shipped advisory-only because
 * they sit on the live inbound-SMS path, where a regeneration loop adds latency and
 * a new failure mode. Proactive triggers (morning_plan, weekly_recap,
 * nightly_reminder) have neither constraint: nobody is waiting on the reply, and
 * coach/respond already runs with maxDuration 300. So for those triggers the checks
 * gate the send, with a one-shot repair:
 *
 *   check → (fail) → focused repair call → re-check → (pass) send repaired
 *                                        → (fail) send ORIGINAL, log
 *
 * Fail-open everywhere: any validator/repair error sends the original message.
 * The original has been through all deterministic corrections (mileage totals,
 * volume caps, day-abbreviation fixes), so on any doubt it is the least-risk text
 * to send. The repair prompt pins numbers/facts as unchangeable, and a repaired
 * message is only used if it passes re-validation.
 */

import { anthropic } from "./anthropic";
import type Anthropic from "@anthropic-ai/sdk";
import { checkDateConsistency } from "./date-consistency-check";
import { checkSemanticRepetition } from "./repetition-check";
import type { DateFacts } from "./timezone";

export interface GateEvent {
  event: string;
  detail?: string | null;
}

export interface GateResult {
  message: string;
  events: GateEvent[];
}

const REPAIR_TOOL = {
  name: "deliver_repaired_message" as const,
  description: "Deliver the corrected version of the coaching message.",
  input_schema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        description: "The full corrected message, ready to send. No commentary, no preamble — the message text only.",
      },
    },
    required: ["message"],
  },
};

type RepairProblem =
  | { kind: "date_consistency"; issue: string; dateFacts: DateFacts }
  | { kind: "repetition"; angle: string; priorMessages: string[] };

/**
 * One focused rewrite call. Returns the repaired message, or null on any
 * error/empty result (caller falls back to the original).
 */
export async function repairCoachMessage(
  message: string,
  problem: RepairProblem
): Promise<string | null> {
  try {
    const instructions =
      problem.kind === "date_consistency"
        ? "A QA check flagged this coaching SMS for a day/date contradiction: " +
          `"${problem.issue}". Fix ONLY the day/date references so they are internally consistent ` +
          "and consistent with the KNOWN DATE FACTS. Do not change distances, paces, workout content, " +
          "tone, or anything else. Keep the length nearly identical."
        : "A QA check flagged this coaching SMS as repeating a coaching angle the athlete was already " +
          `told recently: "${problem.angle}" (see PRIOR MESSAGES). Rewrite the repeated observation/advice ` +
          "to take a genuinely different angle grounded in the same run/plan. Keep every number, date, " +
          "distance, and pace EXACTLY as written — change only the coaching observation. Keep tone and " +
          "length similar.";

    const context =
      problem.kind === "date_consistency"
        ? `KNOWN DATE FACTS:\nToday: ${problem.dateFacts.today}\nYesterday: ${problem.dateFacts.yesterday}\nTomorrow: ${problem.dateFacts.tomorrow}`
        : `PRIOR MESSAGES (most recent first):\n${problem.priorMessages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1000,
      system:
        "You are a copy-editor for a running coach's SMS messages. You receive one message that failed a " +
        "QA check, plus instructions on the one thing to fix. Make the minimal correction and deliver the " +
        "full corrected message via deliver_repaired_message. Never add new claims, numbers, or workouts.",
      messages: [
        {
          role: "user",
          content: `${instructions}\n\n${context}\n\nMESSAGE TO FIX:\n${message}`,
        },
      ],
      tools: [REPAIR_TOOL],
      tool_choice: { type: "tool", name: "deliver_repaired_message" },
    });
    const block = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "deliver_repaired_message"
    );
    const repaired = (block?.input as { message?: string } | undefined)?.message?.trim();
    return repaired || null;
  } catch (err) {
    console.error("[response-gate] repair call failed:", err);
    return null;
  }
}

/**
 * Run the blocking gate for a proactive message. Returns the message to send
 * (original or validated repair) plus telemetry events for the caller to log.
 */
export async function gateProactiveResponse(params: {
  message: string;
  dateFacts: DateFacts;
  /** Prior assistant messages of the same message_type, most recent first. Empty = skip repetition check. */
  priorSameTypeMessages: string[];
}): Promise<GateResult> {
  const events: GateEvent[] = [];
  let message = params.message;

  // Date consistency first — objective, and its repair is the most localized.
  const dateResult = await checkDateConsistency(message, params.dateFacts);
  if (dateResult.inconsistent) {
    events.push({ event: "gate_date_inconsistency_detected", detail: dateResult.issue });
    const repaired = await repairCoachMessage(message, {
      kind: "date_consistency",
      issue: dateResult.issue ?? "day/date contradiction",
      dateFacts: params.dateFacts,
    });
    const recheck = repaired ? await checkDateConsistency(repaired, params.dateFacts) : null;
    if (repaired && recheck && !recheck.inconsistent) {
      message = repaired;
      events.push({ event: "gate_date_repaired" });
    } else {
      events.push({ event: "gate_date_repair_failed_sent_original" });
    }
  }

  // Semantic repetition second (runs on the possibly-repaired text).
  if (params.priorSameTypeMessages.length > 0) {
    const repResult = await checkSemanticRepetition(message, params.priorSameTypeMessages);
    if (repResult.repeats) {
      events.push({ event: "gate_repetition_detected", detail: repResult.angle });
      const repaired = await repairCoachMessage(message, {
        kind: "repetition",
        angle: repResult.angle ?? "same coaching angle",
        priorMessages: params.priorSameTypeMessages,
      });
      const recheck = repaired
        ? await checkSemanticRepetition(repaired, params.priorSameTypeMessages)
        : null;
      if (repaired && recheck && !recheck.repeats) {
        message = repaired;
        events.push({ event: "gate_repetition_repaired" });
      } else {
        events.push({ event: "gate_repetition_repair_failed_sent_original" });
      }
    }
  }

  return { message, events };
}
