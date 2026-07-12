/**
 * DATE CONTEXT block builder — the race/timezone-independent header portion of
 * buildSystemPrompt's dateContext (coach/respond/route.ts).
 *
 * This is the first slice of the "CoachContext" extraction described in the
 * scoping discussion following the 2026-07-12 date-of-week bug: pull computed
 * facts out of the giant inline template literals in buildSystemPrompt/
 * buildUserMessage into small, independently testable pure functions, so a
 * fact like "what is tomorrow's date" can be pinned down with an exact-value
 * unit test instead of being buried in a 1,000+ line string builder (which is
 * exactly how the timezone reformatting bug shipped unnoticed for so long).
 *
 * Scope note: this covers ONLY the pure date/day-of-week facts (today,
 * yesterday, tomorrow, next 7 days, rest days, conversation-gap detection).
 * The race-countdown and taper-protocol sections that get appended to
 * dateContext after this header remain inline in route.ts for now — they're
 * far more entangled with profile/race/taper state and are a separate,
 * higher-risk extraction to do once this slice has proven the pattern out.
 */

import { getDateFacts } from "./timezone";

const ALL_WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export interface DateContextResult {
  /** The DATE CONTEXT block text (Today/Yesterday/Tomorrow/Next 7 days/Timezone/gap-alert/formatting rules). */
  header: string;
  /** Long format, e.g. "Sunday, July 12, 2026" — also referenced later in the prompt's ATHLETE SNAPSHOT section. */
  todayStr: string;
  /** "YYYY-MM-DD" in the athlete's local timezone — also referenced later (e.g. injury-hold day-count math). */
  todayLocal: string;
  /** Capitalized weekday names with no training session scheduled — also referenced later (REST DAYS rule). */
  restDays: string[];
}

export interface BuildDateContextParams {
  tz: string;
  now: Date;
  trainingDays: string[] | null;
  overrideDays: string[] | null;
  overrideExpires: string | null;
  recentMessages: Array<{ created_at?: string | null }>;
}

/**
 * Compute the conversation-gap note: an explicit temporal anchor telling the model
 * not to treat old messages as current after a multi-day silence. The model sees
 * timestamps on individual messages, but without this it can read a 2-week-old
 * message as "recent" once the conversation resumes.
 */
function buildConversationWindowNote(
  recentMessages: Array<{ created_at?: string | null }>,
  tz: string,
  now: Date
): string {
  if (recentMessages.length === 0) return "";
  const oldest = recentMessages[0];
  const newest = recentMessages[recentMessages.length - 1];
  const oldestDate = oldest.created_at ? new Date(oldest.created_at) : null;
  const newestDate = newest.created_at ? new Date(newest.created_at) : null;
  if (!oldestDate || !newestDate) return "";
  const oldestStr = oldestDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: tz });
  const newestStr = newestDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: tz });
  const daysSinceNewest = Math.round((now.getTime() - newestDate.getTime()) / 86400000);
  let note = `- Conversation window: ${recentMessages.length} messages from ${oldestStr} to ${newestStr}\n`;
  if (daysSinceNewest >= 3) {
    note += `- GAP ALERT: The most recent message in RECENT CONVERSATION is from ${daysSinceNewest} days ago. There has been a gap in this coaching relationship. Do NOT treat messages from before the gap as current context — they describe a previous period. Greet the athlete as returning, not as if you spoke recently.\n`;
  }
  return note;
}

/**
 * Rest days for the current week: the athlete's scheduled training days, inverted,
 * respecting a temporary this-week override if one is active and not yet expired.
 * Mirrors effectiveTrainingDays() in the nightly-reminder cron so the REST DAYS
 * rule Claude sees is consistent with which days the cron actually fires on.
 */
function computeRestDays(
  trainingDays: string[] | null,
  overrideDays: string[] | null,
  overrideExpires: string | null,
  todayLocal: string
): string[] {
  const effectiveTrainingDays: string[] = (
    overrideDays && overrideDays.length > 0 && overrideExpires && todayLocal <= overrideExpires
      ? overrideDays
      : trainingDays ?? []
  ).map((d) => d.toLowerCase());

  if (effectiveTrainingDays.length === 0) return [];
  return ALL_WEEK_DAYS
    .filter((d) => !effectiveTrainingDays.includes(d))
    .map((d) => d.charAt(0).toUpperCase() + d.slice(1));
}

/** Build the DATE CONTEXT header (today/yesterday/tomorrow/next 7 days/rest days), plus the values reused later in the prompt. */
export function buildDateContext(params: BuildDateContextParams): DateContextResult {
  const { tz, now, trainingDays, overrideDays, overrideExpires, recentMessages } = params;

  const todayStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);

  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);

  const restDays = computeRestDays(trainingDays, overrideDays, overrideExpires, todayLocal);

  // getDateFacts handles the yesterday/tomorrow/next-7-days math (and the UTC
  // re-read fix for the reformatting bug — see timezone.ts). Pass `now` through
  // so this header and the caller's own race-countdown math (computed right
  // after, in route.ts) stay pinned to the exact same instant.
  const facts = getDateFacts(tz, now);

  const conversationWindowNote = buildConversationWindowNote(recentMessages, tz, now);

  const header =
    `DATE CONTEXT:\n- Today: ${todayStr}\n- Yesterday: ${facts.yesterday}\n- Tomorrow: ${facts.tomorrow}\n` +
    `- Next 7 days: ${facts.next7Days.join(" | ")}\n- Timezone: ${tz}\n${conversationWindowNote}` +
    `- For future scheduled sessions, use specific calendar dates (e.g. "Friday, Feb 27") rather than vague relative terms like "tomorrow" or "next Monday" — messages may be read after the day they're sent.\n` +
    `- When referencing past activities or events: ONLY say "yesterday" if the event's date or conversation timestamp matches Yesterday above. If it was any earlier, use the weekday name instead ("Monday's double header", "last week's long run"). Recent workouts in the system prompt now include a server-computed label like "(yesterday)" or "(3 days ago)" — use those labels as the authoritative recency signal, not your own inference.\n`;

  return { header, todayStr, todayLocal, restDays };
}
