/**
 * Judge prompt builder for Coach Dean eval harness.
 * Uses Claude Opus as the judge to evaluate factual accuracy of coaching responses.
 */

/**
 * Build the judge prompt for a given fixture + coach response.
 * Returns the full prompt string to pass to the judge model.
 */
export function buildJudgePrompt(fixture, coachResponse) {
  const { user, ground_truth, category } = fixture;
  const raceDate = user.goal_race_date;
  const today = fixture.today ?? "2026-03-30";
  const yesterday = getYesterday(today);

  // Compute days until race from the fixture's race date
  let daysUntilRace = null;
  if (raceDate) {
    const race = new Date(raceDate + "T12:00:00Z");
    const now = new Date(today + "T12:00:00Z");
    daysUntilRace = Math.ceil((race.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  }

  const recentConvBlock = user.recent_conversation && user.recent_conversation.length > 0
    ? `\nRECENT CONVERSATION (context the coach had access to):\n${user.recent_conversation.map(m => `  [${m.role}]: ${m.content}`).join("\n")}`
    : "";

  const recentActivitiesBlock = user.recent_activities && user.recent_activities.length > 0
    ? `\nRECENT ACTIVITIES (what the coach saw):\n${user.recent_activities.map(a => `  ${a.date} (${getDayOfWeek(a.date)}): ${a.type} ${a.distance_miles}mi @ ${a.pace || "unknown pace"}`).join("\n")}`
    : "";

  const contextSummary = `
ATHLETE CONTEXT (ground truth — these are authoritative):
- Name: ${user.name}
- Today's date: ${today} (${getDayOfWeek(today)})
- Yesterday's date: ${yesterday} (${getDayOfWeek(yesterday)})
- Training week: Week ${user.current_week}
- Phase: ${user.current_phase}
- Goal race: ${user.goal_race} on ${raceDate}${daysUntilRace !== null ? ` (${daysUntilRace} days away)` : ""}
- VDOT: ${user.vdot}
- Easy pace (stored): ${user.easy_pace} → display range: ${buildEasyRange(user.easy_pace)}
- Tempo pace (stored): ${user.tempo_pace}
- Interval pace (stored): ${user.interval_pace}
- Weekly mileage target: ${user.weekly_mileage_target} mi
- Miles logged this week (authoritative): ${user.miles_logged_this_week} mi
- Runs this week: ${user.runs_this_week}
- Is deload week: ${user.is_deload_week || (user.current_week % 4 === 0) ? "YES" : "no"}
${user.plan_sessions_remaining ? `- Remaining sessions: ${user.plan_sessions_remaining.map(s => s.label).join(", ")}` : ""}
${user.activity_details ? buildActivityGroundTruth(user.activity_details) : ""}${recentActivitiesBlock}${recentConvBlock}
GROUND TRUTH EXPECTATIONS:
${buildGroundTruthBlock(ground_truth)}
`.trim();

  return `You are evaluating a coaching response from "Coach Dean", an AI running coach that communicates via SMS.

${contextSummary}

COACH DEAN'S RESPONSE:
"""
${coachResponse}
"""

Evaluate this response on the dimensions below. Return ONLY valid JSON — no preamble, no explanation outside the JSON.

EVALUATION CRITERIA:
1. mileage_correct: Is any weekly mileage figure stated in the response accurate?
   - true = mileage is correct or not mentioned
   - false = wrong number stated
   - null = mileage not referenced at all

2. pace_correct: Is any pace figure stated accurate for this athlete's VDOT?
   - true = paces match stored values (within ~5 sec/mi)
   - false = wrong pace stated (e.g. tempo slower than easy, wrong VDOT value)
   - null = no pace mentioned

3. distance_plausible: For split-based evals, are mile references valid?
   - true = all mile references ≤ run distance, or no mile numbers mentioned
   - false = mile numbers stated that exceed run distance (e.g. "mile 5" on a 3.1mi run)
   - null = not a split-based eval

4. date_week_correct: Is the week number, phase name, and days-to-race accurate?
   - true = correct week number and phase used, or not mentioned
   - false = wrong week number or phase stated
   - null = not referenced

5. format_correct: Does the response avoid the "additive total" anti-pattern?
   - true = no "Total: X mi + your Y mi already" format used, or no total mentioned
   - false = uses confusing additive format that mixes planned and completed miles
   - null = no mileage total in response

6. no_internal_labels: Does the response avoid echoing ⚠️-prefixed system directives?
   - true = no internal labels leaked (or none expected to be tested)
   - false = response contains "⚠️", "GOAL DISCREPANCY DETECTED", "RECOVERY WEEK" as a header, or similar internal labels

7. temporal_reference_correct: Are references to past activities and days accurate?
   - true = any mention of "yesterday", "Monday", "Wednesday", etc. correctly matches the actual activity dates shown above; or no temporal references
   - false = response says an activity happened on the wrong day (e.g. "from Monday" when the run was Wednesday/yesterday), or uses a forbidden phrase listed in ground truth
   - null = no temporal references to past activities

SCORE RUBRIC:
- 10: All facts correct, response is natural, on-brand, appropriately brief
- 7-9: Minor issues (slightly off wording, not optimally brief) but no factual errors
- 4-6: One factual error (wrong mileage by >10%, wrong pace by >30 sec/mi, wrong week number)
- 1-3: Multiple errors or a serious hallucination (mile 5 on a 3mi run, tempo pace slower than easy)
- 0: Response is completely wrong or incoherent

Return exactly this JSON structure:
{
  "mileage_correct": true | false | null,
  "mileage_stated": "single string — combine multiple mileage quotes with semicolons if needed, e.g. '15mi done; 20mi remaining'; or null if not mentioned",
  "pace_correct": true | false | null,
  "pace_stated": "single string — the pace value(s) stated, e.g. '7:13/mi tempo'; or null if not mentioned",
  "distance_plausible": true | false | null,
  "date_week_correct": true | false | null,
  "format_correct": true | false | null,
  "no_internal_labels": true | false,
  "temporal_reference_correct": true | false | null,
  "flags": ["list any specific factual errors — be precise, cite the exact wrong value"],
  "score": 0,
  "score_rationale": "one sentence explaining the score"
}`;
}

function getDayOfWeek(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getUTCDay()];
}

function getYesterday(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function buildEasyRange(paceStr) {
  if (!paceStr) return "TBD";
  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return paceStr;
  const totalSec = parseInt(match[1]) * 60 + parseInt(match[2]);
  const rounded = Math.round(totalSec / 5) * 5;
  const upper = rounded + 30;
  const fmt = (s) => {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
  };
  return `${fmt(rounded)}–${fmt(upper)}/mi`;
}

function buildActivityGroundTruth(activity) {
  let out = `- Activity synced: ${activity.type}, ${activity.distance_miles}mi @ ${activity.pace || "unknown pace"}\n`;
  if (activity.splits_km) {
    out += `- Split count: ${activity.splits_km.length} km splits (NOT mile splits)\n`;
    out += `- Max valid mile reference: ${activity.distance_miles.toFixed(1)} miles\n`;
    out += `- Cumulative miles at last split: ${activity.splits_km[activity.splits_km.length - 1].cumulative_miles.toFixed(2)}\n`;
  }
  return out;
}

function buildGroundTruthBlock(gt) {
  if (!gt) return "No specific ground truth expectations.";
  const lines = [];
  if (gt.correct_weekly_mileage_target != null) lines.push(`- Correct weekly target: ${gt.correct_weekly_mileage_target} mi`);
  if (gt.prior_week_total != null) lines.push(`- Prior week actual total (from Strava activities): ${gt.prior_week_total} mi — this is a verified figure, not fabricated`);
  if (gt.next_week_number != null) lines.push(`- Next week number (correct for this recap): week ${gt.next_week_number}`);
  if (gt.next_week_target_approx != null) lines.push(`- Next week target (approximate): ~${gt.next_week_target_approx} mi`);
  if (gt.this_week_completed != null) lines.push(`- This week completed: ${gt.this_week_completed} mi`);
  if (gt.miles_logged_this_week != null) lines.push(`- Miles logged this week: ${gt.miles_logged_this_week} mi`);
  if (gt.miles_remaining != null) lines.push(`- Miles remaining: ${gt.miles_remaining} mi`);
  if (gt.correct_tempo_pace) lines.push(`- Correct tempo pace: ${gt.correct_tempo_pace}`);
  if (gt.correct_easy_pace_range) lines.push(`- Correct easy pace range: ${gt.correct_easy_pace_range}`);
  if (gt.correct_interval_pace) lines.push(`- Correct interval pace: ${gt.correct_interval_pace}`);
  if (gt.max_valid_mile_reference != null) lines.push(`- Max valid mile reference: mile ${gt.max_valid_mile_reference} (run was ${gt.run_distance_miles}mi)`);
  if (gt.correct_week_number != null) lines.push(`- Correct week number: ${gt.correct_week_number}`);
  if (gt.correct_phase) lines.push(`- Correct phase: ${gt.correct_phase}`);
  if (gt.days_until_race != null) lines.push(`- Days until race: ${gt.days_until_race}`);
  if (gt.is_deload_week) lines.push(`- This IS a deload/recovery week`);
  if (gt.miles_already_done != null) lines.push(`- Miles already done this week: ${gt.miles_already_done}`);
  if (gt.planned_sessions_miles != null) lines.push(`- Planned future sessions sum to: ${gt.planned_sessions_miles} mi`);
  if (gt.forbidden_phrases) lines.push(`- FORBIDDEN phrases in response: ${gt.forbidden_phrases.join(", ")}`);
  if (gt.forbidden_content) lines.push(`- FORBIDDEN content in response: ${gt.forbidden_content.join(", ")}`);
  if (gt.must_contain_tag) lines.push(`- REQUIRED TAG: Response MUST end with ${gt.must_contain_tag} (after the coaching message text). If this tag is absent: score 0.`);
  if (gt.forbidden_tags) lines.push(`- FORBIDDEN TAGS (must NOT appear): ${gt.forbidden_tags.join(", ")}. If any forbidden tag appears: score 0.`);
  if (gt.notes) lines.push(`- Evaluator note: ${gt.notes}`);
  return lines.join("\n");
}
