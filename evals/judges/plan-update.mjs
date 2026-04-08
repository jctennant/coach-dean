/**
 * Judge prompt builder for plan update evals.
 * Used when fixture.category === "plan_update".
 *
 * Evaluates whether Coach Dean correctly applied an athlete's requested
 * plan modification (reschedule, volume adjustment, structure change, etc.)
 * without making unintended changes or ignoring the request.
 */

export function buildPlanUpdateJudgePrompt(fixture, coachResponse) {
  const { user, ground_truth, inbound_sms } = fixture;
  const today = fixture.today ?? "2026-04-08";

  const contextSummary = `
ATHLETE PROFILE (authoritative):
- Name: ${user.name}
- Goal race: ${user.goal_race || user.goal}${user.goal_race_date ? ` on ${user.goal_race_date}` : ""}
- Goal race distance: ${user.goal_race_distance || "not specified"}
- Current week: ${user.current_week} of training, phase: ${user.current_phase}
- Weekly mileage target: ${user.weekly_mileage_target} mi/week
- Training days: ${(user.training_days || []).join(", ")}
- Today: ${today}
- Miles logged this week so far: ${user.miles_logged_this_week || 0} mi

RECENT CONVERSATION (if any):
${user.recent_conversation && user.recent_conversation.length > 0
  ? user.recent_conversation.map(m => `  [${m.role === "user" ? "Athlete" : "Coach"}]: ${m.content}`).join("\n")
  : "  (none)"}

ATHLETE'S REQUEST (the inbound SMS Dean received):
"${inbound_sms}"

EXPECTED BEHAVIOR (ground truth):
${buildUpdateGroundTruthBlock(ground_truth)}
`.trim();

  return `You are evaluating a response from "Coach Dean", an AI running coach that communicates via SMS.

The athlete sent a request to modify their training plan. Evaluate whether Dean correctly understood and applied the change.

${contextSummary}

COACH DEAN'S RESPONSE:
"""
${coachResponse}
"""

EVALUATION DIMENSIONS:

1. change_acknowledged
   Did Dean clearly confirm or acknowledge the specific change the athlete requested?
   - true = yes, clearly acknowledged what will change
   - false = ignored the request, gave a generic reply, or gave a conflicting answer

2. change_applied_correctly
   Did Dean actually apply the requested change correctly in their response?
   - true = the change appears correctly applied (e.g., rescheduled session appears on the new day, volume adjusted, etc.)
   - false = the change was not applied, was applied incorrectly, or contradicts the request
   - null = impossible to evaluate from the response alone (e.g., Dean said "I'll update the plan" but gave no specifics)

3. no_unintended_changes
   Did Dean avoid modifying things that weren't asked?
   - true = only the requested change was made; other sessions/structure preserved
   - false = Dean changed additional things the athlete didn't ask for (e.g., rewrote the whole week when only asked to move one session)
   - null = impossible to tell from the response

4. appropriate_caveats
   If the change has meaningful training implications (e.g., losing a quality session, spiking volume), did Dean note this without being preachy?
   - true = flagged relevant tradeoffs concisely, or there were no meaningful tradeoffs to flag
   - false = ignored a significant training concern, OR over-lectured the athlete about a minor change
   - null = no meaningful tradeoffs existed

5. specific_enough
   Did Dean give specific enough information for the athlete to act on?
   - true = athlete knows exactly what to do (specific days, sessions, distances, or paces if relevant)
   - false = vague response that doesn't tell the athlete what changed or what to do next
   - null = the request only required a short acknowledgment (no specifics needed)

SCORE RUBRIC:
- 10: Dean understood the request, applied it correctly, gave specifics, and flagged tradeoffs if needed — perfect update
- 7-9: Mostly correct with minor issues (slightly vague, minor unintended change, missed a minor caveat)
- 4-6: One significant problem (wrong change applied, ignored a key tradeoff, too vague to act on)
- 1-3: Multiple problems or fundamentally misunderstood the request
- 0: Completely ignored the request or gave nonsensical output

Return ONLY valid JSON — no preamble, no explanation outside the JSON:
{
  "change_acknowledged": true | false,
  "change_applied_correctly": true | false | null,
  "no_unintended_changes": true | false | null,
  "appropriate_caveats": true | false | null,
  "specific_enough": true | false | null,
  "flags": ["list specific problems — be precise about what was wrong or missing"],
  "score": 0,
  "score_rationale": "one sentence explaining the score"
}`;
}

function buildUpdateGroundTruthBlock(gt) {
  if (!gt) return "No specific expectations defined.";
  const lines = [];
  if (gt.must_include) lines.push(`- Response MUST include: ${gt.must_include.join("; ")}`);
  if (gt.must_not_include) lines.push(`- Response MUST NOT include: ${gt.must_not_include.join("; ")}`);
  if (gt.expected_change) lines.push(`- Expected change: ${gt.expected_change}`);
  if (gt.change_scope) lines.push(`- Scope of change: ${gt.change_scope}`);
  if (gt.tradeoff_to_flag) lines.push(`- Tradeoff Dean should note: ${gt.tradeoff_to_flag}`);
  if (gt.notes) lines.push(`- Evaluator note: ${gt.notes}`);
  return lines.join("\n");
}
