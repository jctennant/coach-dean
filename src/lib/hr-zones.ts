/**
 * LTHR-based HR zone estimation and derivation.
 *
 * Uses race effort duration as the primary signal for LTHR (Lactate Threshold
 * Heart Rate). Duration is a better independent variable than distance because
 * it controls for pace differences across fitness levels and race types.
 *
 * Correction logic:
 *   - 25–50 min race effort → avg HR ≈ LTHR (gold standard window)
 *   - 50–75 min           → avg HR slightly below LTHR, ×1.03 correction
 *   - 75–100 min          → ×1.06
 *   - 100–130 min (half+) → ×1.075
 *   - 130–180 min         → ×1.10 (low confidence — fueling/drift confound HR)
 *   - >180 min            → skip (marathon-length; too confounded to use)
 *
 * Zone table (LTHR-anchored, Friel model):
 *   Z1 Recovery     < LTHR × 0.81
 *   Z2 Aerobic Base   LTHR × 0.81–0.89  (below LT1)
 *   Z3 Tempo          LTHR × 0.90–0.95  (gray zone between LT1 and LT2)
 *   Z4 Threshold      LTHR × 0.96–1.00  (at LT2)
 *   Z5 VO2 Max      > LTHR
 */

export type LTHRSource = "race" | "manual" | "workout_detected";
export type LTHRConfidence = "high" | "medium" | "low";

export interface LTHREstimate {
  lthr: number;
  source: LTHRSource;
  confidence: LTHRConfidence;
}

export interface HRZones {
  z1_ceiling: number;
  z2_ceiling: number;
  z3_ceiling: number;
  z4_ceiling: number;
  z5_floor: number;
  lthr: number;
}

export interface ActivityForLTHR {
  workout_type: number | null;
  average_heartrate: number | null;
  moving_time_seconds: number | null;
  activity_name: string | null;
  start_date: string | null;
}

// Duration brackets: [minSec, maxSec), multiplier to correct avg HR → LTHR, confidence.
const DURATION_BRACKETS = [
  { min: 25 * 60, max: 50 * 60,  mult: 1.000, conf: "high"   as LTHRConfidence },
  { min: 50 * 60, max: 75 * 60,  mult: 1.030, conf: "high"   as LTHRConfidence },
  { min: 75 * 60, max: 100 * 60, mult: 1.060, conf: "medium" as LTHRConfidence },
  { min: 100 * 60, max: 130 * 60, mult: 1.075, conf: "medium" as LTHRConfidence },
  { min: 130 * 60, max: 180 * 60, mult: 1.100, conf: "low"   as LTHRConfidence },
];

const RACE_NAME_PATTERNS = /\b(race|marathon|5k|10k|half|hm|mile|miler|tri|triathlon|ironman)\b/i;

function isRaceActivity(a: ActivityForLTHR): boolean {
  if (a.workout_type === 1) return true;
  return RACE_NAME_PATTERNS.test(a.activity_name ?? "");
}

function getDurationBracket(movingTimeSec: number): { mult: number; conf: LTHRConfidence } | null {
  for (const b of DURATION_BRACKETS) {
    if (movingTimeSec >= b.min && movingTimeSec < b.max) {
      return { mult: b.mult, conf: b.conf };
    }
  }
  return null;
}

/**
 * Estimate LTHR from stored race activities.
 *
 * Returns null when no qualifying race efforts exist — callers fall back to
 * % max HR zones in that case.
 */
export function estimateLTHRFromRaces(
  activities: ActivityForLTHR[],
  estimatedMaxHR: number | null
): LTHREstimate | null {
  // Minimum plausible racing HR: 75% of estimated max, or absolute floor 120 bpm.
  const minRacingHR = estimatedMaxHR ? estimatedMaxHR * 0.75 : 120;

  const candidates: Array<{ lthrVote: number; conf: LTHRConfidence; date: string }> = [];

  for (const a of activities) {
    if (!isRaceActivity(a)) continue;
    const avgHR = a.average_heartrate;
    const movingSec = a.moving_time_seconds;
    if (!avgHR || !movingSec) continue;

    // Reject physiologically implausible readings
    if (avgHR > 210 || avgHR < 120) continue;
    // Reject low-effort tagged races (fun runs, easy paced events)
    if (avgHR < minRacingHR) continue;

    const bracket = getDurationBracket(movingSec);
    if (!bracket) continue;

    const lthrVote = Math.round(avgHR * bracket.mult);
    // Sanity-check computed LTHR
    if (lthrVote < 110 || lthrVote > 220) continue;

    candidates.push({ lthrVote, conf: bracket.conf, date: a.start_date ?? "" });
  }

  if (candidates.length === 0) return null;

  // Sort most recent first, take up to 3
  candidates.sort((a, b) => b.date.localeCompare(a.date));
  const top3 = candidates.slice(0, 3);

  // Within the top 3, discard any vote that deviates more than 10 bpm from the median
  const sorted = [...top3].map(c => c.lthrVote).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const filtered = top3.filter(c => Math.abs(c.lthrVote - median) <= 10);

  if (filtered.length === 0) return null;

  const filteredVotes = filtered.map(c => c.lthrVote).sort((a, b) => a - b);
  const lthr = filteredVotes[Math.floor(filteredVotes.length / 2)]!;

  // Overall confidence = best among filtered candidates
  const confidence: LTHRConfidence = filtered.some(c => c.conf === "high") ? "high"
    : filtered.some(c => c.conf === "medium") ? "medium" : "low";

  return { lthr, source: "race", confidence };
}

