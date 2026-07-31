/**
 * Advisory check for an unsignaled plan change: the athlete-facing message claims a
 * plan change happened ("I've swapped...", "lightened this week...") while the
 * structured `plan_action` field on the same `deliver_message` call is empty — meaning
 * nothing was actually written to the DB. Only `plan_action` performs a change (see
 * `buildDeliverMessageTool` in coach/respond/route.ts); this exists purely to measure
 * how often Claude still describes a change without setting the field that makes it
 * real, now that the mechanism is fully structural (deliver_message is the only channel
 * an athlete-facing message travels through, and plan_action is the only channel a plan
 * mutation travels through — see the "structural constraint" fix-mechanism section of
 * CLAUDE.md).
 *
 * v1 is advisory-only (the caller should log/trackEvent, never block or rewrite) — same
 * reasoning as repetition-check.ts's v1: this touches a live SMS send path, and a
 * keyword heuristic isn't precise enough to safely regenerate on. If telemetry shows
 * this fires often, the next step is a semantic Haiku check (the repetition-check.ts
 * pattern), not growing this phrase list further.
 */

const CHANGE_CONFIRMATION_RE =
  /\b(i'?ve|i'?m|i am)\s+(swapp?ed|mov(?:ed|ing)|adjust(?:ed|ing)|lighten(?:ed|ing)|reduc(?:ed|ing)|updat(?:ed|ing)|rebuil(?:t|ding)|paus(?:ed|ing)|clear(?:ed|ing)\s+you)\b[^.!?]{0,40}\b(plan|week|session|mileage|schedule|run)/i;

export interface PlanActionLike {
  session_swaps?: unknown[];
  lighter_week?: boolean;
  injury_hold?: boolean;
  injury_clear?: boolean;
  rtr_advance?: boolean;
  rebuild_plan?: boolean;
  physio_referral?: boolean;
}

function hasAnyPlanAction(planAction: PlanActionLike | null): boolean {
  if (!planAction) return false;
  return (
    (Array.isArray(planAction.session_swaps) && planAction.session_swaps.length > 0) ||
    planAction.lighter_week === true ||
    planAction.injury_hold === true ||
    planAction.injury_clear === true ||
    planAction.rtr_advance === true ||
    planAction.rebuild_plan === true ||
    planAction.physio_referral === true
  );
}

/**
 * True when `message` reads like it's confirming a plan change to the athlete, but
 * `planAction` has nothing set — the change described in text never actually happened.
 */
export function messageClaimsUnsignaledPlanChange(message: string, planAction: PlanActionLike | null): boolean {
  if (hasAnyPlanAction(planAction)) return false;
  return CHANGE_CONFIRMATION_RE.test(message);
}
