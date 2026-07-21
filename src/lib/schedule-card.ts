import type { ArcWeekSlot, RecoveryWeekSlot } from "@/lib/training-plan";
import { MODALITY_DISPLAY_NAMES } from "@/lib/exercise-library";

/**
 * Shared payload for the schedule-card image (see /api/coach/schedule-card).
 * Built once, server-side, directly from the same deterministic skeleton +
 * Claude-supplied annotations used for the text digest bubble (formatRecoveryWeekDigest /
 * formatWeeklyPlanDigest) — never re-derived independently, so the image can't say
 * something the text didn't already say. Encoded into the image URL itself (no DB
 * persistence, no render-time DB round-trip) since the whole payload is small and the
 * card is generated once, at send time, from data already in hand.
 */
export type CardRowType =
  | "strength" | "bike" | "pool_running" | "swimming" | "elliptical"
  | "stair_stepper" | "rowing" | "hiking" | "walking" | "cross_train"
  | "probe" | "easy" | "quality" | "long_run" | "rest";

export interface CardRow {
  day: string; // "MON"
  date: string; // "7/20"
  type: CardRowType;
  label: string; // "Bike", "Long run", "Test jog"
  detail?: string; // short cue, e.g. "40-50 min, easy conversational effort"
  tag?: string; // e.g. "QUALITY", "LONG" — regular-week key sessions only
}

export interface CardPayload {
  weekLabel: string; // "WEEK 3 OF 8"
  countLabel: string; // "0 running mi" or "34.0 mi"
  rows: CardRow[];
  watch: Array<{ text: string; flag?: boolean }>;
}

export function buildRecoveryCardPayload(params: {
  weekLabel: string;
  skeleton: RecoveryWeekSlot[];
  annotations?: Array<{ day: string; description?: string }> | null;
  probe?: { day: string; note: string } | null;
  shinRoutineNote?: string; // e.g. "Shin routine 3-5x this week — that's what rebuilds tolerance"
}): CardPayload {
  const { weekLabel, skeleton, annotations, probe, shinRoutineNote } = params;
  const annotationByDay = new Map((annotations ?? []).map((a) => [a.day, a]));
  const rows: CardRow[] = skeleton
    .filter((s) => s.type !== "rest" || (probe && s.day === probe.day))
    .map((s) => {
      if (s.type === "rest") {
        return { day: s.day.toUpperCase(), date: s.date, type: "probe", label: "Test jog", detail: probe!.note };
      }
      const type: CardRowType = s.type === "strength" ? "strength" : ((s.modality as CardRowType) ?? "cross_train");
      const label = s.type === "strength" ? "Strength + mobility" : (MODALITY_DISPLAY_NAMES[s.modality ?? ""] ?? "Cross-training");
      return { day: s.day.toUpperCase(), date: s.date, type, label, detail: annotationByDay.get(s.day)?.description };
    });
  const watch: CardPayload["watch"] = [];
  if (shinRoutineNote) watch.push({ text: shinRoutineNote });
  // Always show a return-to-run status line, not just when a probe is scheduled — whether
  // there's a test jog this week is exactly the thing an athlete on injury hold is watching
  // for, and it was silently disappearing from the card whenever Claude judged a probe
  // wasn't warranted this particular week, with zero explanation. `probe` presence is a
  // per-call judgment call (deliberately, since it should reflect that week's check-ins),
  // so it's expected to vary — but the athlete should never see nothing about it.
  watch.push(
    probe
      ? { text: "Pain-free through the week → full plan rebuilds next Sunday", flag: true }
      : { text: "No test run yet this week — building tolerance, we'll reassess Sunday", flag: true }
  );
  return { weekLabel, countLabel: "0 running mi", rows, watch };
}

export function buildRegularCardPayload(params: {
  weekLabel: string;
  skeleton: ArcWeekSlot[];
  annotations?: Array<{ day: string; pace?: string; why?: string; description?: string }> | null;
  isMetric?: boolean;
  watch?: Array<{ text: string; flag?: boolean }>;
}): CardPayload {
  const { weekLabel, skeleton, annotations, isMetric, watch } = params;
  const annotationByDay = new Map((annotations ?? []).map((a) => [a.day, a]));
  const fmtDist = (miles: number) => (isMetric ? `${(miles * 1.60934).toFixed(1)}km` : `${miles}mi`);
  let totalMiles = 0;
  const rows: CardRow[] = skeleton.map((s) => {
    if (s.type === "rest") {
      return { day: s.day.toUpperCase(), date: s.date, type: "rest", label: "Rest" };
    }
    if (s.distanceMiles) totalMiles += s.distanceMiles;
    const annotation = annotationByDay.get(s.day);
    if (s.type === "long_run") {
      return {
        day: s.day.toUpperCase(), date: s.date, type: "long_run", label: "Long run", tag: "LONG",
        detail: `${fmtDist(s.distanceMiles ?? 0)}${annotation?.pace ? ` @ ${annotation.pace}` : ""}`,
      };
    }
    if (s.type === "quality") {
      return {
        day: s.day.toUpperCase(), date: s.date, type: "quality", label: annotation?.why ?? "Quality", tag: "QUALITY",
        detail: s.keyWorkoutText ?? fmtDist(s.distanceMiles ?? 0),
      };
    }
    if (s.type === "cross_train") {
      const label = MODALITY_DISPLAY_NAMES[s.modality ?? ""] ?? "Cross-training";
      return { day: s.day.toUpperCase(), date: s.date, type: (s.modality as CardRowType) ?? "cross_train", label, detail: annotation?.description };
    }
    if (s.type === "strength") {
      return { day: s.day.toUpperCase(), date: s.date, type: "strength", label: "Strength + mobility", detail: annotation?.description };
    }
    return {
      day: s.day.toUpperCase(), date: s.date, type: "easy", label: "Easy run",
      detail: `${fmtDist(s.distanceMiles ?? 0)}${annotation?.pace ? ` @ ${annotation.pace}` : ""}`,
    };
  });
  const countLabel = isMetric ? `${(totalMiles * 1.60934).toFixed(1)} km` : `${totalMiles.toFixed(1)} mi`;
  return { weekLabel, countLabel, rows, watch: watch ?? [] };
}

/** URL-safe base64 JSON encode/decode — the schedule-card route's only input. */
export function encodeCardPayload(payload: CardPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf-8").toString("base64url");
}

export function decodeCardPayload(encoded: string): CardPayload | null {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rows)) return null;
    return parsed as CardPayload;
  } catch {
    return null;
  }
}
