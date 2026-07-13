/**
 * Race-countdown / taper-protocol / post-race section of the DATE CONTEXT block
 * (coach/respond/route.ts's buildSystemPrompt). Second slice of the CoachContext
 * extraction (see coach-date-context.ts for the first slice and CHANGELOG for the
 * bug that motivated it) — this is the part explicitly deferred from that first
 * slice as "more entangled with profile/race state."
 *
 * Covers three independent sections, each appended to the DATE CONTEXT text:
 *  1. Race countdown + code-computed taper protocol (rules-based volume targets
 *     by race type and days-out, so Claude states a specific weekly target
 *     instead of improvising one).
 *  2. B/C race context — secondary races, with tune-up guidance when close.
 *  3. Post-race recovery context — fires for up to 6 weeks after the goal race
 *     date has passed, so the coach doesn't keep treating a finished race as
 *     upcoming.
 *
 * `profileRaceDaysUntil` is computed by the caller (route.ts) and passed in
 * rather than recomputed here, since that value is also needed elsewhere in
 * buildSystemPrompt well after this block (fitness-tier gating, the ATHLETE
 * snapshot's race line, phase/taper detection) — keeping it a single
 * caller-owned value avoids two independent computations of "days until race"
 * silently drifting apart.
 */

import { formatGoalLabel } from "./goal-labels";

export interface UpcomingRaceInput {
  priority?: string | null;
  race_date: string;
  race_name?: string | null;
  goal?: string | null;
}

export interface RaceContextParams {
  now: Date;
  /** profile?.race_date */
  raceDate: string | null;
  /** profile?.goal */
  goal: string | null;
  /** Pre-computed by the caller — see module doc. */
  profileRaceDaysUntil: number | null;
  avgWeeklyMileage: number | null;
  /** state?.taper_peak_miles — locks in the taper's peak-volume reference once set. */
  storedTaperPeakMiles: number | null;
  upcomingRaces: UpcomingRaceInput[] | null | undefined;
  /** onboarding_data.race_name — preferred display name for the post-race recovery section. */
  onboardingRaceName: string | null;
  isMetric: boolean;
}

/** Builds the race-countdown/taper-protocol text appended after the DATE CONTEXT header. */
function buildTaperSection(params: RaceContextParams, spMi: (miles: number) => string): string {
  const { raceDate, goal, profileRaceDaysUntil, avgWeeklyMileage, storedTaperPeakMiles } = params;
  if (!raceDate || profileRaceDaysUntil === null || profileRaceDaysUntil <= 0) return "";

  const daysUntil = profileRaceDaysUntil;
  const weeksUntil = Math.round(daysUntil / 7);
  let text = `- Race date: ${raceDate} (${daysUntil} days / ~${weeksUntil} weeks away)\n`;
  text += `- Plan backwards from race date: allocate taper (2 weeks), peak (2-3 weeks), build, and base phases\n`;

  // Inject a code-computed taper plan when 21 days or fewer remain. Use the stored
  // taper_peak_miles if available — this locks in the peak on first entry so targets
  // don't shift as avgWeeklyMileage fluctuates between messages. If not yet stored,
  // use avgWeeklyMileage (the caller persists it as a side-effect elsewhere).
  if (daysUntil > 21 || !avgWeeklyMileage || avgWeeklyMileage <= 0) return text;

  const peak = storedTaperPeakMiles ?? Math.round(avgWeeklyMileage * 10) / 10;
  const isUltra = ["50k", "100k", "50mi", "100mi"].includes(goal ?? "");
  const is30k = goal === "30k";
  const isMarathon = goal === "marathon";
  const isHalf = goal === "half_marathon";
  const isMile = goal === "mile";

  // Mile PR is a track/time-trial event — no traditional 3-week taper. Within 7 days:
  // cut volume ~30%, keep intensity, one short tune-up effort. No action 8-21 days out.
  if (isMile) {
    if (daysUntil <= 7) {
      text += `- MILE SHARPENING WEEK: Time trial is ${daysUntil} days away. Cut total volume ~30% this week — keep one short speed session (4-6x400m @ mile effort), drop everything else to easy. No heavy quality work in the final 48 hours before the time trial.\n`;
    }
    return text;
  }

  // Volume percentages by race type and taper stage. 30K (~18.6 mi) is a trail race
  // closer to marathon distance than to 5K/10K — give it marathon-style taper rather
  // than the short-race defaults. w1Pct = race week training miles only (pre-race),
  // intentionally low — the race itself adds a major distance on top of that.
  let w3Pct = 0.88, w2Pct = 0.72, w1Pct = 0.25;
  if (isUltra) { w3Pct = 0.78; w2Pct = 0.62; w1Pct = 0.25; }
  else if (isMarathon || is30k) { w3Pct = 0.88; w2Pct = 0.72; w1Pct = 0.25; }
  else if (isHalf) { w3Pct = 0.90; w2Pct = 0.75; w1Pct = 0.28; }
  else { w3Pct = 0.90; w2Pct = 0.78; w1Pct = 0.35; } // 5K/10K

  const w3 = Math.round(peak * w3Pct);
  const w2 = Math.round(peak * w2Pct);
  const w1 = Math.round(peak * w1Pct);

  if (daysUntil > 14) {
    text += `- TAPER PROTOCOL (rules-based — follow exactly): Peak volume ~${spMi(peak)}. This week (3 weeks out): ${spMi(w3)} total. Next week (2 weeks out): ${spMi(w2)} total. Race week: ${spMi(w1)} total. No quality sessions in race week — easy miles only. One short race-pace tune-up (${spMi(2.5)} @ goal pace) allowed 10-12 days out.\n`;
  } else if (daysUntil > 7) {
    text += `- TAPER PROTOCOL (rules-based — follow exactly): Peak volume ~${spMi(peak)}. This week (2 weeks out): ${spMi(w2)} total. Race week: ${spMi(w1)} total. No quality sessions in race week — easy miles only. One short race-pace tune-up (${spMi(2.5)} @ goal pace) is acceptable this week.\n`;
  } else {
    text += `- TAPER PROTOCOL (rules-based — follow exactly): Peak volume ~${spMi(peak)}. Race week: ${spMi(w1)} total. Easy miles only — no hard workouts. Shakeout run (15-30 min easy) the day before is optional — place it ONLY on a confirmed running day (check athlete's training days). Do NOT schedule the shakeout on a gym-only, cross-training-only, or rest day.\n`;
  }

  return text;
}

