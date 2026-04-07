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
    const miMatch = desc.match(FIRST_MI_RE);
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
