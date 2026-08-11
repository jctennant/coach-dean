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

/** Is this message asking to be shown a movement, rather than merely answering a question? */
export function wantsExerciseImages(message: string): boolean {
  return WANTS_IMAGES.test(message);
}

/**
 * Shorthand athletes use that isn't a substring of the catalog name. Kept deliberately small and
 * factual — these are alternate *names for a movement*, a stable vocabulary, not a list of ways
 * to phrase a request (which is what CLAUDE.md warns against maintaining).
 */
const EXERCISE_ALIASES: Record<string, string[]> = {
  tib_anterior_raise: ["tib raise", "tib raises", "tibialis raise", "tibialis raises"],
  band_dorsiflexion: ["dorsiflexion", "band dorsiflexion"],
  ecc_calf_raise_straight: ["eccentric calf raise", "eccentric calf raises"],
  ecc_heel_drop: ["heel drop", "heel drops"],
  single_leg_calf_raise: ["single leg calf raise", "single leg calf raises"],
  clamshells: ["clamshell", "clamshells"],
  nordic_curls: ["nordic", "nordics", "nordic curl"],
  single_leg_rdl: ["rdl", "rdls", "single leg deadlift"],
  frozen_bottle_roll: ["bottle roll", "frozen bottle"],
  worlds_greatest_stretch: ["worlds greatest", "world's greatest"],
  figure_4_stretch: ["figure 4", "figure four"],
  short_foot: ["short foot"],
  towel_toe_curl: ["towel curl", "towel curls", "toe curls"],
  seated_adductor_isometric: ["adductor squeeze", "adductor squeezes"],
  single_leg_glute_bridge: ["single leg bridge", "single leg glute bridge"],
};

function containsPhrase(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Which catalog exercises does this message name outright?
 *
 * Catalog-wide (not restricted to a routine), because an athlete asks about a movement wherever
 * it came up — Dean naming it in prose, a routine sent days ago, or memory — not only in reply to
 * the digest bubble. Matching is on the full shortened name or an explicit alias: leading-phrase
 * matching is only safe *within* one digest's list, since across the whole catalog "single leg"
 * alone matches five different exercises.
 */
export function exerciseIdsNamedIn(message: string, restrictTo?: string[]): string[] {
  const haystack = message.toLowerCase();
  const candidates = restrictTo?.length ? restrictTo : Object.keys(EXERCISES);
  const named: string[] = [];
  for (const id of candidates) {
    const ex = EXERCISES[id];
    if (!ex) continue;
    const name = shortName(ex.name).toLowerCase();
    const phrases = [name, ...(EXERCISE_ALIASES[id] ?? [])];
    // Within a known list, the leading noun phrase is unambiguous enough to match on —
    // "how do I do the toe taps?" for "Toe taps on a stair".
    if (restrictTo?.length) {
      const lead = name.split(/\s+/).slice(0, 2).join(" ");
      if (lead.length >= 6) phrases.push(lead);
    }
    if (phrases.some((p) => containsPhrase(haystack, p))) named.push(id);
  }
  return named;
}

/**
 * Does this message want illustrations, and of what?
 *
 * Two ways in, and the split matters. Naming an exercise ("can you show me how the ankle alphabet
 * goes?") stands on its own — it needs no conversational setup, because the athlete already told
 * us exactly which movement they mean. A bare "yes"/"show me" only means images when the previous
 * assistant message was the digest that invited one; without that anchor it's ambiguous and
 * belongs to normal coaching.
 *
 * Returns concrete exercise ids, or null to fall through. Narrow on purpose, like parseCadenceReply.
 */
export function parseExerciseImageRequest(
  message: string,
  opts: { previousDigest?: string | null } = {}
): { exerciseIds: string[] } | null {
  if (!WANTS_IMAGES.test(message) && !BARE_AFFIRMATIVE.test(message)) return null;

  const digestIds = opts.previousDigest ? exerciseIdsFromDigest(opts.previousDigest) : [];

  // Prefer names read out of the digest, so a reply to it can't pull in an unrelated exercise.
  const named = digestIds.length
    ? exerciseIdsNamedIn(message, digestIds)
    : exerciseIdsNamedIn(message);
  if (named.length > 0 && named.length < (digestIds.length || Infinity)) {
    return { exerciseIds: named };
  }

  if (digestIds.length > 0) return { exerciseIds: digestIds };
  return null;
}

/**
 * Does this reply to a digest want the illustrations? Thin wrapper over
 * `parseExerciseImageRequest` for the digest-reply case, kept for its narrower return shape
 * (omitted `exerciseIds` = "everything the digest listed").
 */
export function parseStrengthFollowUp(
  message: string,
  digestContent?: string
): { wantsImages: true; exerciseIds?: string[] } | null {
  const parsed = parseExerciseImageRequest(message, { previousDigest: digestContent ?? null });
  if (!parsed) return null;
  const listed = digestContent ? exerciseIdsFromDigest(digestContent) : [];
  if (listed.length > 0 && parsed.exerciseIds.length < listed.length) {
    return { wantsImages: true, exerciseIds: parsed.exerciseIds };
  }
  return { wantsImages: true };
}
