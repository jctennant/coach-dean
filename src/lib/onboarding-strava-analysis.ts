/**
 * Deep Strava read for the onboarding post-connect analysis message
 * (handleDataAnalysis in onboarding/handle/route.ts).
 *
 * The aggregate context that stage already had (8-week average, weekly array, HR
 * zone split, one spike %) is enough to say "you're running ~30 mi/week" but not
 * enough to say anything an athlete couldn't read off their own Strava profile:
 * it has no week boundaries with dates, no individual runs, and no access to what
 * the athlete titled those runs. That's the whole substance of a first read —
 * *when* the load went up, *which* week it broke, what they wrote on the run where
 * it hurt.
 *
 * This module turns raw activity rows into that read. It is pure (no DB, no LLM):
 * callers pass rows, it returns a prompt block plus every number it stated, so the
 * caller can extend the fact-check allow-list (checkStravaAnalysisNumbers) with
 * exactly the figures it just made citable. Adding data to the prompt without
 * adding it to the allow-list would make the fact gate reject true statements.
 */

export type AnalysisRun = {
  start_date: string | null;
  distance_meters: number | null;
  moving_time_seconds: number | null;
  elevation_gain: number | null;
  average_heartrate: number | null;
  activity_type: string | null;
  activity_name: string | null;
  workout_type?: number | null;
};

export type DeepReadLens = "injury" | "race" | "general";

export type DeepStravaRead = {
  /** Prompt block to inject, or "" when there isn't enough data to say anything. */
  text: string;
  /** Every figure the block states — feed into the fact-check allow-list. */
  groundTruthNumbers: number[];
};

const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
const METERS_PER_MILE = 1609.34;
const FT_PER_METER = 3.28084;

/** Athlete-written words that flag pain/injury in a run title. */
const INJURY_TITLE_RE =
  /\b(pain|painful|hurt|sore|soreness|ache|aching|achy|niggle|tight|tightness|injur\w*|shin|shins|knee|itb|it band|achilles|calf|hamstring|hip|plantar|fascia|glute|tendon|tendin\w*|strain|sprain|stress fracture|cut short|cut it short|shut down|bailed|limp\w*|rehab|physio|pt session|easy day off|test run|first run back|back from|comeback)\b/i;

/** Athlete-written words that flag a quality/hard session in a run title. */
const QUALITY_TITLE_RE =
  /\b(tempo|threshold|interval\w*|repeat\w*|rep[s]?\b|track|workout|speed|fartlek|hills?|hill repeats|progression|steady state|marathon pace|mp\b|hm pace|5k pace|10k pace|time trial|tt\b|race|vo2|strides)\b/i;

