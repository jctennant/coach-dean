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
  return (
    "Here's how we'll work together: I'll text you a coaching note after every run, " +
    "and every Sunday a recap plus the week ahead." +
    injuryLine +
    "\n\nReply YES to lock this in, or MORNING / NIGHT if you also want a reminder on your training days."
  );
}

/**
 * Identifies the offer above in conversation history. Content-matched rather than keyed on
 * `message_type`, because `initial_plan_link` is also used by generateAndSaveFullPlan's
 * plan-ready SMS — matching the type alone would misread a reply to that message as an
 * answer to this question.
 */
export function isCadenceOffer(content: string): boolean {
  return /Reply YES to lock this in, or MORNING \/ NIGHT/i.test(content);
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
