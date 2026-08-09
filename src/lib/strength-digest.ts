/**
 * Text rendering of a strength/rehab routine, and the deterministic follow-up that sends the
 * illustrations when the athlete asks for them.
 *
 * Until now every athlete-facing path for a routine was either Claude's prose or images, and the
 * send path was one MMS per exercise — 9 to 13 media bubbles over ~16 seconds, each captioned
 * with the exercise name. There was no text renderer anywhere, and no fallback: when none of the
 * exercises had art, the athlete got nothing at all.
 *
 * Everything here is pure. The routine data is already structured (`ROUTINES` / `EXERCISES` in
 * strength-library.ts), so rendering it is string templating, not a model call — same reasoning
 * as formatWeeklyPlanDigest.
 *
 * State lives in the message text rather than a DB column: `isStrengthDigest` recognises a digest
 * sitting in conversation history and `exerciseIdsFromDigest` reads back exactly which exercises
 * it listed. That's what makes the follow-up work for adapted routines too — whatever Dean
 * actually prescribed is what gets illustrated. It's the same design as `isCadenceOffer` /
 * `parseCadenceReply`, which pin a deterministic reply to "the previous assistant message was
 * this specific offer".
 */

import { EXERCISES, getRoutine, routineExerciseIds } from "@/lib/strength-library";

/** Closing line of every digest — the sentinel isStrengthDigest matches on. */
const INVITE_LINE = "Want to see how any of these look? Just ask.";

const MAX_DIGEST_CHARS = 460;

export interface StrengthDigest {
  text: string;
  /** Exactly the exercises the text lists, in order. */
  exerciseIds: string[];
  /** True when the list was cut short to fit one SMS. */
  truncated: boolean;
}

/** Strip a trailing parenthetical qualifier: "Eccentric calf raises (straight knee)" → base name. */
function shortName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** "daily", "3× this week (Mon/Wed/Fri)", or "2×/week" when no days are known. */
function cadenceLabel(days: string[] | null | undefined): string {
  if (!days || days.length === 0) return "this week";
  if (days.length >= 6) return "daily this week";
  return `${days.length}× this week (${days.join("/")})`;
}

export function formatStrengthDigest(params: {
  routineKey: string | null;
  /** Overrides the routine's own list — for adapted routines (deliver_message exercise_ids). */
  exerciseIds?: string[] | null;
  /** Days the routine is scheduled, from computeRehabSchedule. */
  days?: string[] | null;
  activeInjury?: boolean;
  maxChars?: number;
}): StrengthDigest | null {
  const { routineKey, days = null, activeInjury = false, maxChars = MAX_DIGEST_CHARS } = params;

  const ids = params.exerciseIds?.length
    ? params.exerciseIds.filter((id) => !!EXERCISES[id])
    : routineKey
      ? routineExerciseIds(routineKey, { activeInjury })
      : [];
  if (ids.length === 0) return null;

  const routine = routineKey ? getRoutine(routineKey) : null;
  // Short label, matching the schedule lines ("Easy 4mi + shin routine") so the two messages
  // are obviously about the same thing.
  const label = routine
    ? `${routine.shortLabel.charAt(0).toUpperCase()}${routine.shortLabel.slice(1)} routine`
    : "Strength routine";
  const minutes = days && days.length >= 5 ? "~15 min" : "~20 min";
  const header = `${label} — ${cadenceLabel(days)}, ${minutes}:`;

  const render = (using: string[], omitted: number): string => {
    const lines = using.map((id) => {
      const ex = EXERCISES[id];
      return `› ${shortName(ex.name)} — ${ex.specs}`;
    });
    const more = omitted > 0 ? [`› +${omitted} more — ask me for the rest`] : [];
    return [header, ...lines, ...more, INVITE_LINE].join("\n");
  };

  // Drop from the end until it fits one bubble. Every exercise still reachable by asking.
  let shown = [...ids];
  let text = render(shown, 0);
  while (text.length > maxChars && shown.length > 3) {
    shown = shown.slice(0, -1);
    text = render(shown, ids.length - shown.length);
  }

  return { text, exerciseIds: shown, truncated: shown.length < ids.length };
}

/** Does this message look like a strength digest we sent? */
export function isStrengthDigest(content: string): boolean {
  return content.includes(INVITE_LINE);
}

/**
 * Read back the exercise ids a sent digest listed, by matching its rendered names against the
 * catalog. Names are matched on their shortened form, which `exerciseNamesAreUnambiguous`
 * guarantees stays one-to-one.
 */
export function exerciseIdsFromDigest(content: string): string[] {
  const byShortName = new Map(
    Object.values(EXERCISES).map((ex) => [shortName(ex.name).toLowerCase(), ex.id])
  );
  const ids: string[] = [];
  for (const line of content.split("\n")) {
    const m = /^›\s*(.+?)\s+—\s/.exec(line.trim());
    if (!m) continue;
    const id = byShortName.get(m[1].trim().toLowerCase());
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Guard for `exerciseIdsFromDigest`: two exercises whose names collapse to the same shortened
 * form would make the reverse lookup ambiguous and silently illustrate the wrong movement.
 * Asserted in tests so adding such a pair fails loudly.
 */
export function exerciseNamesAreUnambiguous(): boolean {
  const seen = new Set<string>();
  for (const ex of Object.values(EXERCISES)) {
    const key = shortName(ex.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

const WANTS_IMAGES =
  /\b(how do i|how do you|how does|how's that|what does .{0,40}look like|what do .{0,40}look like|show me|see (it|them|these|those)|pictures?|photos?|images?|demonstrat|what.*form|form check|not sure how)\b/i;
const BARE_AFFIRMATIVE = /^\s*(y|ya|yes|yeah|yep|yup|sure|ok|okay|please|sounds good|do it)\s*[.!]?\s*$/i;

/**
 * Does this reply to a digest want the illustrations? Narrow on purpose, like parseCadenceReply
 * — anything unrecognised returns null and falls through to normal coaching. A bare "yes" counts
 * because the digest explicitly invites one.
 */
export function parseStrengthFollowUp(
  message: string,
  digestContent?: string
): { wantsImages: true; exerciseIds?: string[] } | null {
  const wants = WANTS_IMAGES.test(message) || BARE_AFFIRMATIVE.test(message);
  if (!wants) return null;

  // "how do I do the clamshells?" — illustrate just that one.
  if (digestContent) {
    const listed = exerciseIdsFromDigest(digestContent);
    const haystack = message.toLowerCase();
    const named = listed.filter((id) => {
      const ex = EXERCISES[id];
      if (!ex) return false;
      const name = shortName(ex.name).toLowerCase();
      // Athletes name an exercise the short way — "how do I do the toe taps?" for
      // "Toe taps on a stair" — so match the leading noun phrase as well as the full name.
      const lead = name.split(/\s+/).slice(0, 2).join(" ");
      return haystack.includes(name) || (lead.length >= 6 && haystack.includes(lead));
    });
    if (named.length > 0 && named.length < listed.length) {
      return { wantsImages: true, exerciseIds: named };
    }
  }
  return { wantsImages: true };
}