/** B/C race context: list upcoming secondary races, inject coaching guidance when close. */
function buildSecondaryRaceSection(params: RaceContextParams): string {
  const nonARaces = (params.upcomingRaces ?? []).filter((r) => r.priority === "B" || r.priority === "C");
  let text = "";
  for (const race of nonARaces) {
    const bRaceDate = new Date(race.race_date + "T12:00:00Z");
    const daysUntilBRace = Math.ceil((bRaceDate.getTime() - params.now.getTime()) / (24 * 60 * 60 * 1000));
    const weeksUntilBRace = Math.round(daysUntilBRace / 7);
    const bRaceLabel = race.race_name ?? (race.goal ? formatGoalLabel(race.goal) : "race");
    if (race.priority === "B") {
      text += daysUntilBRace <= 14
        ? `- B RACE (tune-up): ${bRaceLabel} on ${race.race_date} (${daysUntilBRace} days away). Reduce total volume 10-15% this week. Race at a strong controlled effort — this is a tune-up, not an all-out peak. Resume normal training 2-3 days after.\n`
        : `- Upcoming B race (tune-up): ${bRaceLabel} on ${race.race_date} (~${weeksUntilBRace} weeks away). Keep in mind when scheduling hard sessions — leave a light day or two before it.\n`;
    } else {
      text += daysUntilBRace <= 7
        ? `- C RACE (for-fun): ${bRaceLabel} on ${race.race_date} (${daysUntilBRace} days away). No taper — treat it as a quality workout day. Normal training week otherwise.\n`
        : `- Upcoming C race (for-fun/workout): ${bRaceLabel} on ${race.race_date} (~${weeksUntilBRace} weeks away).\n`;
    }
  }
  return text;
}

/**
 * Post-race recovery context: fires when the athlete's goal race passed within the
 * last 6 weeks. Tells Dean the race is done, gives recovery guidance, and opens the
 * door to next-goal conversation — without requiring any new trigger or flow.
 */
function buildPostRaceSection(params: RaceContextParams): string {
  const { raceDate, goal, profileRaceDaysUntil, onboardingRaceName } = params;
  if (!raceDate || profileRaceDaysUntil === null || profileRaceDaysUntil > 0 || profileRaceDaysUntil < -42) return "";

  const daysSinceRace = Math.abs(profileRaceDaysUntil);
  const raceNameForContext = onboardingRaceName ?? (goal ? formatGoalLabel(goal) : "their goal race");
  let recoveryGuidance: string;
  if (daysSinceRace <= 7) {
    recoveryGuidance = `Week 1 post-race: easy running only. No tempo, intervals, or quality sessions. Keep efforts short and comfortable — this is active recovery, not training. Celebrate what they accomplished.`;
  } else if (daysSinceRace <= 14) {
    recoveryGuidance = `Week 2 post-race: reduced volume (roughly 60–70% of normal). Easy running is fine. One light quality session (strides or very short tempo) is okay if they feel good, but don't push it.`;
  } else {
    recoveryGuidance = `Weeks 3–6 post-race: fairly normal training. Rebuild toward their usual volume and reintroduce quality sessions. Follow their lead on how they're feeling.`;
  }

  return `
POST-RACE CONTEXT:
This athlete completed their goal race — ${raceNameForContext} on ${raceDate} (${daysSinceRace} day${daysSinceRace === 1 ? "" : "s"} ago). The training plan they built with you led them to this race.
${recoveryGuidance}
Next goal: At the right moment, ask what's next — a new race, a fitness goal, or just maintaining. Don't force it; let the athlete bring it up or ask once naturally when they seem ready (typically week 2–3 post-race). When they share a new goal, handle it conversationally — update the plan from there without needing a full re-onboarding.
Do NOT reference the completed race as an upcoming event. Do NOT suggest taper, race-week, or race-prep protocols. The race is done.\n`;
}

/** Combines all three sections into the text appended after the DATE CONTEXT header. */
export function buildRaceContext(params: RaceContextParams): string {
  const spMi = (miles: number) => (params.isMetric ? `${(miles * 1.60934).toFixed(1)} km` : `${miles.toFixed(1)} mi`);
  return (
    buildTaperSection(params, spMi) +
    buildSecondaryRaceSection(params) +
    buildPostRaceSection(params)
  );
}
