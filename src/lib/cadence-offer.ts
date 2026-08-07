import type { Cadence } from "@/lib/intent-classifier";

/**
 * The "how we'll work together" close, sent as the final bubble of `initial_plan`.
 *
 * This used to be a single sentence of prompt instruction ("Close with one short sentence
 * on how check-ins work going forward") competing for attention with ~40 other rules inside
 * a 2-bubble, 1000-token budget that also had to deliver the plan, respect volume caps and
 * explain pacing — so whether the athlete was ever told how coaching works depended on which
 * instructions Sonnet happened to honor that turn. It's deterministic now, for the same
 * reason the Strava pitch and the schedule-confirm checkpoint are: it must land every time,
 * and its exact wording is what `parseCadenceReply` below is keyed to.
 *
 * It also converts the cadence default into a real choice. `completeOnboarding` writes
 * `proactive_cadence: "weekly_only"` for every athlete; nothing ever asked them, and the
 * existing [CADENCE:] opt-in was only reachable if they spontaneously requested it later.
 */
export function buildCadenceOffer(opts: {
  activeInjury: boolean;
  bodyPart?: string | null;
}): string {
  const { activeInjury, bodyPart } = opts;
  const injuryLine = activeInjury
    ? ` First run: keep it easy${bodyPart ? ` and stop if the ${bodyPart} flares up` : ""} — text me how it felt either way.`
    : "";
  // "By default" is load-bearing: it tells the athlete the two always-on touchpoints are
  // already set up and need no action from them, so the reminder question reads as an
  // optional extra rather than a setup step they have to complete.
  return (
    "By default I'll send you a note after each run, plus a recap and the week ahead every Sunday." +
    injuryLine +
    "\n\nIf you want, I can also send a morning or evening reminder on your training days — " +
    "reply MORNING or EVENING. Otherwise reply YES and you're all set."
  );
}

/**
 * Identifies the offer above in conversation history. Content-matched rather than keyed on
 * `message_type`, because `initial_plan_link` is also used by generateAndSaveFullPlan's
 * plan-ready SMS — matching the type alone would misread a reply to that message as an
 * answer to this question.
 */
export function isCadenceOffer(content: string): boolean {
  return /reply MORNING or EVENING/i.test(content);
}

/**
 * Reads an explicit cadence choice out of a reply to the offer.
 *
 * Deliberately narrow: only MORNING and NIGHT are intercepted. "YES" (and anything else)
 * returns null and falls through to the normal coaching path, because "yes" is confirming
 * the *plan*, not requesting a cadence — answering it with "got it, I'll keep to the Sunday
 * recap" would be a non-sequitur, and weekly_only is already what completeOnboarding wrote.
 *
 * Only ever called when the previous assistant message was the offer, so a bare "morning"
 * can't be misread as a comment about someone's morning run.
 */
export function parseCadenceReply(message: string): Cadence | null {
  const text = message.toLowerCase();
  // Checked ahead of any affirmative: "yes, morning please" is a cadence choice, not a
  // bare plan confirmation.
  if (/\b(morning|mornings|am|first thing)\b/.test(text)) return "morning_reminders";
  if (/\b(night|nights|nightly|evening|evenings|night before|pm)\b/.test(text)) return "nightly_reminders";
  return null;
}
