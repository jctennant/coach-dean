/**
 * Post-processing guard for week-to-date mileage claims.
 *
 * Extracted from coach/respond/route.ts (2026-08-08) when the plan triggers needed
 * it too: on `initial_plan` Dean told an athlete "You've already logged 6.5 mi this
 * week" when the real figure was 20.3 — the 6.5 was his own plan's Saturday long-run
 * distance, restated as if it were mileage already run. The Phase B fact gate didn't
 * catch it because the `stated_facts` echo reported no week-to-date figure at all,
 * and this corrector (which matches the literal claim in the text and would have
 * caught it) only ran on post_run/user_message.
 *
 * Two modes, because "X mi this week" means different things on different triggers:
 * - Default (post_run, user_message): any "X mi this week" phrasing is a week-to-date
 *   claim, since those messages are looking backward at what's been run.
 * - `requireCompletedContext` (initial_plan, weekly_recap): those messages legitimately
 *   state a *planned* total for the week ahead in the same shape ("16 mi this week"),
 *   so only rewrite when the surrounding words mark the number as already completed
 *   ("logged", "already", "so far", "you're at"). Anything else is left alone.
 */

/** Words that mark a number as mileage already run, not mileage being prescribed. */
const COMPLETED_CONTEXT =
  /\b(logged|already|so far|to date|banked|in the bank|you(?:'| a)?re at|you(?:'| ha)?ve (?:run|done|got)|completed|clocked|racked up|put (?:in|down))\b/i;

/** Phrasings handled by correctProjectedTotal instead — never touched here. */
const PROJECTION_LEAD_IN =
  /(?:on\s+track\s+for|on\s+pace\s+for|projected|aiming\s+for|target(?:ing)?|to\s+hit|should\s+hit|expecting|projecting)\s+~?\s*$/i;

/**
 * Rewrite a stated week-to-date total that diverges from the system-computed value.
 * Returns the message unchanged when there's nothing to correct.
 */
export function correctWeekToDateTotal(
  message: string,
  weekMileageSoFar: number | null,
  isMetric: boolean,
  opts: { requireCompletedContext?: boolean } = {}
): string {
  if (weekMileageSoFar == null || weekMileageSoFar < 0) return message;
  const correctValue = isMetric
    ? Math.round(weekMileageSoFar * 1.60934 * 10) / 10
    : Math.round(weekMileageSoFar * 10) / 10;
  const unitGroup = isMetric ? "km" : "mi(?:les?)?";
  const pattern = new RegExp(
    `(\\d+(?:\\.\\d+)?)(\\s*${unitGroup}[ \\t]*(?:for|this)[ \\t]+(?:the[ \\t]+)?week\\b)`,
    "gi"
  );
  return message.replace(pattern, (full, num, suffix, offset: number) => {
    const stated = parseFloat(num);
    if (Math.abs(stated - correctValue) <= 0.4) return full;
    const before = message.slice(Math.max(0, offset - 40), offset);
    if (PROJECTION_LEAD_IN.test(before)) return full;
    if (opts.requireCompletedContext) {
      // Only look back as far as the start of the current sentence — a "logged" in the
      // preceding sentence says nothing about whether THIS number is already-run mileage,
      // and a message that states both a week-to-date total and a planned target routinely
      // has them one sentence apart.
      const sentenceStart = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("\n"));
      const clause = sentenceStart === -1 ? before : before.slice(sentenceStart + 1);
      if (!COMPLETED_CONTEXT.test(clause)) return full;
    }
    console.warn(`[correctWeekToDateTotal] stated ${stated} WTD, system says ${correctValue} — correcting`);
    return `${correctValue}${suffix}`;
  });
}
