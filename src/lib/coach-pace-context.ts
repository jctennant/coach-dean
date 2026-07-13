/**
 * Pace context — the pace-computation block from buildSystemPrompt (coach/respond/
 * route.ts). Fourth slice of the CoachContext extraction (see coach-date-context.ts,
 * coach-race-context.ts, coach-fitness-tier.ts for the first three).
 *
 * This closes two small duplicate-work gaps rather than a correctness bug:
 *   1. `easyPaceRange(easyPaceRaw, useMetric)` was called three separate times inline
 *      in route.ts (FACTS block, "Current paces" line, PACE SANITY CHECK rule) — same
 *      inputs, same output, computed fresh each time. Now computed once here.
 *   2. `tsTempoPace` and `tsTempoPaceGuard` both independently called
 *      `estimatePacesFromEasyPace` + `tsFormatPace` to derive the same display string —
 *      one for the FACTS block, one for the sanity-check guard. Still two fields (the
 *      guard suppresses on invalid paces and omits the "(estimated)" suffix the display
 *      string carries), but they're now computed side-by-side in one place instead of
 *      two separate IIFEs a future edit could drift apart.
 *
 * The stored-pace corruption check (tempo >= easy pace, or slower than a 13:00/mi floor
 * — almost always a km/mi confusion at intake) is preserved exactly: `pacesAreSane`
 * gates both the display and the guard the same way it did inline.
 */

import { estimatePacesFromEasyPace, easyPaceRange } from "./paces";

export interface PaceContextParams {
  easyPaceRaw: string | null;
  tempoPaceRaw: string | null;
  intervalPaceRaw: string | null;
  useMetric: boolean;
}

export interface PaceContext {
  /** Display string for the "Current paces" / FACTS lines, e.g. "7:30/mi (estimated)" or the INVALID message. */
  tempoPace: string;
  intervalPace: string;
  /** Formatted easy pace alone, e.g. "8:15/mi" — null if no stored easy pace. */
  easyGuard: string | null;
  /** Formatted tempo pace alone (no "(estimated)" suffix, no INVALID message) — null if paces are corrupt or unavailable. */
  tempoPaceGuard: string | null;
  /** "7:45–8:15/mi"-style range, or null if no stored easy pace. */
  easyRange: string | null;
  pacesAreSane: boolean;
}

function formatPace(paceStr: string | null | undefined, useMetric: boolean): string {
  if (!paceStr) return "TBD";
  if (!useMetric) return paceStr;
  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return paceStr;
  const totalSec = parseInt(match[1]) * 60 + parseInt(match[2]);
  const kmSec = Math.round(totalSec / 1.60934);
  const min = Math.floor(kmSec / 60);
  const sec = kmSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}/km`;
}

function getRawPaceSec(paceStr: string | null): number | null {
  if (!paceStr) return null;
  const m = paceStr.match(/(\d+):(\d+)/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
}

const TEMPO_FLOOR_SEC = 13 * 60; // 13:00/mi — anything slower is walking, not tempo

export function computePaceContext(params: PaceContextParams): PaceContext {
  const { easyPaceRaw, tempoPaceRaw, intervalPaceRaw, useMetric } = params;

  const easySec = (() => {
    if (!easyPaceRaw) return null;
    const m = easyPaceRaw.match(/(\d+):(\d+)/);
    return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
  })();

  // Sanity-check stored tempo/interval paces. A valid tempo must be:
  //   - at least 30s/mi faster than easy pace, AND
  //   - faster than 13:00/mi (absolute floor)
  // If either fails, the stored paces are corrupt (likely a km/mi confusion at intake)
  // and should not be handed to Claude for prescriptions.
  const tempoSecRaw = getRawPaceSec(tempoPaceRaw) ?? getRawPaceSec(estimatePacesFromEasyPace(easyPaceRaw).tempo);
  const pacesAreSane = tempoSecRaw == null || (
    tempoSecRaw < TEMPO_FLOOR_SEC &&
    (easySec == null || tempoSecRaw < easySec - 30)
  );

  const tempoPace = (() => {
    if (!pacesAreSane) return "INVALID — paces appear corrupted (tempo ≥ easy or slower than 13:00/mi). Use effort-based language only (e.g. 'comfortably hard', 'easy effort'). Do not prescribe specific paces until the athlete provides a recent race time or easy pace to recalibrate.";
    if (tempoPaceRaw) return formatPace(tempoPaceRaw, useMetric);
    const est = estimatePacesFromEasyPace(easyPaceRaw);
    return est.tempo ? `${formatPace(est.tempo, useMetric)} (estimated)` : "TBD";
  })();

  const intervalPace = (() => {
    if (!pacesAreSane) return "INVALID — see tempo note above";
    if (intervalPaceRaw) return formatPace(intervalPaceRaw, useMetric);
    const est = estimatePacesFromEasyPace(easyPaceRaw);
    return est.interval ? `${formatPace(est.interval, useMetric)} (estimated)` : "TBD";
  })();

  const easyGuard = easyPaceRaw ? formatPace(easyPaceRaw, useMetric) : null;

  const tempoPaceGuard = (() => {
    if (!pacesAreSane) return null; // suppress invalid paces from plan generation
    if (tempoPaceRaw) return formatPace(tempoPaceRaw, useMetric);
    const est = estimatePacesFromEasyPace(easyPaceRaw);
    return est.tempo ? formatPace(est.tempo, useMetric) : null;
  })();

  return {
    tempoPace,
    intervalPace,
    easyGuard,
    tempoPaceGuard,
    easyRange: easyPaceRange(easyPaceRaw, useMetric),
    pacesAreSane,
  };
}
