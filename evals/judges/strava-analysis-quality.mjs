/**
 * Judge prompt builder for Strava analysis eval harness.
 * Evaluates the quality of Dean's post-Strava synthesis message.
 */

export function buildStravaAnalysisJudgePrompt(fixture, deanResponse) {
  const { athlete, strava, ground_truth } = fixture;

  const stravaLines = [
    `Avg weekly miles: ${strava.avg_weekly_miles} mi/week (${strava.mileage_trend})`,
    `Runs/week: ${strava.avg_runs_per_week}`,
    `Longest run: ${strava.longest_run_miles} mi`,
    strava.avg_elev_ft_per_run ? `Avg elevation/run: ${strava.avg_elev_ft_per_run} ft` : `Avg elevation/run: none (no elevation data)`,
    `Weekly miles (most-recent first): [${strava.recent_4_weeks.join(", ")}]`,
  ];
  if (strava.hr_zone_pct) {
    const z = strava.hr_zone_pct;
    stravaLines.push(`HR zones: Z1 ${z.z1}%, Z2 ${z.z2}%, Z3 ${z.z3}%, Z4 ${z.z4}%, Z5 ${z.z5}%`);
  }
  if (strava.estimated_max_hr) stravaLines.push(`Est. max HR: ${strava.estimated_max_hr} bpm`);
  if (strava.max_weekly_spike_pct) stravaLines.push(`Mileage spike: ${strava.max_weekly_spike_pct}% largest week-over-week jump`);
  if (strava.best_race) stravaLines.push(`Best race: ${strava.best_race.label}`);

  return `You are evaluating a post-Strava synthesis message from "Coach Dean", an AI running coach.

ATHLETE:
- Name: ${athlete.name}
- Goal: ${athlete.goal.replace(/_/g, " ")}
- Race: ${athlete.race_name ?? "none"} on ${athlete.race_date ?? "no date"} (${athlete.weeks_until_race} weeks away)

STRAVA DATA DEAN CAN SEE:
${stravaLines.join("\n")}

DEAN'S RESPONSE TO EVALUATE:
"""
${deanResponse}
"""

EVALUATION CRITERIA:

1. uses_specific_numbers: Does Dean reference actual numbers from the Strava data?
   - true = cites at least 2 specific numbers (e.g., "32 miles/week", "60% Z3", "18-mile long run")
   - false = vague references only ("consistent mileage", "mostly easy effort")

2. race_connected: Is the analysis connected to THIS specific race and timeline?
   - true = mentions the race name OR the number of weeks OR what THIS race demands
   - false = generic coaching advice that could apply to any athlete

3. names_the_problem: Does Dean identify the most important issue in the data?
   - true = calls out the central coaching concern clearly and specifically
   - false = only describes the data, or focuses on positives while glossing over the problem
   - The central issue varies by fixture — use the evaluator notes below

4. no_banned_phrases: Does Dean avoid generic filler phrases?
   - true = none of these appear: "solid base", "great foundation", "exciting", "strong work", "keep it up", "looking good", "great consistency", "impressive"
   - false = one or more appear

5. closes_with_injury_question: Does the response end with the injury question?
   - true = ends with something close to "Has injury ever been a factor for you, or anything you're managing right now?"
   - false = missing the injury question, or it's buried in the middle

SCORE RUBRIC:
- 10: All 5 criteria pass — specific, race-connected, names the problem, no filler, closes correctly
- 7-9: 4 criteria pass — good synthesis but one gap (e.g., a specific number missing, or slightly vague on the problem)
- 4-6: 3 criteria pass — partial synthesis, problem either not named or named but vaguely
- 1-3: Multiple failures — data recap without interpretation, generic advice, missing injury question
- 0: Completely wrong — injury question missing AND no meaningful synthesis

EVALUATOR NOTES FROM FIXTURE (what the central coaching issue is):
${ground_truth?.notes || "None."}

Return ONLY valid JSON — no preamble:
{
  "uses_specific_numbers": true | false,
  "race_connected": true | false,
  "names_the_problem": true | false,
  "no_banned_phrases": true | false,
  "closes_with_injury_question": true | false,
  "flags": ["list any specific failures with exact quoted text"],
  "score": 0,
  "score_rationale": "one sentence"
}`;
}
