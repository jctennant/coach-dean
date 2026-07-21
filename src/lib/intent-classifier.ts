import { anthropic } from "@/lib/anthropic";
import { normalizeBodyPart } from "@/lib/exercise-library";
import type { Logger } from "@/lib/logger";

export type Intent = "injury_query" | "plan_question" | "strava_query" | "cadence_request" | "general";
export type Cadence = "morning_reminders" | "nightly_reminders" | "weekly_only";

export interface ClassifiedIntent {
  intent: Intent;
  bodyPart?: string;
  cadence?: Cadence;
  confidence: "high" | "low";
}

interface InjuryContext {
  activeInjury: boolean;
  bodyPart?: string | null;
}

// cadence_request is classified and handled deterministically (see route.ts) rather
// than left to the main coaching prompt — a heavily injury-focused conversation was
// observed reliably burying this narrow, well-defined request under the FULL PLAN
// REQUESTS framing whenever the athlete's phrasing happened to contain the word
// "plan" (e.g. "opt me into daily morning reminders of my workout plan"). Routing it
// through this classifier instead makes the bug structurally impossible rather than
// relying on prompt-tuning to out-compete the injury context for attention.
const SYSTEM_PROMPT = `You are classifying a message from a runner to their AI running coach. Return JSON only — no explanation.

Classify intent as one of:
- "injury_query": athlete is asking about pain, soreness, tightness, injury, exercises, or rehab for a body part
- "cadence_request": athlete explicitly asks to change how often the coach proactively texts them — e.g. "opt me into daily morning reminders", "can you text me every morning with the plan", "stop texting me at night", "just send the weekly recap, nothing daily". This is about texting FREQUENCY, not about viewing or discussing the training plan itself.
- "plan_question": athlete is asking about their training plan, schedule, sessions, mileage, or workouts (but NOT asking to change texting frequency — that's cadence_request even if the word "plan" appears)
- "strava_query": athlete is asking about their Strava data, past runs, stats, or activity history
- "general": anything else (motivation, check-in, general question, conversation)

If injury_query, also extract the body_part (e.g. "knee", "shin", "it_band", "hamstring", "calf", "foot", "hip", "ankle", "back", "groin", "glute", "piriformis"). Use snake_case.

If cadence_request, also extract which cadence they want as "cadence": "morning_reminders" (daily morning text with the plan), "nightly_reminders" (night-before reminder), or "weekly_only" (no daily texts, just the Sunday recap and reactive post-run feedback). Use null if the athlete's intent is clear but the specific cadence isn't.

Response format:
{"intent":"<intent>","body_part":"<body_part or null>","cadence":"<cadence or null>","confidence":"high|low"}`;

export async function classifyIntent(
  userMessage: string,
  injuryContext: InjuryContext,
  log?: Logger,
): Promise<ClassifiedIntent> {
  const fallback: ClassifiedIntent = { intent: "general", confidence: "low" };

  try {
    const start = Date.now();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage.slice(0, 500) }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    const durationMs = Date.now() - start;

    // Haiku sometimes wraps the JSON in a markdown code fence (```json ... ```)
    // despite "Return JSON only" — strip it before parsing so a correctly
    // classified intent doesn't get silently discarded to the "general" fallback.
    const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

    let parsed: { intent?: string; body_part?: string | null; cadence?: string | null; confidence?: string };
    try {
      parsed = JSON.parse(unfenced);
    } catch {
      log?.warn("intent-classifier: JSON parse failed", { raw, durationMs });
      return fallback;
    }

    const intent = (["injury_query", "plan_question", "strava_query", "cadence_request", "general"].includes(parsed.intent ?? "")
      ? parsed.intent
      : "general") as Intent;

    const confidence = parsed.confidence === "high" ? "high" : "low";

    // Normalize body part — prefer the classified one, fall back to active injury context
    let bodyPart: string | undefined;
    if (intent === "injury_query") {
      const raw_part = parsed.body_part ?? injuryContext.bodyPart ?? null;
      bodyPart = raw_part ? (normalizeBodyPart(raw_part) ?? undefined) : undefined;
      // If athlete has an active injury and query is injury-related, trust the context even without a new body part
      if (!bodyPart && injuryContext.activeInjury && injuryContext.bodyPart) {
        bodyPart = normalizeBodyPart(injuryContext.bodyPart) ?? undefined;
      }
    }

    const cadence = intent === "cadence_request" &&
      ["morning_reminders", "nightly_reminders", "weekly_only"].includes(parsed.cadence ?? "")
      ? (parsed.cadence as Cadence)
      : undefined;

    log?.info("intent-classifier: classified", { intent, bodyPart, cadence, confidence, durationMs });
    return { intent, bodyPart, cadence, confidence };
  } catch (err) {
    log?.warn("intent-classifier: Haiku call failed, falling back to general", { error: String(err) });
    return fallback;
  }
}
