/**
 * Judge prompt builder for plan quality evals.
 * Used when fixture.category === "plan_quality".
 *
 * Unlike the factual-accuracy judge (which checks stated values against ground truth),
 * this judge evaluates whether the training plan structure is appropriate for the
 * athlete's current fitness, goal race, and experience level.
 */

export function buildPlanJudgePrompt(fixture, coachResponse) {
  const { user, ground_truth } = fixture;

  const useMetric = user.preferred_units === "metric";
  const weeklyBase = useMetric
    ? `${(user.current_weekly_miles * 1.60934).toFixed(0)} km/week (${user.current_weekly_miles} mi internally)`
    : `${user.current_weekly_miles} mi/week`;

  const contextSummary = `
ATHLETE PROFILE (authoritative — do not second-guess these):
- Name: ${user.name}
- Goal race: ${user.goal_race} on ${user.goal_race_date}
- Goal race distance: ${user.goal_race_distance}
- Current weekly volume (recent average): ${weeklyBase}
- Training days per week: ${user.training_days.length} (${user.training_days.join(", ")})
- Experience level: ${user.experience_level}
- VDOT: ${user.vdot} (easy ${user.easy_pace}, tempo ${user.tempo_pace}, interval ${user.interval_pace})
- Preferred units: ${user.preferred_units || "imperial"}${useMetric ? " — ALL distances in the plan response must be in km, ALL paces in min/km" : ""}
- Weeks until race: ${user.weeks_until_race}
- Notes: ${user.notes || "None"}

PLAN QUALITY EXPECTATIONS (ground truth):
${buildPlanGroundTruthBlock(ground_truth, useMetric)}
`.trim();

  return `You are evaluating a training plan produced by "Coach Dean", an AI running coach.

${contextSummary}

COACH DEAN'S PLAN RESPONSE:
"""
${coachResponse}
"""

Evaluate whether this plan is appropriate for this specific athlete. Focus on structure and safety, not prose quality.

EVALUATION DIMENSIONS:

1. week1_volume_appropriate
   Does Week 1 total mileage stay within a safe range of the athlete's current base?
   - true = Week 1 is within ~20% above current weekly mileage (a reasonable ramp)
   - false = Week 1 jumps more than ~25% above current base, or is implausibly low

2. peak_volume_appropriate
   Is the projected peak week mileage sensible for the goal race and athlete experience?
   - true = peak is within the expected range for goal distance / experience level
   - false = peak is wildly too high (overtraining a beginner) or too low (won't prepare them)
   - null = no peak week mileage stated

3. sessions_per_week_correct
   Does the plan schedule the right number of sessions per week?
   - true = number of running DAYS matches the athlete's stated training days (${user.training_days.length} days)
   - false = more or fewer days scheduled than the stated training days
   - null = number of sessions unclear from response
   NOTE: Count DAYS, not workout types. A single session described as "tempo + strides" or "intervals then easy cooldown" is still ONE session on ONE day. A peak week with "one tempo day, one interval day, one long run day" = 3 sessions for a 3-day athlete.

4. long_run_appropriate
   Is the longest run (or long run target) appropriate for the goal race?
   - true = long run distance is calibrated for the race distance and athlete fitness
   - false = long run is dangerously long for a short race (e.g. 16mi for a 5k beginner), or
             too short to prepare for a long race (e.g. 10mi peak for a marathon)
   - null = no long run distance specified

5. quality_sessions_appropriate
   Are the types of hard/quality sessions right for the goal race?
   - true = quality work matches race demands (e.g. intervals for 5k, marathon-pace work for marathon)
   - false = missing the key quality sessions for the goal race, OR prescribing the wrong type
             (e.g. 5k plan with no speed work, marathon plan with only easy miles)
   - null = no quality sessions described

6. progression_safe
   Does the plan avoid dangerous volume spikes?
   - true = week-to-week increases appear gradual and reasonable (≤10-15% per step)
   - false = a non-deload week jumps >20% above the previous non-deload week
   - null = not enough week-by-week detail to assess
   IMPORTANT: Every 4th week is a deliberate deload (~70% of prior week). A drop followed
   by a rebound after a deload week is NORMAL and expected — compare the post-deload week
   to the pre-deload week (not the deload week itself). E.g. W3→W4(deload)→W5 going
   20mi→14mi→22mi is safe (W3→W5 is +10%). Do NOT flag deload rebounds as unsafe.

${useMetric ? `7. uses_correct_units
   Does the plan use km (not miles) for ALL distance references and min/km (not min/mi) for ALL pace references?
   - true = every distance uses km (e.g. "9 km", "18 km"), every pace uses /km — no "mi" or "/mi" anywhere
   - false = ANY distance appears in miles or ANY pace appears as /mi — even once
   - This is a binary check: one stray "mi" = false
   NOTE: Ground truth volume bounds are stored in miles internally. When the judge says "Week 1 MUST NOT exceed X mi", interpret "X mi" as the limit — but verify that the plan itself states the value in km. E.g. if the limit is 42 mi (~68 km) and the plan says "Week 1: 65 km", that passes both the volume check AND the unit check.

` : ""}SCORE RUBRIC:
- 10: Plan is well-calibrated — right volume, right session types, safe progression, long run appropriate${useMetric ? ", correct km units throughout" : ""}
- 7-9: Mostly sound with minor issues (slightly aggressive week 1, one session type missing${useMetric ? ", minor unit slip" : ""})
- 4-6: One significant structural problem (long run too long, peak volume inappropriate, wrong quality work${useMetric ? ", uses miles instead of km" : ""})
- 1-3: Multiple serious problems or fundamentally wrong for athlete level/goal
- 0: Plan is nonsensical or completely inappropriate
${useMetric ? "\nIMPORTANT: Using miles instead of km for a metric-preference athlete is a significant failure — deduct at least 3 points and add 'wrong_units_used' to flags." : ""}

Return ONLY valid JSON — no preamble, no explanation outside the JSON:
{
  "week1_volume_appropriate": true | false,
  "week1_volume_stated": "the week 1 total volume as stated in the response, e.g. '55 km' or '18 mi' — or null if not stated",
  "peak_volume_appropriate": true | false | null,
  "peak_volume_stated": "peak week volume as stated in the response, e.g. '80 km' or '45 mi' — or null if not stated",
  "sessions_per_week_correct": true | false | null,
  "sessions_stated": "number of sessions per week as stated, e.g. '4' — or null if unclear",
  "long_run_appropriate": true | false | null,
  "long_run_stated": "longest run distance as stated in the response, e.g. '22 km' or '14 mi' — or null if not stated",
  "quality_sessions_appropriate": true | false | null,
  "quality_sessions_stated": ["list the quality session types mentioned, e.g. 'interval 400m reps', 'tempo 8 km'"],${useMetric ? `
  "uses_correct_units": true | false,
  "unit_violations_found": ["list any distances or paces that appeared in miles/mi — e.g. '8 mi easy run', '9:08/mi' — empty array if none"],` : ""}
  "flags": ["list specific structural problems — be precise, cite the exact wrong value or missing element"],
  "score": 0,
  "score_rationale": "one sentence explaining the score"
}`;
}

