/**
 * Turns raw pain_checkins rows into a trend Dean can reference with real numbers, and decides
 * when a functional test (see exercise-library.ts FUNCTIONAL_TESTS) is warranted as the next
 * concrete progression step — instead of "felt a bit better than yesterday" staying a vague,
 * unmeasured impression that never turns into a decision either way.
 */

export interface PainCheckin {
  date: string; // YYYY-MM-DD
  pain_level: number; // 0-10
}

export interface PainTrend {
  /** Chronological (oldest first), most recent 14 entries. */
  entries: PainCheckin[];
  latest: number | null;
  direction: "improving" | "worsening" | "flat" | null;
  /** Count of trailing check-ins (most recent backward) at or below the low-pain threshold, unbroken by a higher reading. */
  lowPainStreak: number;
}

const LOW_PAIN_THRESHOLD = 1;

export function computePainTrend(rows: PainCheckin[]): PainTrend {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  if (sorted.length === 0) {
    return { entries: [], latest: null, direction: null, lowPainStreak: 0 };
  }
  const latest = sorted[sorted.length - 1].pain_level;
  let direction: PainTrend["direction"] = null;
  if (sorted.length >= 2) {
    const first = sorted[0].pain_level;
    if (latest <= first - 1) direction = "improving";
    else if (latest >= first + 1) direction = "worsening";
    else direction = "flat";
  }
  let lowPainStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].pain_level <= LOW_PAIN_THRESHOLD) lowPainStreak++;
    else break;
  }
  return { entries: sorted, latest, direction, lowPainStreak };
}

/**
 * Build the prompt block for an active injury/hold context. Returns "" when there's no
 * meaningful history yet (nothing logged, or too little to say anything useful).
 */
export function buildPainTrendBlock(trend: PainTrend, functionalTest: string | null): string {
  if (trend.entries.length === 0) return "";
  const history = trend.entries.map((e) => `${e.date}: ${e.pain_level}/10`).join(", ");
  const directionLine = trend.direction
    ? `Trend: ${trend.direction} (first logged reading ${trend.entries[0].pain_level}/10 → latest ${trend.latest}/10).`
    : "";
  const gate = functionalTest && trend.lowPainStreak >= 3
    ? `\nPROGRESSION GATE MET: pain has been at or below ${LOW_PAIN_THRESHOLD}/10 for ${trend.lowPainStreak} consecutive check-ins. If they haven't done the functional test yet this stretch, prescribe it now as the next concrete step (don't just say "keep going" — give them something to actually do): "${functionalTest}" If they report passing it pain-free, that's real grounds to progress (advance the rehab exercises, add a short test run, or move toward clearing the hold). If they haven't tried it, ask them to and report back. If they fail it or it's not been offered yet, do not claim readiness to progress from the pain trend alone.`
    : "";
  return `\n\nPAIN TREND (from logged check-ins, use these real numbers instead of relying on how the conversation remembers it): ${history}. ${directionLine}${gate}\n\n`;
}
