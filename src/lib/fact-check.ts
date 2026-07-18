/**
 * Phase B of the CoachContext work: equality-check the facts Dean's message
 * asserts against system ground truth.
 *
 * The deliver_message tool schema (see buildDeliverMessageTool in
 * coach/respond/route.ts) requires a `stated_facts` echo: for each checkable
 * fact, the value the message TEXT asserts, or null when the message doesn't
 * mention it. Because the echo comes from the same generation as the text, a
 * hallucinated fact shows up here as a number code can compare — turning the
 * "Dean states a stale/wrong week or mileage" bug family from a prompt-rule
 * problem into a detectable, retryable data problem.
 *
 * All comparisons are in the athlete's DISPLAY unit (miles or km) — the caller
 * converts ground truth before building FactGroundTruth. A ground-truth field
 * set to null means "no reliable truth right now, skip the check" (e.g.
 * weekly target during an injury hold, where the stored target is stale by
 * definition).
 */

export interface StatedFacts {
  week_number?: number | null;
  weekly_target?: number | null;
  week_distance_completed?: number | null;
  days_until_race?: number | null;
}

export interface FactGroundTruth {
  week_number: number | null;
  weekly_target: number | null;
  week_distance_completed: number | null;
  days_until_race: number | null;
  /** "mi" or "km" — display unit, used only for correction-message wording. */
  unit: "mi" | "km";
}

export interface FactMismatch {
  fact: keyof StatedFacts;
  stated: number;
  actual: number;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Compare the stated facts against ground truth. Only facts that are non-null
 * on BOTH sides are compared. Tolerances:
 * - week_number: exact
 * - days_until_race: ±1 day (timezone/rounding slack)
 * - distances: ±10% or ±1 unit, whichever is larger (display rounding slack)
 */
export function checkStatedFacts(
  stated: unknown,
  truth: FactGroundTruth
): FactMismatch[] {
  if (!stated || typeof stated !== "object") return [];
  const s = stated as StatedFacts;
  const mismatches: FactMismatch[] = [];

  if (isNum(s.week_number) && truth.week_number != null && s.week_number !== truth.week_number) {
    mismatches.push({ fact: "week_number", stated: s.week_number, actual: truth.week_number });
  }
  if (
    isNum(s.days_until_race) &&
    truth.days_until_race != null &&
    Math.abs(s.days_until_race - truth.days_until_race) > 1
  ) {
    mismatches.push({ fact: "days_until_race", stated: s.days_until_race, actual: truth.days_until_race });
  }
  for (const key of ["weekly_target", "week_distance_completed"] as const) {
    const statedVal = s[key];
    const actualVal = truth[key];
    if (isNum(statedVal) && actualVal != null) {
      const tolerance = Math.max(1, actualVal * 0.1);
      if (Math.abs(statedVal - actualVal) > tolerance) {
        mismatches.push({ fact: key, stated: statedVal, actual: actualVal });
      }
    }
  }
  return mismatches;
}

const FACT_LABELS: Record<keyof StatedFacts, (unit: string) => string> = {
  week_number: () => "the current training week number",
  weekly_target: (unit) => `this week's mileage target (${unit})`,
  week_distance_completed: (unit) => `distance completed so far this week (${unit})`,
  days_until_race: () => "days until the race",
};

/**
 * Build the tool_result text sent back when the fact check fails — tells Claude
 * exactly which numbers were wrong and what the real values are, and asks for a
 * single corrected re-delivery.
 */
export function buildFactCorrection(mismatches: FactMismatch[], truth: FactGroundTruth): string {
  const lines = mismatches.map(
    (m) => `- ${FACT_LABELS[m.fact](truth.unit)}: your message says ${m.stated}, but the actual value is ${m.actual}`
  );
  return (
    "DELIVERY REJECTED — fact check failed. Your message states facts that contradict the system's records:\n" +
    lines.join("\n") +
    "\nCall deliver_message again with your message corrected to use the actual values above (and stated_facts matching them). " +
    "Change only what's needed to fix these facts — keep everything else about your message the same."
  );
}
