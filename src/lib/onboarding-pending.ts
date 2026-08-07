/**
 * Which onboarding question is currently outstanding, derived from persisted state.
 *
 * Two callers need this and used to answer it independently:
 *   - `onboarding/handle`'s off-topic classifier, which needs a redirect line to steer a
 *     tangent back to the pending question.
 *   - `coach/respond`'s `post_run_onboarding` path, which fires when a mid-onboarding athlete
 *     logs a Strava activity and should nudge them back to whatever setup step is still open.
 *
 * Keeping the stage -> question mapping in one place means the nudge an athlete gets after a
 * run is literally the same question the conversation is blocked on, rather than a second
 * hand-maintained copy that drifts.
 *
 * Everything here is pure: stage state in, strings out. No DB, no LLM.
 */

export interface PendingOnboarding {
  /** Stage key, for logging / analytics. */
  stage: string;
  /** What this stage is trying to collect — used as the classifier's goal description. */
  goal: string;
  /** Question to fall back on when Dean's own last-asked question isn't available. */
  fallbackQuestion: string;
}

/**
 * The outstanding onboarding step, or null when nothing is blocked (onboarding is complete,
 * or the athlete is in a stage that isn't waiting on an answer).
 *
 * `data` is the user's `onboarding_data` JSON.
 */
export function pendingOnboarding(
  step: string | null,
  data: Record<string, unknown>
): PendingOnboarding | null {
  if (step === "awaiting_strava") {
    return {
      stage: "awaiting_strava",
      goal: "get the athlete to connect Strava",
      fallbackQuestion: "To keep going I need to connect to Strava — the link's just above.",
    };
  }
  if (step === "awaiting_timezone") {
    return {
      stage: "awaiting_timezone",
      goal: "get the athlete's city or state so reminders fire at the right local time",
      fallbackQuestion: "What city or state are you in?",
    };
  }
  if (step !== "onboarding") return null;

  const stage = data.stage as string | undefined;
  if (stage === "injury_intake") {
    return {
      stage: "injury_intake",
      goal: "collect injury details — body part, severity, and when the pain flares",
      fallbackQuestion: "Back to the injury for a second — how limiting is it right now?",
    };
  }
  if (stage === "schedule_confirm") {
    return {
      stage: "schedule_confirm",
      goal: "confirm which days the athlete trains and what they want out of the plan",
      fallbackQuestion: "What days of the week do you want to run?",
    };
  }
  // Goals stage — ordered by what the conversation collects first.
  if (!data.name) {
    return {
      stage: "goals_name",
      goal: "collect the athlete's name and what they're training for",
      fallbackQuestion: "What's your name, and what are you working toward?",
    };
  }
  if (!data.goal) {
    return {
      stage: "goals_goal",
      goal: "confirm the athlete's training goal",
      fallbackQuestion: "What race or goal are you training for?",
    };
  }
  if (!data.strava_connected) {
    return {
      stage: "goals_strava",
      goal: "get the athlete to connect Strava",
      fallbackQuestion: "To keep going I need to connect to Strava — the link's just above.",
    };
  }
  return {
    stage: "goals_wrap",
    goal: "wrap up and signal ready",
    fallbackQuestion: "Ready to lock this in whenever you are.",
  };
}

/**
 * The last question Dean actually asked, pulled from conversation history. Preferred over
 * `fallbackQuestion` wherever it exists — re-asking in Dean's own words reads as continuing
 * the conversation, whereas a differently-phrased restatement reads as if the first ask never
 * landed.
 *
 * `history` is oldest-first.
 */
export function lastQuestionAsked(
  history: Array<{ role: "user" | "assistant"; content: string }>
): string | null {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const questions = lastAssistant.match(/[^.!?\n]+\?/g);
  return questions?.[questions.length - 1]?.trim() ?? null;
}

/**
 * Stages where re-asking after a logged activity is genuinely useful. `awaiting_strava` is
 * excluded because its "question" is a link the athlete already has — repeating the sentence
 * without the link is worse than saying nothing. `goals_wrap` is excluded because nothing is
 * actually missing there; the conversation is just waiting on Dean's own next turn.
 */
const NUDGEABLE_STAGES = new Set([
  "awaiting_timezone",
  "injury_intake",
  "schedule_confirm",
  "goals_name",
  "goals_goal",
]);

/**
 * The question to append to a post-activity message so a mid-onboarding athlete knows setup is
 * still waiting on them, or null when there's nothing worth nudging.
 *
 * `recentPostActivityMessages` is most-recent-first and must contain ONLY prior post-activity
 * sends — not the onboarding conversation itself. An athlete who logs three runs without
 * answering shouldn't get the same question appended all three times, but the onboarding
 * message that originally asked it is not evidence of that; it's the normal starting state.
 */
export function onboardingNudgeQuestion(
  step: string | null,
  data: Record<string, unknown>,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  recentPostActivityMessages: string[]
): string | null {
  const pending = pendingOnboarding(step, data);
  if (!pending || !NUDGEABLE_STAGES.has(pending.stage)) return null;

  const question = lastQuestionAsked(history) ?? pending.fallbackQuestion;
  if (recentPostActivityMessages[0]?.includes(question)) return null;
  return question;
}
