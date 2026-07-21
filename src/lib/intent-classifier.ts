import { anthropic } from "@/lib/anthropic";
import { normalizeBodyPart } from "@/lib/exercise-library";
import type { Logger } from "@/lib/logger";

export type Intent = "injury_query" | "plan_question" | "strava_query" | "general";

export interface ClassifiedIntent {
  intent: Intent;
  bodyPart?: string;
  confidence: "high" | "low";
}

interface InjuryContext {
  activeInjury: boolean;
  bodyPart?: string | null;
}

const SYSTEM_PROMPT = `You are classifying a message from a runner to their AI running coach. Return JSON only — no explanation.

Classify intent as one of:
- "injury_query": athlete is asking about pain, soreness, tightness, injury, exercises, or rehab for a body part
- "plan_question": athlete is asking about their training plan, schedule, sessions, mileage, or workouts
- "strava_query": athlete is asking about their Strava data, past runs, stats, or activity history
- "general": anything else (motivation, check-in, general question, conversation)

If injury_query, also extract the body_part (e.g. "knee", "shin", "it_band", "hamstring", "calf", "foot", "hip", "ankle", "back", "groin", "glute", "piriformis"). Use snake_case.

Response format:
{"intent":"<intent>","body_part":"<body_part or null>","confidence":"high|low"}`;

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

    let parsed: { intent?: string; body_part?: string | null; confidence?: string };
    try {
      parsed = JSON.parse(unfenced);
    } catch {
      log?.warn("intent-classifier: JSON parse failed", { raw, durationMs });
      return fallback;
    }

    const intent = (["injury_query", "plan_question", "strava_query", "general"].includes(parsed.intent ?? "")
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

    log?.info("intent-classifier: classified", { intent, bodyPart, confidence, durationMs });
    return { intent, bodyPart, confidence };
  } catch (err) {
    log?.warn("intent-classifier: Haiku call failed, falling back to general", { error: String(err) });
    return fallback;
  }
}
