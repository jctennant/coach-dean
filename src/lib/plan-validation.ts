/**
 * Post-generation plan validation and correction utilities.
 *
 * These functions operate on the raw text output from Claude and enforce
 * hard safety limits that are too important to leave to prompt instructions alone.
 *
 * All functions are pure (no side effects) so they're easy to unit test.
 */

// Matches lines like "Mon 3/2 · Easy 5mi @ 9:30/mi" or "Sat 3/28 · Long run 9mi"
const SESSION_LINE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d+\/\d+\s+·\s+(.+)$/m;
const SESSION_LINE_GLOBAL_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d+\/\d+\s+·\s+(.+)$/gm;

// Matches the first mileage figure in a session description (e.g. "5" from "Easy 5mi").
// (?!n) prevents matching "min" (e.g. "35 min" in strength sessions must not count as 35 miles).
const FIRST_MI_RE = /(\d+(?:\.\d+)?)\s*mi(?!n)/i;

interface SessionLine {
  fullLine: string; // the entire matched line
  desc: string;     // the part after "DDD D/M · "
  miles: number;    // extracted mileage (0 if non-running session)
}

// Cross-training keywords — sessions containing these are never counted as running miles,
// even if they somehow contain a "Xmi" marker (e.g. "Easy bike 20mi" violating the prompt).
const CROSS_TRAINING_RE = /\b(bike|biking|cycling|swim|swimming|strength|mobility|stretch|yoga|elliptical|cross.train|zwift|spin)\b/i;

/**
 * Parse all session lines from a plan response.
 * Running sessions have an explicit "Xmi" marker; non-running sessions (strength,
 * cross-training, HIIT, etc.) do not. Cross-training sessions are always 0 miles
 * even if they contain a distance marker.
 */
