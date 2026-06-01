/**
 * Judge prompt builder for onboarding eval harness.
 * Evaluates behavioral correctness of Dean's onboarding responses.
 */

export function buildOnboardingJudgePrompt(fixture, deanResponse) {
  const { collected = {}, is_first_response, ground_truth, category } = fixture;

  const collectedSummary = Object.entries(collected)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n") || "  (nothing collected yet)";

  const firstMessageCriteria = is_first_response ? `
1. has_intro: Does the response include a brief intro of who Dean is and what he does?
   - true = mentions being an AI running coach AND at least one of: building plans, Strava integration, SMS coaching
   - false = jumps straight to questions with no self-introduction at all
   - null = N/A (not first message)

2. asks_name: Does the response ask for the athlete's name in a combined question with their goal?
   - true = asks for name AND goal/training context in one combined question (e.g. "What's your name, and what are you working toward?")
   - false = does not ask for name, OR asks for name and goal as two separate questions
   - null = name already collected` : `
1. has_intro: null (not first message)

2. asks_name: ${!collected.name ? `Does the response ask for the athlete's name?
   - true = explicitly asks
   - false = does not ask` : "null (name already collected)"}`;

  return `You are evaluating a message from "Coach Dean", an AI running coach onboarding a new athlete over SMS.

IS THIS DEAN'S FIRST MESSAGE: ${is_first_response ? "YES" : "NO"}

WHAT DEAN ALREADY KNOWS (collected fields — must not re-ask for these):
${collectedSummary}

DEAN'S RESPONSE TO EVALUATE:
"""
${deanResponse}
"""

EVALUATION CRITERIA:
${firstMessageCriteria}

3. no_greeting_repeat: Does the response avoid repeating greeting phrases?
   ${is_first_response
     ? "- null (first message — greeting is expected)"
     : `- true = does NOT contain "Great to meet you", "Nice to meet you", "Great to hear from you", "Glad you're here", or similar; does NOT re-describe what Dean does
   - false = contains one of those phrases or re-introduces Dean's capabilities`}

4. no_reask: Does the response avoid asking for information that's already collected above?
   - true = no question about any field already shown under "WHAT DEAN ALREADY KNOWS"
   - false = asks about a field that IS already shown under "WHAT DEAN ALREADY KNOWS"
   - IMPORTANT DISTINCTIONS:
     * goal TYPE (e.g., "half_marathon", "trail_race") is NOT the same as a specific race name. If goal type is collected but race_name is NOT, asking "What specific race are you targeting?" is CORRECT — it is asking for race_name, which hasn't been collected yet.
     * For trail/mountain races: asking about race INTENT ("Are you racing to finish, or targeting a placement?") is asking for a NEW field (finish_vs_competitive) — this is NOT re-asking for the goal type.
     * Only flag no_reask=false if the response asks for something explicitly listed in the "WHAT DEAN ALREADY KNOWS" section above.
   - Key things to check: if training_days collected → must not ask about schedule; if race_name (specific event) collected → must not ask about it again

5. ready_behavior: ${category === "ready_signal"
    ? `This is a ready_signal fixture — evaluate carefully:
   - "ready_clean" = [READY] present in response AND no open questions asked
   - "ready_with_question" = [READY] present BUT also asks a question (this is the failure mode)
   - "not_ready" = [READY] not present (acceptable only if info is genuinely still missing)
   - null = N/A`
    : `- null (not a ready_signal fixture)`}

SCORE RUBRIC:
- 10: All criteria pass, response is natural, warm, moves conversation forward
- 7-9: Minor wording issues but all behavioral checks pass
- 4-6: One behavioral failure (re-asked something, skipped intro, repeated greeting)
- 1-3: Multiple failures or seriously off-brand
- 0: Completely wrong or incoherent

EVALUATOR NOTES FROM FIXTURE:
${ground_truth?.notes || "None."}

Return ONLY valid JSON — no preamble:
{
  "has_intro": true | false | null,
  "asks_name": true | false | null,
  "no_greeting_repeat": true | false | null,
  "no_reask": true | false | null,
  "ready_behavior": "ready_clean" | "ready_with_question" | "not_ready" | null,
  "flags": ["list any specific failures with exact quoted text from the response"],
  "score": 0,
  "score_rationale": "one sentence"
}`;
}