function buildPlanGroundTruthBlock(gt, useMetric = false) {
  if (!gt) return "No specific ground truth expectations.";
  const fmt = (miles) => useMetric ? `${(miles * 1.60934).toFixed(0)} km (${miles} mi)` : `${miles} mi`;
  const lines = [];
  if (gt.max_week1_miles != null) lines.push(`- Week 1 MUST NOT exceed: ${fmt(gt.max_week1_miles)}`);
  if (gt.min_week1_miles != null) lines.push(`- Week 1 should be at least: ${fmt(gt.min_week1_miles)}`);
  if (gt.max_peak_weekly_miles != null) lines.push(`- Peak week MUST NOT exceed: ${fmt(gt.max_peak_weekly_miles)}`);
  if (gt.min_peak_weekly_miles != null) lines.push(`- Peak week should reach at least: ${fmt(gt.min_peak_weekly_miles)}`);
  if (gt.max_long_run_miles != null) lines.push(`- Longest run MUST NOT exceed: ${fmt(gt.max_long_run_miles)}`);
  if (gt.min_long_run_miles != null) lines.push(`- Longest run should reach at least: ${fmt(gt.min_long_run_miles)}`);
  if (gt.sessions_per_week != null) lines.push(`- Sessions per week should be: ${gt.sessions_per_week} (matches training days)`);
  if (gt.required_session_types) lines.push(`- Plan MUST include these session types: ${gt.required_session_types.join(", ")}`);
  if (gt.must_use_metric) lines.push(`- UNIT REQUIREMENT: All distances must appear in km, all paces in min/km. Using miles is a critical failure.`);
  if (gt.forbidden_content) lines.push(`- Plan MUST NOT include: ${gt.forbidden_content.join("; ")}`);
  if (gt.notes) lines.push(`- Evaluator note: ${gt.notes}`);
  return lines.join("\n");
}