export function parseSessionLines(message: string): SessionLine[] {
  const results: SessionLine[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(SESSION_LINE_GLOBAL_RE.source, "gm");
  while ((m = re.exec(message)) !== null) {
    const fullLine = m[0];
    const desc = m[2];
    // Only treat as cross-training (0 miles) if the cross-training keyword appears
    // before the first mileage marker. This correctly handles hybrid sessions like
    // "Easy 4mi + Strength" (run first → counts) vs "Easy bike 20mi" (keyword first → 0).
    const crossMatch = CROSS_TRAINING_RE.exec(desc);
    const miMatch = FIRST_MI_RE.exec(desc);
    const isCrossTraining = crossMatch !== null && (miMatch === null || crossMatch.index < miMatch.index);
    results.push({
      fullLine,
      desc,
      miles: !isCrossTraining && miMatch ? parseFloat(miMatch[1]) : 0,
    });
  }
  return results;
}

export interface VolumeCapResult {
  /** Whether any cap was violated */
  violated: boolean;
  /** Total planned running miles found in the message */
  totalMiles: number;
  /** Highest single-session mileage found */
  maxSessionMiles: number;
  /** The corrected message (same as input if no violation) */
  message: string;
}

/**
 * Enforce weekly volume and long-run caps on a generated plan.
 *
 * If the plan's total running mileage exceeds `weeklyCapMiles`, all running
 * session distances are scaled down proportionally. If any single session
 * exceeds `longRunCapMiles`, it is capped first (before the scaling pass).
 *
 * The caps are applied only when the athlete is in the LOW VOLUME tier
 * (avgWeeklyMileage < 10 mi/week). Pass null for either cap to skip that check.
 *
 * After correction, the stated weekly total in the text (e.g. "Total: 18 mi")
 * is rewritten to match the new session sum, mirroring what correctMileageTotal does.
 */
export function enforceVolumeCaps(
  message: string,
  weeklyCapMiles: number | null,
  longRunCapMiles: number | null
): VolumeCapResult {
  if (weeklyCapMiles == null && longRunCapMiles == null) {
    return { violated: false, totalMiles: 0, maxSessionMiles: 0, message };
  }

  const sessions = parseSessionLines(message);
  const runningSessions = sessions.filter((s) => s.miles > 0);

  if (runningSessions.length === 0) {
    return { violated: false, totalMiles: 0, maxSessionMiles: 0, message };
  }

  const originalTotal = runningSessions.reduce((sum, s) => sum + s.miles, 0);
  const originalMax = Math.max(...runningSessions.map((s) => s.miles));

  const weeklyViolated =
    weeklyCapMiles != null && originalTotal > weeklyCapMiles + 0.4;
  const longRunViolated =
    longRunCapMiles != null && originalMax > longRunCapMiles + 0.4;

  if (!weeklyViolated && !longRunViolated) {
    return {
      violated: false,
      totalMiles: originalTotal,
      maxSessionMiles: originalMax,
      message,
    };
  }

  console.warn(
    `[enforceVolumeCaps] violation detected — total: ${originalTotal.toFixed(1)}mi (cap: ${weeklyCapMiles ?? "n/a"}mi), ` +
      `max session: ${originalMax.toFixed(1)}mi (cap: ${longRunCapMiles ?? "n/a"}mi)`
  );

  // Work on a mutable copy of sessions
  const adjusted = runningSessions.map((s) => ({ ...s, newMiles: s.miles }));

  // Pass 1: cap individual long runs
  if (longRunCapMiles != null) {
    for (const s of adjusted) {
      if (s.newMiles > longRunCapMiles) {
        s.newMiles = longRunCapMiles;
      }
    }
  }

  // Pass 2: if total still exceeds weekly cap, scale proportionally
  const afterPass1Total = adjusted.reduce((sum, s) => sum + s.newMiles, 0);
  if (weeklyCapMiles != null && afterPass1Total > weeklyCapMiles + 0.4) {
    const scale = weeklyCapMiles / afterPass1Total;
    for (const s of adjusted) {
      // Floor to nearest 0.5mi, minimum 1mi — floor (not round) guarantees the
      // sum never exceeds the cap regardless of how many sessions there are.
      s.newMiles = Math.max(Math.floor(s.newMiles * scale * 2) / 2, 1);
    }
  }

  // Apply corrections: replace first mileage figure in each affected session line
  let corrected = message;
  for (const s of adjusted) {
    if (Math.abs(s.newMiles - s.miles) < 0.01) continue; // unchanged
    const newDesc = s.desc.replace(FIRST_MI_RE, `${s.newMiles}mi`);
    const newLine = s.fullLine.replace(s.desc, newDesc);
    // Replace only the exact full line (first occurrence — handles the rare dupe case)
    corrected = corrected.replace(s.fullLine, newLine);
  }

  // Rewrite stated weekly totals to match the corrected sessions
  const newTotal = adjusted.reduce((sum, s) => sum + s.newMiles, 0);
  const newTotalRounded = Math.round(newTotal * 10) / 10;
  const totalPatterns: RegExp[] = [
    /(Total:\s*~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?[ \t]*(?:total|this week|for the week))/gi,
    /(week(?:ly)?\s+(?:mileage|total)[:\s]+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  ];
  for (const pattern of totalPatterns) {
    corrected = corrected.replace(pattern, (_full, pre, _num, post) => {
      return `${pre}${newTotalRounded}${post}`;
    });
  }

  return {
    violated: true,
    totalMiles: originalTotal,
    maxSessionMiles: originalMax,
    message: corrected,
  };
}

/**
 * Detect and fix sessions whose stated mileage matches (or nearly matches) the
 * weekly total — a copy-paste error that produces things like "Thu 4/9 · Hill reps 33mi total".
 *
 * When detected, the erroneous session mileage is removed from the session line
 * (replaced with "X mi" as a placeholder) so it doesn't confuse athletes or cause
 * correctMileageTotal to emit the wrong Total. A console warning is emitted.
 *
 * Heuristic: any non-long-run session > 20 mi is suspicious. If it also matches
 * the stated weekly Total within 1 mi, treat it as a copy-paste error.
 */
export function fixSessionDistanceErrors(message: string): string {
  const sessions = parseSessionLines(message);
  if (sessions.length === 0) return message;

  // Extract the stated weekly total from the message, e.g. "Total: 33mi" → 33
  const totalMatch = message.match(/Total:\s*~?(\d+(?:\.\d+)?)\s*mi/i);
  const statedTotal = totalMatch ? parseFloat(totalMatch[1]) : null;

  const weeklyTotal = statedTotal ?? sessions.reduce((s, a) => s + a.miles, 0);

  let corrected = message;
  for (const session of sessions) {
    if (session.miles === 0) continue;
    // Flag any session that claims >= the weekly total (it's impossible for a single
    // session to equal the week), OR > 25mi for a clearly non-long-run session.
    const isNonLongRun = !/long\s*run|long run|LR\b/i.test(session.desc);
    const matchesTotal = statedTotal != null && Math.abs(session.miles - statedTotal) <= 1;
    if (matchesTotal && isNonLongRun && session.miles > 15) {
      console.warn(
        `[fixSessionDistanceErrors] session mileage ${session.miles}mi ≈ weekly total ${statedTotal}mi — likely copy-paste error. Session: "${session.fullLine}"`
      );
      // Remove the erroneous mileage figure from the session description.
      // Leave the label intact so the session is still meaningful.
      const fixedDesc = session.desc.replace(FIRST_MI_RE, "?mi (check distance)");
      const fixedLine = session.fullLine.replace(session.desc, fixedDesc);
      corrected = corrected.replace(session.fullLine, fixedLine);
    }
  }

  // Recalculate and rewrite the Total line if any sessions were patched
  if (corrected !== message) {
    const remaining = parseSessionLines(corrected)
      .filter(s => !s.desc.includes("?mi"))
      .reduce((sum, s) => sum + s.miles, 0);
    if (remaining > 0 && statedTotal != null) {
      corrected = corrected.replace(
        /Total:\s*~?(\d+(?:\.\d+)?)\s*mi/gi,
        `Total: ${Math.round(remaining * 10) / 10}mi (verify session distances)`
      );
    }
  }

  return corrected;
}

// Ordered Sun–Sat so index matches Date.getDay()
const DAY_ABBREVS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Validate and auto-correct weekday abbreviations in session lines.
 *
 * For each "Mon 3/2 · ..." line, checks that the stated weekday abbreviation
 * actually matches the calendar date. If wrong, replaces the abbreviation with
 * the correct one and logs a warning.
 *
 * Year inference: if the session month is earlier than the reference month it
 * must belong to the NEXT calendar year (a forward-looking plan never revisits
 * the past). Same month or later → same year as the reference.
 *
 * @param message  - Plan text to validate
 * @param refYear  - Current calendar year in the user's timezone
 * @param refMonth - Current month (1-indexed) in the user's timezone
 */
export function fixSessionDayAbbreviations(
  message: string,
  refYear: number,
  refMonth: number
): string {
  return message.replace(
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\/(\d{1,2})\s+·/gm,
    (fullMatch, dayAbbrev: string, monthStr: string, dayStr: string) => {
      const month = parseInt(monthStr, 10);
      const day = parseInt(dayStr, 10);

      // A training plan is always forward-looking. If the session month is
      // before the reference month, the session belongs to next calendar year.
      const year = month < refMonth ? refYear + 1 : refYear;

      const date = new Date(year, month - 1, day);
      // Guard against impossible dates (e.g. Feb 31) — leave them as-is
      if (date.getMonth() !== month - 1) return fullMatch;

      const correctAbbrev = DAY_ABBREVS[date.getDay()];
      if (correctAbbrev !== dayAbbrev) {
        console.warn(
          `[fixSessionDayAbbreviations] "${dayAbbrev} ${monthStr}/${dayStr}" — ${monthStr}/${dayStr}/${year} is a ${correctAbbrev}. Correcting.`
        );
        return fullMatch.replace(dayAbbrev, correctAbbrev);
      }

      return fullMatch;
    }
  );
}

/**
 * Count the number of running sessions in a plan response.
 * A running session is any parsed session line with a non-zero mileage marker.
 * Cross-training and strength sessions (0 miles) are excluded.
 */
export function countRunningSessions(message: string): number {
  return parseSessionLines(message).filter((s) => s.miles > 0).length;
}

/**
 * Patterns matching a stated weekly running-mileage total in a coaching message
 * (e.g. "Total: 32mi", "puts you at 32 miles for the week"). Exported so
 * applyStructuredWeeklyTotal (below) and coach/respond's correctMileageTotal recognize
 * the exact same phrasing — one list instead of two that can silently drift apart.
 * (?<![-\d]|to ) guards against matching the upper bound of a range like "20-25 miles":
 * excluding "preceded by a digit" (not just "preceded by -") matters because \d+ can
 * otherwise start its match mid-number — at the "5" in "20-25" rather than the "2" — since
 * a lookbehind that only excludes "-" doesn't stop the engine from retrying one character
 * later once the "-2" start position fails to find "mi" after it.
 */
export const WEEKLY_TOTAL_PATTERNS: RegExp[] = [
  /(Total:\s*~?)(?<![-\d]|to )(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  /(~?)(?<![-\d]|to )(\d+(?:\.\d+)?)(\s*mi(?:les?)?[ \t]*(?:total|this week|for the week))/gi,
  /(week(?:ly)?\s+(?:mileage|total)[:\s]+~?)(?<![-\d]|to )(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  /(stays?\s+at\s+~?)(?<![-\d]|to )(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  /(staying\s+at\s+~?)(?<![-\d]|to )(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  /(puts\s+(?:you\s+at|the\s+week\s+at)\s+~?)(?<![-\d]|to )(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
];

/**
 * Force the weekly total stated in a plan message to match a known-correct number, using
 * the same phrasing patterns correctMileageTotal recognizes.
 *
 * This exists because initial_plan/weekly_recap messages are day-agnostic prose (per
 * CLAUDE.md's day-agnostic plan redesign) — they no longer contain the dated
 * "Mon D/M · ..." session lines correctMileageTotal and enforceVolumeCaps depend on to
 * compute a correction, which makes both effectively no-ops for these two triggers today.
 * The real fix is structural: coach/respond's deliver_message tool call now requires a
 * `plan.weekly_total` field for these triggers (see DELIVER_MESSAGE_TOOL in route.ts) —
 * a number Claude reports directly rather than one inferred by summing parsed text. The
 * caller validates/caps that number (see computeWeekOneVolumeCap) and passes the final,
 * trusted value here to make sure the prose matches it.
 */
export function applyStructuredWeeklyTotal(message: string, validatedTotal: number): string {
  const rounded = Math.round(validatedTotal * 10) / 10;
  let corrected = message;
  for (const pattern of WEEKLY_TOTAL_PATTERNS) {
    corrected = corrected.replace(pattern, (full, pre, num, post, offset, str) => {
      const numStart = offset + pre.length;
      const before = str.slice(Math.max(0, numStart - 8), numStart);
      if (/\bto\s+$/.test(before)) return full; // upper bound of a word range — leave alone
      const stated = parseFloat(num);
      if (Math.abs(stated - rounded) <= 0.4) return full; // already correct
      console.warn(`[applyStructuredWeeklyTotal] stated ${stated}mi, structured total is ${rounded}mi — correcting`);
      return `${pre}${rounded}${post}`;
    });
  }
  return corrected;
}

/** Matches the "Long run: Xmi <descriptor>" line initial_plan/weekly_recap prose uses (see route.ts's OUTPUT format examples). */
export const LONG_RUN_PATTERNS: RegExp[] = [
  /(Long run:\s*~?)(?<![-\d]|to )(\d+(?:\.\d+)?)(\s*(?:mi(?:les?)?|km))/gi,
];

/**
 * Force the long-run distance stated in initial_plan prose to match a validated,
 * capped number — the same mechanism as applyStructuredWeeklyTotal, for the same
 * reason: a hard safety cap (see computeLongRunCap's daysSinceLastRun handling) is
 * only worth having if a blown cap actually gets corrected in the text an athlete
 * receives, not just logged. Unlike the weekly total, this only fires when a cap is
 * known (computeLongRunCap returns non-null) and exceeded — most tiers outside a
 * layoff gap have no long-run number to enforce, so callers should only invoke this
 * once they've confirmed a cap applies.
 */
export function applyStructuredLongRun(message: string, cappedDistance: number): string {
  const rounded = Math.round(cappedDistance * 10) / 10;
  let corrected = message;
  for (const pattern of LONG_RUN_PATTERNS) {
    corrected = corrected.replace(pattern, (full, pre, num, post) => {
      const stated = parseFloat(num);
      if (stated <= rounded + 0.4) return full; // already within cap
      console.warn(`[applyStructuredLongRun] stated ${stated}mi, cap is ${rounded}mi — correcting`);
      return `${pre}${rounded}${post}`;
    });
  }
  return corrected;
}

/**
 * Safe Week-1 weekly-mileage range for a brand-new training plan, by fitness tier.
 *
 * This MUST stay numerically identical to the WEEK 1 VOLUME CAP <rule> blocks in
 * coach/respond's buildSystemPrompt (route.ts) — those blocks are what tells Claude the
 * cap, this function is what validates the structured plan.weekly_total field Claude
 * reports back. The prompt text itself isn't generated from this function (each is a
 * large, delicate template literal not worth the risk of programmatic coupling), so if
 * you change one, change the other and verify the numbers still match.
 *
 * max is null where the prompt only asserts a floor (advanced/intermediate no-history
 * tiers) — there's no numeric ceiling to enforce there, only a "don't go below"
 * recommendation, which this function deliberately does not enforce: going under a
 * suggested floor isn't an injury risk, exceeding a ceiling is. Callers should only ever
 * clamp downward against max, never force a value up to min.
 */
export function computeWeekOneVolumeCap(
  avgWeeklyMileage: number | null,
  fitnessLevel: string | null,
  forceBeginnerTier: boolean,
  daysSinceLastRun: number | null = null,
  activeInjury: boolean = false
): { min: number; max: number | null } {
  if (avgWeeklyMileage == null || forceBeginnerTier) {
    if (fitnessLevel === "advanced") return { min: 20, max: null };
    if (fitnessLevel === "intermediate") return { min: 12, max: null };
    return { min: 0, max: 10 }; // beginner — stale history or no history
  }
  const base = avgWeeklyMileage < 10
    ? { min: 0, max: Math.max(Math.ceil(avgWeeklyMileage * 1.3), 6) }
    : avgWeeklyMileage < 30
      ? { min: Math.round(avgWeeklyMileage * 0.90), max: Math.round(avgWeeklyMileage * 1.2) }
      : { min: Math.round(avgWeeklyMileage * 0.90), max: Math.round(avgWeeklyMileage * 1.12) };

  // A real gap since the last run means avgWeeklyMileage (averaged over complete weeks
  // before the gap) overstates current fitness — the athlete hasn't been holding that
  // load recently. Scale the cap down the same way computeReturnToRunRamp scales a
  // formal injury-hold return (70%/60%/50% at 1/2/3+ weeks off) so a starter plan after
  // an unflagged layoff doesn't just hand back pre-layoff volume. Below 7 days, gaps are
  // normal week-to-week noise and the base cap already covers them.
  //
  // An active injury on file forces the same scale-down even when daysSinceLastRun is
  // small or ambiguous (the gradual-taper case: an athlete nursing shin splints who
  // "backed off recently" rather than stopping outright never trips the >=7-day gap
  // check, so historical volume passed through untouched — see the 2026-07-22
  // changelog: 18mi/week average + active shin splints still produced an 8.5mi long
  // run because the volume tier alone gated the cap). When there's no real day count to
  // scale from, 0.60 (the 2-week-off factor) is the conservative default — an active,
  // reported injury is never treated as "just noise" the way a sub-7-day running gap is.
  const gapApplies = (daysSinceLastRun != null && daysSinceLastRun >= 7) || activeInjury;
  if (gapApplies) {
    const gapFactor = daysSinceLastRun != null && daysSinceLastRun >= 7
      ? (daysSinceLastRun >= 21 ? 0.50 : daysSinceLastRun >= 14 ? 0.60 : 0.70)
      : 0.60;
    const gapMax = Math.round(avgWeeklyMileage * gapFactor);
    return {
      min: Math.round(Math.min(base.min, gapMax * 0.85)),
      max: base.max != null ? Math.min(base.max, gapMax) : gapMax,
    };
  }

  return base;
}

/**
 * Safe Week-1 long-run cap, in the athlete's mileage unit — mirrors the
 * "LONG RUN CAP — HARD LIMIT" `<rule>` in buildSystemPrompt (route.ts). Outside a real
 * layoff, this only asserts an explicit numeric long-run cap for the LOW VOLUME tier
 * (avg < 10mi/week) — other tiers give a weekly-total cap but no separately-stated
 * long-run number, so this deliberately returns null for them rather than inventing a
 * cap the prompt never asserts.
 *
 * A real gap since the last run (>=7 days) is the exception: a moderate/high-volume
 * athlete's historical average overstates what their body can absorb in a single long
 * run right now the same way it overstates the weekly total (see
 * computeWeekOneVolumeCap's daysSinceLastRun handling) — a returning athlete can get
 * prescribed a long run that's 30-40% of the week's *pre-layoff* volume with no cap at
 * all once avgWeeklyMileage crosses 10, which is exactly backwards for someone coming
 * back from time off (see the 2026-07-21 changelog: 8.5mi long run prescribed to an
 * athlete with an active shin injury and a 2-week gap, avg ~18mi/week). When the gap
 * applies, base the 35% cap on the gap-adjusted weekly max (already scaled down by
 * computeWeekOneVolumeCap's 70/60/50% factor) instead of the raw historical average.
 *
 * `activeInjury` covers a case the gap check alone still misses: an athlete who tapered
 * down gradually (rather than stopping outright) never trips the >=7-day gap, so an
 * active, currently-symptomatic injury with an ambiguous recent-run history passed
 * through with no cap at all once avgWeeklyMileage crossed 10 — the exact scenario in
 * the 2026-07-21 example above (18mi/week average, active shin splints, "backed off
 * recently" rather than a clean stop). An active injury on file forces the same
 * gap-adjusted math regardless of the day count.
 */
export function computeLongRunCap(avgWeeklyMileage: number | null, daysSinceLastRun: number | null = null, activeInjury: boolean = false): number | null {
  if (avgWeeklyMileage == null) return null;
  const gapApplies = (daysSinceLastRun != null && daysSinceLastRun >= 7) || activeInjury;
  if (avgWeeklyMileage >= 10 && !gapApplies) return null;
  const base = gapApplies
    ? computeWeekOneVolumeCap(avgWeeklyMileage, null, false, daysSinceLastRun, activeInjury).max ?? avgWeeklyMileage
    : avgWeeklyMileage;
  return Math.max(Math.ceil(base * 0.35), 3);
}

/**
 * Parse a pace string like "8:15/mi" or "4:30/km" into seconds-per-mile, so paces in
 * different units can be compared. Unit-less strings (or "/mi") are assumed to already
 * be min/mile — this matches how paces are stored throughout the codebase ("always
 * stored as min/mile", per paces.ts) and how coach/respond's PACE SANITY CHECK rule
 * requires every pace Claude states to include its unit.
 */
export function parsePaceStrToSecPerMile(paceStr: string | null): number | null {
  if (!paceStr) return null;
  const match = paceStr.match(/(\d+):(\d{2})/);
  if (!match) return null;
  const sec = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  return /\/\s*km\b/i.test(paceStr) ? Math.round(sec * 1.60934) : sec;
}

/**
 * Remove exact duplicate session lines from a plan.
 *
 * A duplicate is defined as two lines with the identical "DDD D/M · description"
 * text. The first occurrence is kept; subsequent identical lines are removed
 * (along with any trailing newline).
 */
export function deduplicateSessionLines(message: string): string {
  const seen = new Set<string>();
  return message
    .split("\n")
    .filter((line) => {
      if (!SESSION_LINE_RE.test(line)) return true; // not a session line — keep as-is
      if (seen.has(line)) return false; // exact duplicate — drop
      seen.add(line);
      return true;
    })
    .join("\n");
}