function toMiles(meters: number | null | undefined): number {
  return (meters ?? 0) / METERS_PER_MILE;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmtPace(meters: number | null, seconds: number | null): string | null {
  const miles = toMiles(meters);
  if (!seconds || miles < 0.3) return null;
  const secPerMile = seconds / miles;
  if (!Number.isFinite(secPerMile) || secPerMile < 240 || secPerMile > 1200) return null;
  const m = Math.floor(secPerMile / 60);
  const s = Math.round(secPerMile % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function paceSeconds(meters: number | null, seconds: number | null): number | null {
  const miles = toMiles(meters);
  if (!seconds || miles < 0.3) return null;
  const secPerMile = seconds / miles;
  if (!Number.isFinite(secPerMile) || secPerMile < 240 || secPerMile > 1200) return null;
  return secPerMile;
}

function fmtPaceFromSeconds(secPerMile: number): string {
  const m = Math.floor(secPerMile / 60);
  const s = Math.round(secPerMile % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtDayDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Monday-00:00 UTC of the week containing `ms`. Matches the calendar-week alignment
 *  the Strava callback already uses for its weekly breakdown. */
function weekStartMs(ms: number): number {
  const d = new Date(ms);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
}

type WeekBucket = {
  startMs: number;
  miles: number;
  runs: number;
  longestMiles: number;
  elevFt: number;
};

function bucketWeeks(runs: AnalysisRun[], now: number, weeks: number): WeekBucket[] {
  const currentWeekStart = weekStartMs(now);
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const buckets = new Map<number, WeekBucket>();
  // Seed every week in range so gaps (zero-mileage weeks) are visible, not skipped —
  // a missing week is exactly the signal an injury read is looking for.
  for (let i = weeks - 1; i >= 0; i--) {
    const startMs = currentWeekStart - i * msPerWeek;
    buckets.set(startMs, { startMs, miles: 0, runs: 0, longestMiles: 0, elevFt: 0 });
  }
  for (const r of runs) {
    if (!r.start_date) continue;
    const t = new Date(r.start_date).getTime();
    const ws = weekStartMs(t);
    const b = buckets.get(ws);
    if (!b) continue;
    const miles = toMiles(r.distance_meters);
    b.miles += miles;
    b.runs += 1;
    b.longestMiles = Math.max(b.longestMiles, miles);
    b.elevFt += (r.elevation_gain ?? 0) * FT_PER_METER;
  }
  return [...buckets.values()].sort((a, b) => a.startMs - b.startMs);
}

export function buildDeepStravaRead(
  activities: AnalysisRun[],
  opts: {
    lens: DeepReadLens;
    /** Defaults to now; injectable for tests. */
    nowMs?: number;
    /** How many calendar weeks of build to show. */
    weeks?: number;
  }
): DeepStravaRead {
  const now = opts.nowMs ?? Date.now();
  const weeks = opts.weeks ?? 12;
  const nums: number[] = [];
  const push = (...values: Array<number | null | undefined>) => {
    for (const v of values) {
      if (v != null && Number.isFinite(v)) nums.push(v);
    }
  };

  const runs = activities
    .filter((a) => a.start_date && RUN_TYPES.has(a.activity_type ?? "") && (a.distance_meters ?? 0) > 400)
    .sort((a, b) => new Date(a.start_date!).getTime() - new Date(b.start_date!).getTime());

  if (runs.length < 3) return { text: "", groundTruthNumbers: [] };

  const sections: string[] = [];
  const buckets = bucketWeeks(runs, now, weeks);
  const populated = buckets.filter((b) => b.runs > 0);

  // ── Weekly build, with dates so Dean can name *when* something happened ──────
  const buildLines: string[] = [];
  const firstPopulatedIdx = buckets.findIndex((b) => b.runs > 0);
  for (const b of buckets.slice(Math.max(0, firstPopulatedIdx))) {
    const start = new Date(b.startMs);
    const end = new Date(b.startMs + 6 * 24 * 60 * 60 * 1000);
    const isCurrent = b.startMs === weekStartMs(now);
    const miles = round1(b.miles);
    const longest = round1(b.longestMiles);
    push(miles, longest, b.runs);
    buildLines.push(
      `  ${fmtDate(start)}–${fmtDate(end)}${isCurrent ? " (current, partial)" : ""}: ${miles} mi / ${b.runs} run${b.runs === 1 ? "" : "s"}${longest > 0 ? `, longest ${longest} mi` : ""}`
    );
  }
  if (buildLines.length > 0) {
    sections.push(`WEEKLY BUILD (Mon–Sun, oldest→newest):\n${buildLines.join("\n")}`);
  }

  // ── Last 7 days, run by run — the detail the athlete remembers ───────────────
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recentRuns = runs.filter((r) => new Date(r.start_date!).getTime() >= sevenDaysAgo);
  if (recentRuns.length > 0) {
    const lines = recentRuns.map((r) => {
      const miles = round1(toMiles(r.distance_meters));
      const pace = fmtPace(r.distance_meters, r.moving_time_seconds);
      const hr = r.average_heartrate ? Math.round(r.average_heartrate) : null;
      const elevFt = r.elevation_gain ? Math.round(r.elevation_gain * FT_PER_METER) : null;
      push(miles, hr, elevFt);
      const parts = [`${miles} mi`];
      if (pace) parts.push(`${pace}/mi`);
      if (hr) parts.push(`${hr} bpm avg`);
      if (elevFt && elevFt >= 100) parts.push(`${elevFt} ft`);
      const title = (r.activity_name ?? "").trim();
      return `  ${fmtDayDate(new Date(r.start_date!))} — ${parts.join(", ")}${title ? ` — "${title}"` : ""}`;
    });
    const weekTotal = round1(recentRuns.reduce((s, r) => s + toMiles(r.distance_meters), 0));
    push(weekTotal);
    sections.push(`LAST 7 DAYS (${weekTotal} mi across ${recentRuns.length} run${recentRuns.length === 1 ? "" : "s"}):\n${lines.join("\n")}`);
  } else {
    const daysSince = Math.floor((now - new Date(runs[runs.length - 1].start_date!).getTime()) / (24 * 60 * 60 * 1000));
    push(daysSince);
    sections.push(`LAST 7 DAYS: no runs logged. Most recent run was ${daysSince} days ago.`);
  }

  // ── Load flags: where the build jumped, stacked, or broke ────────────────────
  const flags: string[] = [];
  // Exclude the current partial week from jump/drop math — it always reads as a crash.
  const completed = populated.filter((b) => b.startMs !== weekStartMs(now));

  let biggestJump: { pct: number; from: WeekBucket; to: WeekBucket } | null = null;
  let biggestDrop: { pct: number; from: WeekBucket; to: WeekBucket } | null = null;
  for (let i = 1; i < completed.length; i++) {
    const prev = completed[i - 1];
    const cur = completed[i];
    if (prev.miles < 5) continue;
    const pct = Math.round(((cur.miles - prev.miles) / prev.miles) * 100);
    if (pct >= 15 && (!biggestJump || pct > biggestJump.pct)) biggestJump = { pct, from: prev, to: cur };
    if (pct <= -25 && (!biggestDrop || pct < biggestDrop.pct)) biggestDrop = { pct, from: prev, to: cur };
  }
  if (biggestJump) {
    const { pct, from, to } = biggestJump;
    push(pct, round1(from.miles), round1(to.miles));
    flags.push(
      `  - Biggest load jump: ${round1(from.miles)} mi (wk of ${fmtDate(new Date(from.startMs))}) → ${round1(to.miles)} mi (wk of ${fmtDate(new Date(to.startMs))}), +${pct}%`
    );
  }
  if (biggestDrop) {
    const { pct, from, to } = biggestDrop;
    push(Math.abs(pct), round1(from.miles), round1(to.miles));
    flags.push(
      `  - Biggest volume drop: ${round1(from.miles)} mi (wk of ${fmtDate(new Date(from.startMs))}) → ${round1(to.miles)} mi (wk of ${fmtDate(new Date(to.startMs))}), ${pct}% — a drop like this usually means something interrupted training (injury, illness, travel); confirm with the athlete rather than assuming`
    );
  }
  // Consecutive build weeks with no down week — the classic overuse setup.
  let runLen = 1;
  let bestRun: { len: number; from: WeekBucket; to: WeekBucket } | null = null;
  for (let i = 1; i < completed.length; i++) {
    if (completed[i].miles > completed[i - 1].miles && completed[i - 1].miles > 3) {
      runLen++;
      if (!bestRun || runLen > bestRun.len) bestRun = { len: runLen, from: completed[i - runLen + 1], to: completed[i] };
    } else {
      runLen = 1;
    }
  }
  if (bestRun && bestRun.len >= 3) {
    push(bestRun.len);
    flags.push(
      `  - ${bestRun.len} straight weeks of increasing volume with no down week (wk of ${fmtDate(new Date(bestRun.from.startMs))} → wk of ${fmtDate(new Date(bestRun.to.startMs))})`
    );
  }
  // Long run out of proportion to the week it sat in.
  let worstLongRun: { pct: number; bucket: WeekBucket } | null = null;
  for (const b of completed) {
    // Needs a real training week behind it — in a 1–2 run week the long run is
    // trivially most of the volume, which says nothing about how it was distributed.
    if (b.miles < 8 || b.longestMiles <= 0 || b.runs < 3) continue;
    const pct = Math.round((b.longestMiles / b.miles) * 100);
    if (pct >= 40 && (!worstLongRun || pct > worstLongRun.pct)) worstLongRun = { pct, bucket: b };
  }
  if (worstLongRun) {
    push(worstLongRun.pct, round1(worstLongRun.bucket.longestMiles), round1(worstLongRun.bucket.miles));
    flags.push(
      `  - Long run heavy: ${round1(worstLongRun.bucket.longestMiles)} mi was ${worstLongRun.pct}% of that week's ${round1(worstLongRun.bucket.miles)} mi (wk of ${fmtDate(new Date(worstLongRun.bucket.startMs))})`
    );
  }
  if (flags.length > 0) sections.push(`LOAD FLAGS:\n${flags.join("\n")}`);

  // ── What the athlete wrote on their own runs ─────────────────────────────────
  const titled = runs.filter((r) => (r.activity_name ?? "").trim().length > 0);
  const injuryTitles = titled.filter((r) => INJURY_TITLE_RE.test(r.activity_name!)).slice(-6);
  if (injuryTitles.length > 0) {
    const lines = injuryTitles.map((r) => {
      const miles = round1(toMiles(r.distance_meters));
      push(miles);
      return `  - ${fmtDate(new Date(r.start_date!))}: "${r.activity_name!.trim()}" (${miles} mi)`;
    });
    sections.push(
      `RUN TITLES MENTIONING PAIN/INJURY (athlete's own words — treat as a lead to ask about, not a diagnosis):\n${lines.join("\n")}`
    );
  }

  if (opts.lens === "race" || opts.lens === "general") {
    const qualityRuns = titled.filter((r) => QUALITY_TITLE_RE.test(r.activity_name!));
    const fourWeeksAgo = now - 28 * 24 * 60 * 60 * 1000;
    const qualityLast4 = qualityRuns.filter((r) => new Date(r.start_date!).getTime() >= fourWeeksAgo);
    if (qualityRuns.length > 0) {
      push(qualityRuns.length, qualityLast4.length);
      const recent = qualityRuns.slice(-3).map((r) => {
        const pace = fmtPace(r.distance_meters, r.moving_time_seconds);
        const miles = round1(toMiles(r.distance_meters));
        push(miles);
        return `  - ${fmtDate(new Date(r.start_date!))}: "${r.activity_name!.trim()}" (${miles} mi${pace ? ` @ ${pace}/mi` : ""})`;
      });
      sections.push(
        `QUALITY / HARD SESSIONS (inferred from run titles — ${qualityRuns.length} in this window, ${qualityLast4.length} in the last 4 weeks):\n${recent.join("\n")}`
      );
    } else if (titled.length >= 5) {
      sections.push(
        `QUALITY / HARD SESSIONS: none identifiable from run titles in this window — the build reads as all steady running. Titles are not proof, so treat this as a question to ask, not a fact to state.`
      );
    }

    // Easy-pace comparison across halves of the window — is the aerobic base moving?
    const half = now - (weeks / 2) * 7 * 24 * 60 * 60 * 1000;
    const easyRuns = runs.filter((r) => !QUALITY_TITLE_RE.test(r.activity_name ?? "") && paceSeconds(r.distance_meters, r.moving_time_seconds) != null);
    const olderEasy = easyRuns.filter((r) => new Date(r.start_date!).getTime() < half);
    const newerEasy = easyRuns.filter((r) => new Date(r.start_date!).getTime() >= half);
    if (olderEasy.length >= 3 && newerEasy.length >= 3) {
      const avg = (rs: AnalysisRun[]) =>
        rs.reduce((s, r) => s + (paceSeconds(r.distance_meters, r.moving_time_seconds) ?? 0), 0) / rs.length;
      const oldAvg = avg(olderEasy);
      const newAvg = avg(newerEasy);
      const deltaSec = Math.round(oldAvg - newAvg);
      push(Math.abs(deltaSec));
      sections.push(
        `EASY-RUN PACE: ${fmtPaceFromSeconds(newAvg)}/mi over the recent half of this window vs ${fmtPaceFromSeconds(oldAvg)}/mi earlier (${deltaSec >= 0 ? `${deltaSec}s/mi faster` : `${Math.abs(deltaSec)}s/mi slower`}). Only call this out if the gap is 10s/mi or more — smaller gaps are terrain and weather noise.`
      );
    }
  }

  if (sections.length === 0) return { text: "", groundTruthNumbers: [] };

  const header =
    opts.lens === "injury"
      ? "DEEPER READ — read this through the injury lens: find where load increased or broke down, and what the athlete wrote on those runs."
      : opts.lens === "race"
        ? "DEEPER READ — read this through the race lens: is this build tracking toward the goal, or is something missing?"
        : "DEEPER READ:";

  return {
    text: `\n\n${header}\n${sections.join("\n\n")}`,
    groundTruthNumbers: nums,
  };
}