/** Derive Z1-Z5 absolute bpm ceilings from a known LTHR. */
export function deriveZones(lthr: number): HRZones {
  return {
    z1_ceiling: Math.round(lthr * 0.81),
    z2_ceiling: Math.round(lthr * 0.89),
    z3_ceiling: Math.round(lthr * 0.95),
    z4_ceiling: lthr,
    z5_floor: lthr,
    lthr,
  };
}

/**
 * Build the HR zone context block for the coaching system prompt.
 * Replaces the generic "% max HR" fallback text when LTHR is available.
 */
export function buildHRZoneContext(
  lthr: number,
  source: string,
  confidence: LTHRConfidence
): string {
  const z = deriveZones(lthr);
  const sourceLabel = source === "race" ? "race history" : source === "manual" ? "manual entry" : "training data";
  const lowConfNote = confidence === "low"
    ? `\n<rule>LTHR CONFIDENCE IS LOW: This estimate came from a long race effort (130–180 min) where fueling, terrain, and pacing strategy reduce HR accuracy. Mention this uncertainty naturally when referencing HR zones — e.g. "your zones are based on an estimate from a longer race, so they may be slightly off." Suggest they do a hard road 5K or 10K effort, or a 30-min field test at max sustainable pace, to sharpen the estimate. Do NOT refuse to use the zones — use them, but flag the caveat.\n\nDASHBOARD INTENSITY DOTS: Because LTHR confidence is low, the athlete's dashboard classifies run intensity using % of observed max HR instead of these LTHR-based boundaries. Max HR is estimated from their Strava history (race peaks preferred, then workout peaks, then all-runs — with spike filtering). Intensity thresholds: Easy = avg HR < 75% max, Moderate = 75–85%, Hard = >85%. This may produce different zone labels than the LTHR-based zones above — that's expected. If the athlete asks why some runs show as easy/moderate on the dashboard when they felt harder, explain that the estimate is coming from a long race and a shorter road race would sharpen it.</rule>`
    : "";
  return `HEART RATE ZONES (LTHR-based — threshold: ${lthr} bpm, estimated from ${sourceLabel}, confidence: ${confidence}):
- Z1 Recovery: < ${z.z1_ceiling} bpm — very easy, fully conversational; active recovery only, not a training stimulus
- Z2 Aerobic Base: ${z.z1_ceiling}–${z.z2_ceiling} bpm — easy, sustainable; THIS is where aerobic fitness is built (fat oxidation, cardiac efficiency, endurance foundation); most runs should land here
- Z3 Gray Zone: ${z.z2_ceiling + 1}–${z.z3_ceiling} bpm — comfortably hard; above aerobic threshold (LT1) but below lactate threshold (LT2); TOO hard to recover well, NOT hard enough to develop race pace — the "gray zone trap" most athletes drift into without realizing it
- Z4 Threshold: ${z.z3_ceiling + 1}–${z.z4_ceiling} bpm — uncomfortable, roughly 60-min race effort; builds lactate clearance and race-pace economy; reserve for quality sessions
- Z5 VO2 Max: > ${z.z5_floor} bpm — near-maximal; hard interval efforts only, not sustainable for more than a few minutes; sharpens top-end speed
When explaining HR zones to an athlete, always give the bpm number AND the plain-language meaning (e.g. "138 bpm — that's Z2, your aerobic base zone, where most of your easy miles should be"). Use zone names AND bpm values when discussing runs with HR data. For prescribing future sessions without HR monitors, use effort language (conversational, comfortably hard, at threshold). Never state raw percentages to the athlete.
<rule>LTHR GUARD: The threshold value above (${lthr} bpm) is a stored estimate computed from race history — it is NOT derived from the max_heartrate field in any activity JSON. The max_heartrate field in activity data is still a single-run peak reading only; do not use it to estimate or assert the athlete's max HR or threshold.</rule>${lowConfNote}`;
}

/**
 * Source label for display in the dashboard method badge.
 * e.g. "LTHR — from 10K race data" or "LTHR — from training efforts"
 */
export function lthrMethodLabel(source: LTHRSource): string {
  if (source === "race") return "LTHR — from race data";
  if (source === "manual") return "LTHR — manual entry";
  return "LTHR — from training efforts";
}
