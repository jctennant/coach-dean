import type { Metadata } from "next";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import RequestLinkForm from "./request-link-form";
import { TokenPersist } from "./token-manager";
import { DashboardTabs } from "./tab-container";
import { PlanTab } from "./plan-tab";
import type { PlanWeek, PlanSession, PlanRace } from "./plan-tab";
import { computeLoadTrend, computeAerobicEfficiencyTrend } from "@/lib/training-analytics";
import type { ActivityForAnalytics } from "@/lib/training-analytics";
import { predictRaceTime, estimateVDOT, predictTimeFromVDOT } from "@/lib/race-predictor";

export const metadata: Metadata = {
  title: "Your Dashboard — Coach Dean",
  description: "Your training insights from Coach Dean.",
};

// ─── Types ────────────────────────────────────────────────────────────────────

type StravaBestEffort = {
  name: string;           // "5k", "10k", "1 mile", "Half-Marathon", "Marathon", etc.
  elapsed_time: number;   // seconds
  distance: number;       // meters
  start_date: string;     // ISO timestamp within the activity
  pr_rank: number | null; // 1=PR, 2=2nd all-time, null=not a PR
};

type ActivityRow = {
  strava_activity_id: number | null;
  start_date: string;
  distance_meters: number | null;
  moving_time_seconds: number | null;
  elapsed_time_seconds: number | null;
  activity_type: string | null;
  average_heartrate: number | null;
  aerobic_efficiency: number | null;
  cardiac_decoupling_pct: number | null;
  workout_type: number | null;
  best_efforts: StravaBestEffort[] | null;
  activity_name: string | null;
};

type Race = {
  id: string;
  race_name: string | null;
  race_date: string;
  priority: string | null;
  goal_distance_miles: number | null;
  goal_time_minutes: number | null;
  goal: string | null;
};

type ConversationRow = {
  content: string;
  message_type: string | null;
  created_at: string | null;
  strava_activity_id: number | null;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function formatTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.floor(totalMinutes % 60);
  const s = Math.round((totalMinutes % 1) * 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Format a date string for display. Handles both date-only ("2026-05-17") and
 * full ISO timestamps ("2026-04-12T15:08:28+00:00") from Strava/Supabase.
 * Appends T12:00:00Z only for date-only strings so the local-date parsing is stable.
 */
function formatDate(dateStr: string, fmt: "short" | "long" = "short"): string {
  const d = dateStr.length === 10 ? new Date(dateStr + "T12:00:00Z") : new Date(dateStr);
  return d.toLocaleDateString("en-US",
    fmt === "long"
      ? { month: "long", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" }
  );
}

function daysUntil(dateStr: string): number | null {
  const days = Math.ceil(
    (new Date(dateStr + "T12:00:00Z").getTime() - Date.now()) / (24 * 60 * 60 * 1000)
  );
  return days > 0 ? days : null;
}

function pluralWeeks(days: number): string {
  const weeks = Math.floor(days / 7);
  if (weeks < 2) return `${days} days`;
  return `${weeks} weeks`;
}

/** Compute aerobic efficiency (m/beat) from raw activity if stored column is null */
function getAerobicEfficiency(a: ActivityRow): number | null {
  if (a.aerobic_efficiency != null && a.aerobic_efficiency > 0) return a.aerobic_efficiency;
  if (
    a.distance_meters != null && a.distance_meters > 0 &&
    a.moving_time_seconds != null && a.moving_time_seconds > 0 &&
    a.average_heartrate != null && a.average_heartrate > 0
  ) {
    return a.distance_meters / ((a.moving_time_seconds / 60) * a.average_heartrate);
  }
  return null;
}

/** Build ISO week key (Mon) for a date in a given timezone */
function weekKey(date: Date, timezone: string): string {
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const [y, m, d] = localStr.split("-").map(Number);
  const local = new Date(Date.UTC(y!, m! - 1, d!));
  const dow = local.getUTCDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mon = new Date(Date.UTC(y!, m! - 1, d! - daysToMon));
  return mon.toISOString().slice(0, 10);
}

/** Last 12 weeks of mileage for chart, oldest→newest */
function buildWeeklyMiles(
  activities: ActivityRow[],
  timezone: string
): { label: string; miles: number; isCurrent: boolean }[] {
  const RUN = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  const byWeek: Record<string, number> = {};
  for (const a of activities) {
    if (!RUN.has(a.activity_type ?? "")) continue;
    if (!a.distance_meters || !a.start_date) continue;
    const k = weekKey(new Date(a.start_date), timezone);
    byWeek[k] = (byWeek[k] ?? 0) + a.distance_meters / 1609.34;
  }

  const now = new Date();
  const thisKey = weekKey(now, timezone);
  const result: { label: string; miles: number; isCurrent: boolean }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const k = weekKey(d, timezone);
    const label = new Date(k + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    result.push({ label, miles: Math.round((byWeek[k] ?? 0) * 10) / 10, isCurrent: k === thisKey });
  }
  return result;
}

// All Strava best-effort names in distance order — used for scanning activities.
const EFFORT_ORDER = [
  "400m", "1/2 mile", "1K", "1 mile", "2 mile",
  "5k", "10k", "15k", "10 mile", "20k",
  "Half-Marathon", "Marathon", "50k",
];

// The 5 distances shown on the PR panel. Keeps the section tight and relevant.
const PR_DISPLAY_EFFORTS = ["1 mile", "10k", "Half-Marathon", "Marathon", "50k"];

// Canonical distance in meters for pace calculation per effort name
const EFFORT_METERS: Record<string, number> = {
  "400m": 400, "1/2 mile": 805, "1K": 1000, "1 mile": 1609,
  "2 mile": 3219, "5k": 5000, "10k": 10000, "15k": 15000,
  "10 mile": 16093, "20k": 20000, "Half-Marathon": 21097,
  "Marathon": 42195, "50k": 50000,
};

// Display labels for the UI
const EFFORT_LABEL: Record<string, string> = {
  "400m": "400m", "1/2 mile": "½ mile", "1K": "1K", "1 mile": "1 mile",
  "2 mile": "2 mile", "5k": "5K", "10k": "10K", "15k": "15K",
  "10 mile": "10 mile", "20k": "20K", "Half-Marathon": "Half",
  "Marathon": "Marathon", "50k": "50K",
};

type ManualPRs = Record<string, { time_seconds: number; date?: string }>;

/**
 * Build PR list from activities + manual overrides.
 *
 * Primary: scan Strava best_efforts on each activity — finds the fastest time
 * for each named distance across all stored activities. Manual PRs (stated via SMS)
 * are merged in: shown when no Strava data exists, or when the manual time is faster.
 *
 * Fallback (when best_efforts not yet backfilled): find the fastest elapsed
 * time in a generous distance band around each standard distance.
 */
type PREntry = {
  label: string;
  time: string;
  pace: string;
  date: string | null;
  activityName: string | null;
  source: "strava" | "manual";
  effortName: string; // canonical key e.g. "5K" — used for fitness signal lookup
};

function buildPRs(activities: ActivityRow[], manualPRs: ManualPRs = {}): PREntry[] {
  const RUN = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  // Attempt 1: use stored Strava best_efforts
  const hasBestEfforts = activities.some(a => a.best_efforts?.length);
  if (hasBestEfforts || Object.keys(manualPRs).length > 0) {
    const best: Record<string, {
      elapsed_time: number;
      activityDate: string;
      activityName: string | null;
      source: "strava" | "manual";
    }> = {};

    for (const activity of activities) {
      for (const effort of activity.best_efforts ?? []) {
        const key = effort.name;
        if (!best[key] || effort.elapsed_time < best[key]!.elapsed_time) {
          best[key] = {
            elapsed_time: effort.elapsed_time,
            activityDate: activity.start_date,
            activityName: activity.activity_name ?? null,
            source: "strava",
          };
        }
      }
    }

    for (const [distance, manual] of Object.entries(manualPRs)) {
      if (!manual.time_seconds || manual.time_seconds <= 0) continue;
      if (!best[distance] || manual.time_seconds < best[distance]!.elapsed_time) {
        best[distance] = {
          elapsed_time: manual.time_seconds,
          activityDate: manual.date ?? "",
          activityName: null,
          source: "manual",
        };
      }
    }

    return EFFORT_ORDER.flatMap(name => {
      const b = best[name];
      if (!b) return [];
      const distM = EFFORT_METERS[name] ?? 1;
      const mins = b.elapsed_time / 60;
      const minPerMile = (b.elapsed_time / distM) * 1609.34 / 60;
      const pm = Math.floor(minPerMile);
      const ps = Math.round((minPerMile - pm) * 60);
      return [{
        label: EFFORT_LABEL[name] ?? name,
        time: formatTime(mins),
        pace: `${pm}:${String(ps).padStart(2, "0")}/mi`,
        date: b.activityDate ? formatDate(b.activityDate, "long") : null,
        activityName: b.activityName,
        source: b.source,
        effortName: name,
      }];
    });
  }

  // Fallback: compute from distance bands on stored activities
  const FALLBACK_BANDS = [
    { name: "1 mile",    label: "1 mile",    minM: 1550,  maxM: 1700  },
    { name: "5K",        label: "5K",        minM: 4700,  maxM: 5400  },
    { name: "10K",       label: "10K",       minM: 9400,  maxM: 10900 },
    { name: "Half-Marathon", label: "Half",  minM: 20000, maxM: 22000 },
    { name: "Marathon",  label: "Marathon",  minM: 41000, maxM: 43600 },
  ];
  return FALLBACK_BANDS.flatMap(dist => {
    const best = activities
      .filter(a =>
        RUN.has(a.activity_type ?? "") &&
        (a.distance_meters ?? 0) >= dist.minM &&
        (a.distance_meters ?? 0) <= dist.maxM &&
        (a.elapsed_time_seconds ?? a.moving_time_seconds) != null
      )
      .sort((a, b) =>
        (a.elapsed_time_seconds ?? a.moving_time_seconds ?? 0) -
        (b.elapsed_time_seconds ?? b.moving_time_seconds ?? 0)
      )[0];
    if (!best) return [];
    const secs = best.elapsed_time_seconds ?? best.moving_time_seconds ?? 0;
    const mins = secs / 60;
    const secPerM = secs / (best.distance_meters ?? 1);
    const minPerMile = secPerM * 1609.34 / 60;
    const pm = Math.floor(minPerMile);
    const ps = Math.round((minPerMile - pm) * 60);
    return [{
      label: dist.label,
      time: formatTime(mins),
      pace: `${pm}:${String(ps).padStart(2, "0")}/mi`,
      date: formatDate(best.start_date, "long"),
      activityName: best.activity_name ?? null,
      source: "strava" as const,
      effortName: dist.name,
    }];
  });
}

/**
 * Weekly average aerobic efficiency from non-race runs with HR data.
 * Returns last 16 weeks that have at least one qualifying run — sparse weeks
 * are skipped rather than shown as zero, so the trend line stays meaningful.
 */
function buildWeeklyEfficiency(
  activities: ActivityRow[],
  timezone: string
): { label: string; val: number }[] {
  const RUN = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  // Group qualifying runs by ISO week key
  const byWeek: Record<string, number[]> = {};
  for (const a of activities) {
    if (!RUN.has(a.activity_type ?? "")) continue;
    if ((a.distance_meters ?? 0) < 3000) continue;
    if (a.workout_type === 1) continue;           // skip races
    if (!a.average_heartrate || !a.moving_time_seconds) continue;
    const ae = getAerobicEfficiency(a);
    if (!ae) continue;
    const k = weekKey(new Date(a.start_date), timezone);
    if (!byWeek[k]) byWeek[k] = [];
    byWeek[k].push(ae);
  }

  // Collect the last 16 calendar weeks that have data
  const now = new Date();
  const result: { label: string; val: number }[] = [];
  for (let i = 15; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const k = weekKey(d, timezone);
    const vals = byWeek[k];
    if (!vals?.length) continue;
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    const label = new Date(k + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    result.push({ label, val: avg });
  }
  return result;
}

type KeyNote = {
  label: string;  // short left-side label, e.g. "Recovery", "Load"
  text: string;   // the actionable note text
};

/**
 * Build the "Key notes" section content.
 *
 * Pacing zones always appear as a single structured row at the top (if available).
 * A Haiku call then scans recent coaching messages for 1–3 persistent reminders
 * (injury routines, HR cues, form advice). Falls back gracefully on failure.
 */
async function extractKeyNotes(params: {
  recentMessages: string[];
  injuryNotes: string | null;
  easyPace: string | null;
  tempoPace: string | null;
  intervalPace: string | null;
  loadFlagged: boolean;
  latestInsightDate: string | null;
  effTrend: string;
  loadSummary: string;
}): Promise<{ paceZones: string | null; notes: KeyNote[]; latestInsightDate: string | null; summary: string | null }> {
  const { recentMessages, injuryNotes, easyPace, tempoPace, intervalPace, loadFlagged, latestInsightDate, effTrend, loadSummary } = params;

  // Build the pacing zones line
  const zoneParts: string[] = [];
  if (easyPace) {
    const parts = easyPace.replace("/mi", "").split(":");
    if (parts.length === 2) {
      const base = parseInt(parts[0]!) * 60 + parseInt(parts[1]!);
      const ceilSec = base + 30;
      const ceil = `${Math.floor(ceilSec / 60)}:${String(ceilSec % 60).padStart(2, "0")}`;
      zoneParts.push(`Easy  ${easyPace.replace("/mi", "")}–${ceil}/mi`);
    }
  }
  if (tempoPace) zoneParts.push(`Tempo  ${tempoPace}`);
  if (intervalPace) zoneParts.push(`Intervals  ${intervalPace}`);
  const paceZones = zoneParts.length ? zoneParts.join("   ·   ") : null;

  const staticNotes: KeyNote[] = [];
  if (loadFlagged) {
    staticNotes.push({ label: "Load", text: "Mileage spiked this week — keep any remaining runs controlled" });
  }

  if (!recentMessages.length && !injuryNotes) {
    return { paceZones, notes: staticNotes, latestInsightDate, summary: null };
  }

  try {
    const profileCtx = [
      injuryNotes ? `Injury history: ${injuryNotes}` : null,
      easyPace ? `Easy pace: ${easyPace}` : null,
      `Load trend: ${loadSummary}`,
      `Aerobic efficiency trend: ${effTrend}`,
    ].filter(Boolean).join("\n");

    const messagesCtx = recentMessages
      .slice(0, 10)
      .map((m, i) => `[${i + 1}] ${m.slice(0, 300)}`)
      .join("\n");

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 640,
      system: `You are analyzing an athlete's recent coaching messages and training metrics to surface insights for their dashboard.

Your task:
1. Generate a 1–2 sentence longitudinal summary of what's happening with this athlete's training over the past few weeks. Focus on the most meaningful pattern or trend — not the last single run. Be direct and concrete. Encouraging but honest.
2. Extract 1–3 persistent actionable coaching reminders (advice that applies across multiple sessions — injury routines, HR targets, form cues, recurring patterns). NOT advice about a specific day. NOT mileage totals.

Each note: short label (1–2 words) + text (under 12 words).
Return empty arrays if there's no clear signal rather than inventing content.`,
      messages: [{
        role: "user",
        content: `Athlete profile:\n${profileCtx}\n\nRecent coaching messages:\n${messagesCtx}`,
      }],
      tools: [{
        name: "save_insights",
        description: "Save the training summary and coaching notes",
        input_schema: {
          type: "object" as const,
          properties: {
            summary: {
              type: "string",
              description: "1–2 sentence overview of recent training patterns and trajectory",
            },
            notes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  text: { type: "string" },
                },
                required: ["label", "text"],
              },
            },
          },
          required: ["summary", "notes"],
        },
      }],
      tool_choice: { type: "tool" as const, name: "save_insights" },
    });

    const block = response.content.find(b => b.type === "tool_use" && b.name === "save_insights");
    if (block?.type === "tool_use") {
      const extracted = block.input as { summary?: string; notes?: KeyNote[] };
      return {
        paceZones,
        notes: [...staticNotes, ...(extracted.notes ?? [])].slice(0, 5),
        latestInsightDate,
        summary: extracted.summary?.trim() || null,
      };
    }
  } catch {
    // Non-fatal
  }

  return { paceZones, notes: staticNotes, latestInsightDate, summary: null };
}

/** Status signal — returns label, color, and a detail line safe to show next to partial-week data */
function computeStatus(
  loadTrend: ReturnType<typeof computeLoadTrend>,
  effTrend: ReturnType<typeof computeAerobicEfficiencyTrend>,
  currentWeekMiles: number,
  weekDayNum: number   // 1=Mon … 7=Sun — used to contextualize partial-week stats
): { label: string; color: string; detail: string } {
  if (currentWeekMiles === 0 && loadTrend.weeklyMiles.every(m => m === 0)) {
    return { label: "No recent activity", color: "gray", detail: "Connect Strava to start tracking" };
  }
  if (loadTrend.flagged && effTrend.trend === "worsening") {
    return { label: "Watch load", color: "orange", detail: "Mileage jumped and efficiency is dipping — easy week?" };
  }
  if (loadTrend.flagged) {
    return { label: "Watch load", color: "orange", detail: "Weekly mileage spiked >10% — keep this week controlled" };
  }
  if (effTrend.trend === "improving") {
    return { label: "Fitness building", color: "green", detail: "Aerobic efficiency is trending up" };
  }
  if (effTrend.trend === "worsening") {
    return { label: "Check recovery", color: "orange", detail: "Efficiency is dipping — may need more easy running" };
  }
  // "Holding steady" — but early in the week the mileage delta will look misleading
  const earlyWeek = weekDayNum <= 3; // Mon / Tue / Wed
  return {
    label: "Holding steady",
    color: "blue",
    detail: earlyWeek
      ? "Load and efficiency stable — week in progress"
      : "Load and efficiency are stable",
  };
}

// ─── SVG chart components (server-rendered) ───────────────────────────────────

function BarChart({
  data,
  threshold,
  useMetric,
}: {
  data: { label: string; miles: number; isCurrent: boolean }[];
  threshold: number;
  useMetric: boolean;
}) {
  const values = data.map(d => useMetric ? d.miles * 1.60934 : d.miles);
  const max = Math.max(...values, threshold, 1);
  const W = 560;
  const H = 110;
  const PL = 4, PR = 4, PT = 8, PB = 22;
  const barW = Math.floor((W - PL - PR) / data.length);
  const chartH = H - PT - PB;

  const threshY = PT + chartH * (1 - threshold / max);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: "280px" }} aria-label="Weekly mileage">
      {/* threshold line */}
      {threshold > 0 && (
        <line x1={PL} x2={W - PR} y1={threshY} y2={threshY}
          stroke="#f97316" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.7" />
      )}
      {data.map((d, i) => {
        const v = values[i]!;
        const barH = v > 0 ? Math.max(3, (v / max) * chartH) : 0;
        const x = PL + i * barW + 2;
        const y = PT + chartH - barH;
        return (
          <g key={i}>
            <rect x={x} y={y} width={Math.max(1, barW - 4)} height={barH} rx="2"
              fill={d.isCurrent ? "#3b82f6" : "#e2e8f0"} />
            {i % 4 === 0 && (
              <text x={x + (barW - 4) / 2} y={H - 5} textAnchor="middle" fontSize="8" fill="#94a3b8">
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function LineChart({ data }: { data: { label: string; val: number }[] }) {
  if (data.length < 3) return null;
  const vals = data.map(d => d.val);
  const min = Math.min(...vals) * 0.96;
  const max = Math.max(...vals) * 1.04;
  const W = 560, H = 100;
  const PL = 4, PR = 4, PT = 8, PB = 22;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;

  const pts = vals.map((v, i) => {
    const x = PL + (i / (vals.length - 1)) * chartW;
    const y = PT + chartH * (1 - (v - min) / (max - min));
    return [x, y] as [number, number];
  });
  const polyline = pts.map(([x, y]) => `${x},${y}`).join(" ");

  // trend: first half avg vs second half avg
  const half = Math.floor(vals.length / 2);
  const firstAvg = vals.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const lastAvg = vals.slice(-half).reduce((s, v) => s + v, 0) / half;
  const improving = lastAvg > firstAvg * 1.02;

  // Show ~4 evenly-spaced labels plus always first + last
  const labelEvery = Math.max(1, Math.floor(data.length / 4));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: "200px" }} aria-label="Aerobic efficiency trend">
        <polyline points={polyline} fill="none"
          stroke={improving ? "#22c55e" : "#94a3b8"} strokeWidth="2" strokeLinejoin="round" />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2.5"
            fill={improving ? "#22c55e" : "#94a3b8"} />
        ))}
        {/* X axis date labels */}
        {data.map((d, i) => {
          const show = i === 0 || i === data.length - 1 || i % labelEvery === 0;
          if (!show) return null;
          const x = PL + (i / (vals.length - 1)) * chartW;
          return (
            <text key={`lbl-${i}`} x={x} y={H - 5}
              textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}
              fontSize="8" fill="#94a3b8">
              {d.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Classify each recent run into a training zone.
 *
 * Signal priority (most reliable first):
 * 1. workout_type === 1 → race
 * 2. workout_type === 3 → hard (Strava flags interval/tempo/workout sessions here)
 * 3. workout_type === 2 → easy/long (Strava long run flag)
 * 4. avg HR as % of estimated max HR (when HR data exists)
 * 5. avg pace vs stored easy/tempo paces (fallback only)
 *
 * Pace-only classification is intentionally the last resort because avg pace
 * is misleading for interval sessions: 10×400m at 5:30/mi with 90s jog recovery
 * averages to ~7:30/mi overall — the jog recovery drags the average into "easy"
 * territory even though it was clearly a hard workout.
 */
type ZoneRun = {
  date: string;        // ISO week key (Mon) — used to group by week
  zone: "easy" | "moderate" | "hard" | "race";
  signal: "workout_type" | "hr" | "pace" | "default"; // how it was classified
};

function buildZoneStrip(
  activities: ActivityRow[],
  easyPaceStr: string | null,
  tempoPaceStr: string | null,
  timezone: string
): { runs: ZoneRun[]; weeks: string[]; maxHREstimate: number | null } {
  const RUN = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  const parsePace = (s: string | null): number | null => {
    if (!s) return null;
    const clean = s.replace("/mi", "").replace("/km", "");
    const parts = clean.split(":");
    if (parts.length !== 2) return null;
    return parseInt(parts[0]!) * 60 + parseInt(parts[1]!);
  };
  const easyPaceSec = parsePace(easyPaceStr);
  const tempoPaceSec = parsePace(tempoPaceStr);

  // Estimate max HR from the highest avg HR seen across all runs × 1.12.
  // avg HR on a max-effort run is ~88–92% of true max HR, so this factor
  // gives a reasonable ceiling without needing stored max HR.
  const maxHREstimate = (() => {
    const hrs = activities
      .filter(a => RUN.has(a.activity_type ?? "") && a.average_heartrate != null)
      .map(a => a.average_heartrate!);
    if (hrs.length === 0) return null;
    return Math.max(...hrs) * 1.12;
  })();

  // Last 6 ISO weeks
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 42);

  const weekSet: Set<string> = new Set();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    weekSet.add(weekKey(d, timezone));
  }
  const weeks = Array.from(weekSet);

  const runs: ZoneRun[] = [];
  const sorted = [...activities]
    .filter(a =>
      RUN.has(a.activity_type ?? "") &&
      new Date(a.start_date) >= cutoff &&
      a.distance_meters != null && a.distance_meters > 1000
    )
    .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

  for (const a of sorted) {
    const wk = weekKey(new Date(a.start_date), timezone);
    if (!weeks.includes(wk)) continue;

    // 1. Race
    if (a.workout_type === 1) {
      runs.push({ date: wk, zone: "race", signal: "workout_type" });
      continue;
    }

    // 2. Strava workout flag (intervals, tempo, fartlek) → always hard
    if (a.workout_type === 3) {
      runs.push({ date: wk, zone: "hard", signal: "workout_type" });
      continue;
    }

    // 3. Strava long run flag → easy/long
    if (a.workout_type === 2) {
      runs.push({ date: wk, zone: "easy", signal: "workout_type" });
      continue;
    }

    // 4. HR-based classification (most accurate for non-flagged runs)
    if (maxHREstimate && a.average_heartrate) {
      const hrPct = a.average_heartrate / maxHREstimate;
      // Z1–Z2 easy aerobic: < 75% maxHR
      // Z3 moderate: 75–85%
      // Z4–Z5 hard: > 85%
      if (hrPct < 0.75) {
        runs.push({ date: wk, zone: "easy", signal: "hr" });
      } else if (hrPct < 0.85) {
        runs.push({ date: wk, zone: "moderate", signal: "hr" });
      } else {
        runs.push({ date: wk, zone: "hard", signal: "hr" });
      }
      continue;
    }

    // 5. Pace fallback (only when no HR and no workout_type signal)
    if (easyPaceSec && a.moving_time_seconds && a.distance_meters) {
      const paceSec = a.moving_time_seconds / (a.distance_meters / 1609.34);
      if (paceSec >= easyPaceSec - 45) {
        runs.push({ date: wk, zone: "easy", signal: "pace" });
      } else if (tempoPaceSec && paceSec <= tempoPaceSec + 15) {
        runs.push({ date: wk, zone: "hard", signal: "pace" });
      } else {
        runs.push({ date: wk, zone: "moderate", signal: "pace" });
      }
      continue;
    }

    // Default: render as moderate so the dot still appears
    runs.push({ date: wk, zone: "moderate", signal: "default" });
  }

  return { runs, weeks, maxHREstimate };
}

/**
 * Aerobic efficiency tier labels — journey-framing, no social comparison.
 * Range for runners Dean serves: ~0.85 (early base) to ~2.0 (elite).
 *
 * 0.85–1.00  Getting started          — building the foundation
 * 1.00–1.10  Building your base       — early aerobic development
 * 1.10–1.35  Developing aerobic engine — momentum building, engine responding
 * 1.35–1.60  Strong aerobic foundation — years of steady work showing
 * 1.60–1.85  Advanced endurance base  — highly trained, sub-elite territory
 * 1.85+      Elite endurance          — world-class aerobic economy
 */
function interpretEfficiency(ae: number): { tier: string } {
  if (ae >= 1.85) return { tier: "Elite endurance" };
  if (ae >= 1.60) return { tier: "Advanced endurance base" };
  if (ae >= 1.35) return { tier: "Strong aerobic foundation" };
  if (ae >= 1.10) return { tier: "Developing aerobic engine" };
  if (ae >= 1.00) return { tier: "Building your base" };
  return { tier: "Getting started" };
}

/**
 * Run zone strip: a horizontal row of colored dots, one per run, grouped by week.
 * Colors: green = easy, amber = moderate, red = hard, blue = race.
 */
function RunZoneStrip({
  runs,
  weeks,
}: {
  runs: ZoneRun[];
  weeks: string[];
}) {
  if (runs.length === 0) return null;

  const ZONE_COLOR: Record<ZoneRun["zone"], string> = {
    easy: "#22c55e",
    moderate: "#f59e0b",
    hard: "#ef4444",
    race: "#3b82f6",
  };
  const ZONE_LABEL: Record<ZoneRun["zone"], string> = {
    easy: "Easy", moderate: "Moderate", hard: "Hard", race: "Race",
  };

  const DOT = 10;   // dot diameter
  const GAP = 3;    // gap between dots in the same week
  const WKGAP = 8;  // gap between weeks
  const H = DOT;

  // Pre-compute dots grouped by week
  const byWeek: Record<string, ZoneRun["zone"][]> = {};
  for (const wk of weeks) byWeek[wk] = [];
  for (const r of runs) {
    if (byWeek[r.date]) byWeek[r.date]!.push(r.zone);
  }

  // Compute total width
  let totalW = 0;
  for (const wk of weeks) {
    const count = byWeek[wk]?.length ?? 0;
    if (count > 0) totalW += count * (DOT + GAP) - GAP + WKGAP;
  }
  totalW = Math.max(totalW - WKGAP, 10);

  // Build dot positions
  const dots: { x: number; zone: ZoneRun["zone"] }[] = [];
  const wkLabels: { x: number; label: string }[] = [];
  let x = 0;
  for (const wk of weeks) {
    const wkRuns = byWeek[wk] ?? [];
    if (wkRuns.length === 0) continue;
    const wkStart = x;
    for (const zone of wkRuns) {
      dots.push({ x: x + DOT / 2, zone });
      x += DOT + GAP;
    }
    x -= GAP;
    const wkLabel = new Date(wk + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    wkLabels.push({ x: wkStart + (x - wkStart) / 2, label: wkLabel });
    x += WKGAP;
  }

  const LABEL_H = 12;
  const svgH = H + LABEL_H + 4;

  return (
    <div>
      <svg viewBox={`0 0 ${totalW} ${svgH}`} className="w-full" style={{ minWidth: "160px" }} aria-label="Run zone history">
        {dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={DOT / 2} r={DOT / 2 - 0.5}
            fill={ZONE_COLOR[d.zone]} opacity="0.85" />
        ))}
        {wkLabels.map((l, i) => (
          <text key={i} x={l.x} y={svgH - 1} textAnchor="middle" fontSize="7" fill="#cbd5e1">
            {l.label}
          </text>
        ))}
      </svg>
      {/* Legend */}
      <div className="flex items-center gap-3 mt-2">
        {(["easy", "moderate", "hard", "race"] as const).map(z => (
          <div key={z} className="flex items-center gap-1">
            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: ZONE_COLOR[z] }} />
            <span className="text-[9px] text-gray-400">{ZONE_LABEL[z]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Heart rate zones bar — shows 5 zones (Z1–Z5) as equal-width colored segments.
 *
 * Zone boundaries align with our dot classification:
 * Z1 Recovery  < 60% maxHR  — active recovery
 * Z2 Aerobic   60–75%       — easy aerobic base (the "Zone 2" training zone)
 * Z3 Tempo     75–85%       — comfortably hard / aerobic power
 * Z4 Threshold 85–93%       — lactate threshold
 * Z5 VO2 Max   > 93%        — maximum effort
 *
 * The Z2/Z3 boundary at 75% is intentional: it matches our "Easy" dot threshold,
 * so runs classified as Easy always fall in Z1–Z2 and Moderate runs in Z3.
 */
function HRZoneBar({ maxHR }: { maxHR: number }) {
  const zones = [
    { label: "Z1", name: "Recovery",  pct: 0.60, color: "#93c5fd" },
    { label: "Z2", name: "Aerobic",   pct: 0.75, color: "#34d399" },
    { label: "Z3", name: "Tempo",     pct: 0.85, color: "#fbbf24" },
    { label: "Z4", name: "Threshold", pct: 0.93, color: "#f97316" },
    { label: "Z5", name: "VO2 Max",   pct: 1.00, color: "#ef4444" },
  ];
  const prevPcts = [0, 0.60, 0.75, 0.85, 0.93];

  return (
    <div className="space-y-1.5">
      {/* Colored bar */}
      <div className="flex rounded-md overflow-hidden h-5">
        {zones.map((z, i) => (
          <div key={z.label}
            className="flex items-center justify-center flex-1"
            style={{ backgroundColor: z.color }}
          >
            <span className="text-[9px] font-bold text-white drop-shadow-sm">{z.label}</span>
          </div>
        ))}
      </div>
      {/* BPM range labels */}
      <div className="flex">
        {zones.map((z, i) => (
          <div key={z.label} className="flex-1 text-center">
            <div className="text-[9px] text-gray-400 tabular-nums">
              {i === zones.length - 1
                ? `>${Math.round(prevPcts[i]! * maxHR)}`
                : `${Math.round(prevPcts[i]! * maxHR)}–${Math.round(z.pct * maxHR)}`}
            </div>
          </div>
        ))}
      </div>
      {/* Zone name labels */}
      <div className="flex">
        {zones.map((z) => (
          <div key={z.label} className="flex-1 text-center">
            <div className="text-[9px] text-gray-300">{z.name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Aerobic efficiency spectrum bar.
 *
 * A continuous track from 0.8 (floor of practical running fitness) to 2.0
 * (elite ceiling). No tier labels on the bar — just anchors at each end and
 * the athlete's dot positioned proportionally. The open space to the right
 * communicates "room to grow" at any level.
 */
function EfficiencySpectrum({ value }: { value: number }) {
  const MIN = 0.8, MAX = 2.0;
  // Clamp with small inset so the dot never disappears off either edge
  const pct = Math.max(2, Math.min(97, ((value - MIN) / (MAX - MIN)) * 100));

  return (
    <div>
      <div className="relative h-1 bg-gray-100 rounded-full mb-2.5">
        <div
          className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-blue-500 border-2 border-white shadow"
          style={{ left: `calc(${pct}% - 6px)` }}
        />
      </div>
      <div className="flex justify-between">
        <span className="text-[9px] text-gray-300">just starting out</span>
        <span className="text-[9px] text-gray-300">elite endurance</span>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) return <NoTokenScreen />;

  const { data: user } = await supabase
    .from("users")
    .select("id, name, timezone, onboarding_data, strava_athlete_id")
    .eq("dashboard_token", token)
    .single();

  if (!user) return <NoTokenScreen expired />;

  const timezone = (user.timezone as string | null) ?? "UTC";

  const [
    { data: profileData },
    { data: activitiesRaw },
    { data: insightsRaw },
    { data: racesData },
    { data: stateData },
    { data: planData },
  ] = await Promise.all([
    supabase
      .from("training_profiles")
      .select("goal, race_date, goal_distance_miles, preferred_units, terrain_type, current_easy_pace, current_tempo_pace, current_interval_pace, injury_notes, manual_prs, training_days, this_week_override_days, this_week_override_expires")
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("activities")
      .select("strava_activity_id, start_date, distance_meters, moving_time_seconds, elapsed_time_seconds, activity_type, average_heartrate, aerobic_efficiency, cardiac_decoupling_pct, workout_type, best_efforts, activity_name")
      .eq("user_id", user.id)
      .order("start_date", { ascending: false })
      .limit(200),
    supabase
      .from("conversations")
      .select("content, message_type, created_at, strava_activity_id")
      .eq("user_id", user.id)
      .eq("role", "assistant")
      .in("message_type", ["post_run", "weekly_recap"])
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("races")
      .select("id, race_name, race_date, priority, goal_distance_miles, goal_time_minutes, goal")
      .eq("user_id", user.id)
      .gte("race_date", new Date().toISOString().split("T")[0]!)
      .order("race_date", { ascending: true })
      .limit(6),
    supabase
      .from("training_state")
      .select("current_week, current_phase, weekly_mileage_target, weekly_plan_sessions")
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("training_plans")
      .select("weeks, total_weeks, created_at, race_date, goal")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single(),
  ]);

  const activities = (activitiesRaw ?? []) as ActivityRow[];
  const insights = (insightsRaw ?? []) as ConversationRow[];
  const useMetric = profileData?.preferred_units === "metric";
  const distUnit = useMetric ? "km" : "mi";

  // Sort races: A first, then by date
  const races = ((racesData ?? []) as Race[]).sort((a, b) => {
    const pa = a.priority === "A" ? 0 : a.priority === "B" ? 1 : 2;
    const pb = b.priority === "A" ? 0 : b.priority === "B" ? 1 : 2;
    return pa !== pb ? pa - pb : new Date(a.race_date).getTime() - new Date(b.race_date).getTime();
  });

  // Analytics
  const analyticsActivities: ActivityForAnalytics[] = activities.map(a => ({
    start_date: a.start_date,
    activity_type: a.activity_type,
    distance_meters: a.distance_meters,
    moving_time_seconds: a.moving_time_seconds,
    average_heartrate: a.average_heartrate,
    aerobic_efficiency: getAerobicEfficiency(a),
    cardiac_decoupling_pct: a.cardiac_decoupling_pct,
  }));

  const loadTrend = computeLoadTrend(analyticsActivities, timezone);
  const effTrend = computeAerobicEfficiencyTrend(analyticsActivities, timezone);
  const effSeries = buildWeeklyEfficiency(activities, timezone);

  // Efficiency trend as a percentage change string for display
  const effChangePct = effTrend.recentAvg != null && effTrend.priorAvg != null && effTrend.priorAvg > 0
    ? Math.round(((effTrend.recentAvg - effTrend.priorAvg) / effTrend.priorAvg) * 100)
    : null;
  const effWeeks = effSeries.length;
  const effTrendLabel = (() => {
    if (effChangePct === null) return effTrend.trend === "improving" ? "↑ Improving" : effTrend.trend === "worsening" ? "↓ Declining" : "Stable";
    if (effTrend.trend === "improving") return `↑ ${effChangePct}% over ${effWeeks} wks`;
    if (effTrend.trend === "worsening") return `↓ ${Math.abs(effChangePct)}% over ${effWeeks} wks`;
    return `±${Math.abs(effChangePct)}% — stable`;
  })();

  // Current efficiency value (most recent weekly avg)
  const currentEffVal = effSeries[effSeries.length - 1]?.val ?? null;

  // Trajectory-first headline for the efficiency card
  const effHeadline = (() => {
    const verb = effTrend.trend === "improving" ? "is building strength"
      : effTrend.trend === "worsening" ? "needs attention"
      : "is holding steady";
    if (effChangePct !== null && Math.abs(effChangePct) >= 1) {
      const dir = effChangePct > 0 ? "up" : "down";
      const period = effWeeks > 4 ? `${effWeeks} weeks` : "recently";
      return `Your aerobic engine ${verb} — ${dir} ${Math.abs(effChangePct)}% over the last ${period}`;
    }
    return `Your aerobic engine ${verb}`;
  })();

  // VDOT ≈ VO2 max estimate
  const vdotResult = estimateVDOT(
    activities.map(a => ({
      activity_type: a.activity_type,
      distance_meters: a.distance_meters,
      moving_time_seconds: a.moving_time_seconds,
      average_heartrate: a.average_heartrate,
      start_date: a.start_date,
      workout_type: a.workout_type,
      best_efforts: a.best_efforts,
    })),
    (profileData?.current_easy_pace as string | null) ?? undefined
  );

  // Run zone strip (last 6 weeks, colored by effort zone)
  const zoneStrip = buildZoneStrip(
    activities,
    (profileData?.current_easy_pace as string | null) ?? null,
    (profileData?.current_tempo_pace as string | null) ?? null,
    timezone
  );

  // Weekly chart
  const weeklyMiles = buildWeeklyMiles(activities, timezone);
  const currentWeekMiles = weeklyMiles[weeklyMiles.length - 1]?.miles ?? 0;
  const priorWeekMiles = weeklyMiles[weeklyMiles.length - 2]?.miles ?? 0;
  const weekDelta = priorWeekMiles > 0
    ? Math.round(((currentWeekMiles - priorWeekMiles) / priorWeekMiles) * 100)
    : null;
  const nonZeroWeeks = weeklyMiles.filter(w => w.miles > 0);
  const avgMiles = nonZeroWeeks.length > 0
    ? nonZeroWeeks.reduce((s, w) => s + w.miles, 0) / nonZeroWeeks.length
    : 0;
  const thresholdMiles = avgMiles * 1.1;
  const thresholdDisplay = useMetric
    ? Math.round(thresholdMiles * 1.60934 * 10) / 10
    : Math.round(thresholdMiles * 10) / 10;

  // Day of week in athlete's timezone (1=Mon … 7=Sun)
  const weekDayNum = (() => {
    const d = parseInt(new Intl.DateTimeFormat("en-US", { weekday: "narrow", timeZone: timezone }).format(new Date()));
    // Intl weekday narrow: Su=0, Mo=1, Tu=2, We=3, Th=4, Fr=5, Sa=6
    // Convert to Mon-based 1–7
    const map: Record<string, number> = { Su: 7, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
    const narrow = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(new Date());
    return map[narrow.slice(0, 2)] ?? 4;
  })();

  // Status signal
  const status = computeStatus(loadTrend, effTrend, currentWeekMiles, weekDayNum);

  // Last run (most recent training run, not race)
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  const lastRun = activities.find(a => RUN_TYPES.has(a.activity_type ?? "")) ?? null;
  const lastRunDistDisplay = lastRun?.distance_meters
    ? useMetric
      ? `${(lastRun.distance_meters / 1000).toFixed(1)} km`
      : `${(lastRun.distance_meters / 1609.34).toFixed(1)} mi`
    : null;

  // Dean's analysis of the last run — show a meaningful excerpt (2–3 sentences)
  const lastRunFlag = (() => {
    const postRun = insights.find(i => i.message_type === "post_run");
    if (!postRun?.content || !lastRun) return null;
    // Only show if the insight is within 48 hours of the last run
    const insightAge = lastRun.start_date
      ? (new Date(postRun.created_at ?? 0).getTime() - new Date(lastRun.start_date).getTime()) / (1000 * 60 * 60)
      : 999;
    if (insightAge < -4 || insightAge > 48) return null;
    // Build a 2–3 sentence preview, max ~300 chars
    const sentences = postRun.content.split(/(?<=[.!?])\s+/);
    let preview = "";
    for (const s of sentences) {
      if (s.trim().length < 20) continue;
      const candidate = preview ? `${preview} ${s.trim()}` : s.trim();
      if (candidate.length > 300) break;
      preview = candidate;
      if (preview.split(/[.!?]/).filter(p => p.trim().length > 0).length >= 3) break;
    }
    return preview.trim() || null;
  })();

  // Race predictions
  const racePredictions = races.map(race => {
    if (!race.goal_distance_miles) return null;
    return predictRaceTime({
      activities: activities.map(a => ({
        activity_type: a.activity_type,
        distance_meters: a.distance_meters,
        moving_time_seconds: a.moving_time_seconds,
        average_heartrate: a.average_heartrate,
        start_date: a.start_date,
        workout_type: a.workout_type,
        best_efforts: a.best_efforts,
      })),
      goalDistanceMiles: race.goal_distance_miles,
      terrainType: (profileData?.terrain_type as "road" | "trail" | "mixed" | null) ?? "road",
      storedEasyPace: (profileData?.current_easy_pace as string | null) ?? undefined,
    });
  });

  // Last 7 days: runs with zone classification and matched Dean notes
  const RUN_TYPES_SET = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Build a map of strava_activity_id → Dean's post-run note excerpt
  const noteByActivityId = new Map<number, string>();
  for (const insight of insights) {
    if (insight.message_type !== "post_run" || !insight.strava_activity_id) continue;
    if (noteByActivityId.has(insight.strava_activity_id)) continue;
    const sentences = insight.content.split(/(?<=[.!?])\s+/);
    let preview = "";
    for (const s of sentences) {
      if (s.trim().length < 20) continue;
      const candidate = preview ? `${preview} ${s.trim()}` : s.trim();
      if (candidate.length > 200) break;
      preview = candidate;
      if (preview.split(/[.!?]/).filter(p => p.trim().length > 0).length >= 2) break;
    }
    if (preview) noteByActivityId.set(insight.strava_activity_id, preview.trim());
  }

  const lastWeekRuns = activities
    .filter(a =>
      RUN_TYPES_SET.has(a.activity_type ?? "") &&
      new Date(a.start_date) >= sevenDaysAgo &&
      (a.distance_meters ?? 0) > 500
    )
    .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())
    .map(a => {
      // Classify zone for this run using same logic as buildZoneStrip
      let zone: ZoneRun["zone"] = "moderate";
      if (a.workout_type === 1) zone = "race";
      else if (a.workout_type === 3) zone = "hard";
      else if (a.workout_type === 2) zone = "easy";
      else if (zoneStrip.maxHREstimate && a.average_heartrate) {
        const hrPct = a.average_heartrate / zoneStrip.maxHREstimate;
        zone = hrPct < 0.75 ? "easy" : hrPct < 0.85 ? "moderate" : "hard";
      }

      const dist = a.distance_meters;
      const distDisplay = dist
        ? useMetric ? `${(dist / 1000).toFixed(1)} km` : `${(dist / 1609.34).toFixed(1)} mi`
        : null;

      return {
        ...a,
        zone,
        distDisplay,
        deansNote: a.strava_activity_id ? (noteByActivityId.get(a.strava_activity_id) ?? null) : null,
      };
    });

  // PRs
  const manualPRs = (profileData?.manual_prs as ManualPRs | null) ?? {};
  const prs = buildPRs(activities, manualPRs);

  const firstName = (user.name as string | null)?.split(" ")[0] ?? "Athlete";
  const currentWeekDisplay = useMetric
    ? `${Math.round(currentWeekMiles * 1.60934 * 10) / 10} km`
    : `${currentWeekMiles} mi`;
  const currentPhase = (stateData?.current_phase as string | null) ?? null;

  const PHASE_LABEL: Record<string, string> = {
    base: "Base phase", build: "Build phase", peak: "Peak phase",
    taper: "Taper", deload: "Deload week",
  };

  // Build human-readable load summary for Haiku context
  const loadSummaryStr = (() => {
    if (loadTrend.flagged) return `Mileage spiked this week (>10% jump)`;
    const recent = loadTrend.weeklyMiles.slice(-4).filter(m => m > 0);
    if (recent.length < 2) return "Insufficient data";
    const avg = Math.round(recent.reduce((s, m) => s + m, 0) / recent.length * 10) / 10;
    return `Averaging ${avg} mi/week over last ${recent.length} weeks, stable`;
  })();

  // Key notes — pacing zones + Haiku-extracted coaching reminders + longitudinal summary
  const { paceZones, notes: keyNotes, latestInsightDate, summary: trainingSummary } = await extractKeyNotes({
    recentMessages: insights.map(m => m.content ?? ""),
    injuryNotes: (profileData?.injury_notes as string | null) ?? null,
    easyPace: (profileData?.current_easy_pace as string | null) ?? null,
    tempoPace: (profileData?.current_tempo_pace as string | null) ?? null,
    intervalPace: (profileData?.current_interval_pace as string | null) ?? null,
    loadFlagged: loadTrend.flagged,
    latestInsightDate: insights[0]?.created_at ?? null,
    effTrend: effTrendLabel,
    loadSummary: loadSummaryStr,
  });

  // ── Plan tab props ──────────────────────────────────────────────────────────
  const planWeeks = (planData?.weeks as PlanWeek[] | null) ?? [];
  const totalWeeks = (planData?.total_weeks as number | null) ?? planWeeks.length;
  const currentWeekNum = (stateData?.current_week as number | null) ?? 1;
  const weeklyMileageTarget = (stateData?.weekly_mileage_target as number | null) ?? 0;
  const weeklyPlanSessions = (stateData?.weekly_plan_sessions as PlanSession[] | null) ?? null;
  const planCreatedDateStr = planData?.created_at ? (planData.created_at as string).split("T")[0]! : null;
  const trainingDays = (profileData?.training_days as string[] | null) ?? null;
  const overrideDays = (profileData?.this_week_override_days as string[] | null) ?? null;
  const overrideExpireStr = (profileData?.this_week_override_expires as string | null) ?? null;
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  const isOverrideActive = overrideDays !== null && overrideExpireStr !== null && overrideExpireStr >= todayStr;

  // Compute week1Monday for the plan arc (same logic as legacy page)
  const todayUTC = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const todayDOW = todayUTC.getUTCDay();
  const planWeek1Monday = new Date(todayUTC);
  if (todayDOW === 0) {
    planWeek1Monday.setUTCDate(todayUTC.getUTCDate() + 1);
  } else {
    planWeek1Monday.setUTCDate(todayUTC.getUTCDate() + (1 - todayDOW));
  }
  planWeek1Monday.setUTCDate(planWeek1Monday.getUTCDate() - (currentWeekNum - 1) * 7);

  const RUN_TYPES_PLAN = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  const actualMilesByWeek: Record<number, number> = {};
  for (const activity of activities) {
    if (!RUN_TYPES_PLAN.has(activity.activity_type ?? "")) continue;
    const actMs = new Date(activity.start_date).getTime();
    const weekNum = Math.floor((actMs - planWeek1Monday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
    if (weekNum >= 1 && weekNum <= totalWeeks) {
      actualMilesByWeek[weekNum] = (actualMilesByWeek[weekNum] ?? 0) + (activity.distance_meters ?? 0) / 1609.34;
    }
  }

  // Race weeks for badge display
  const allRaceWeekNums: number[] = [];
  for (const r of races) {
    const wn = Math.floor((new Date(r.race_date + "T12:00:00Z").getTime() - planWeek1Monday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
    if (wn >= 1 && wn <= totalWeeks) allRaceWeekNums.push(wn);
  }

  // todayDayIdx for the plan daily view (same -1 on Sunday trick as legacy)
  const userDayName = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(new Date());
  const USER_DAY_TO_DOW: Record<string, number> = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
  };
  const userDOW = USER_DAY_TO_DOW[userDayName] ?? 1;
  const DAY_ORDER_PLAN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const todayDayIdx = userDOW === 0 ? -1 : DAY_ORDER_PLAN.indexOf(userDayName);

  // Goal label for plan tab header
  const onboardingData = (user.onboarding_data as Record<string, unknown> | null) ?? {};
  const planRaceName = (onboardingData.race_name as string | null) ?? null;
  const PLAN_GOAL_LABELS: Record<string, string> = {
    mile: "Mile", "5k": "5K", "10k": "10K", half_marathon: "Half Marathon",
    marathon: "Marathon", "30k": "30K", "50k": "50K", "50mi": "50 Miles",
    "100k": "100K", "100mi": "100 Miles", general_fitness: "General Fitness",
    return_to_running: "Return to Running", injury_recovery: "Injury Recovery",
  };
  const planGoalBucket = (races.find(r => r.priority === "A")?.goal ?? profileData?.goal ?? planData?.goal) as string | null;
  const planGoalLabel = planRaceName ?? (planGoalBucket ? (PLAN_GOAL_LABELS[planGoalBucket] ?? planGoalBucket) : null) ?? "";

  // Race date + days for plan tab
  const planRaceDate = (races.find(r => r.priority === "A")?.race_date ?? profileData?.race_date ?? planData?.race_date) as string | null;
  const planRaceDays = planRaceDate
    ? (() => { const d = Math.ceil((new Date(planRaceDate + "T12:00:00Z").getTime() - Date.now()) / (24 * 60 * 60 * 1000)); return d > 0 ? d : null; })()
    : null;

  // Plan races as PlanRace[] for the plan tab
  const planRaces: PlanRace[] = races.map(r => ({
    id: r.id, race_name: r.race_name, race_date: r.race_date,
    priority: r.priority ?? "C", goal: r.goal ?? "", goal_distance_miles: r.goal_distance_miles,
  }));

  const week1MondayStr = planWeek1Monday.toISOString().split("T")[0]!;

  return (
    <>
      <TokenPersist token={token} />
      <div className="min-h-screen bg-gray-50 text-gray-900">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="border-b border-gray-200 bg-white px-5 py-4">
          <div className="mx-auto flex max-w-xl items-center justify-between">
            <a href="/">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/heavy_logo.svg" alt="Coach Dean" style={{ height: 32 }} />
            </a>
            {currentPhase && (
              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500">
                {PHASE_LABEL[currentPhase] ?? currentPhase}
              </span>
            )}
          </div>
        </div>

        <div className="mx-auto max-w-xl px-5 py-5">
          <DashboardTabs
            plan={
              <PlanTab
                planWeeks={planWeeks}
                totalWeeks={totalWeeks}
                currentWeekNum={currentWeekNum}
                currentPhase={currentPhase}
                weeklyMileageTarget={weeklyMileageTarget}
                weeklyPlanSessions={weeklyPlanSessions}
                planCreatedDateStr={planCreatedDateStr}
                trainingDays={trainingDays}
                overrideDays={overrideDays}
                isOverrideActive={isOverrideActive}
                actualMilesByWeek={actualMilesByWeek}
                week1Monday={week1MondayStr}
                allRaceWeekNums={allRaceWeekNums}
                todayDayIdx={todayDayIdx}
                upcomingRaces={planRaces}
                useMetric={useMetric}
                goalLabel={planGoalLabel}
                raceDate={planRaceDate}
                raceDays={planRaceDays}
                hasPlan={planWeeks.length > 0}
              />
            }
            overview={<div className="space-y-4">

          {/* ── Last run + Dean's take ───────────────────────────────────── */}
          <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
            {trainingSummary ? (
              <div className="px-4 pt-4 pb-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    Training overview
                  </p>
                  <span className={`text-[10px] font-semibold tabular-nums ${
                    status.color === "green" ? "text-green-600" :
                    status.color === "orange" ? "text-orange-600" :
                    status.color === "gray" ? "text-gray-400" :
                    "text-blue-600"
                  }`}>{status.label}</span>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed">{trainingSummary}</p>
              </div>
            ) : lastRun ? (
              <div className="px-4 pt-4 pb-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    {formatDate(lastRun.start_date)}
                    {" · "}
                    {lastRun.activity_type === "TrailRun" ? "Trail run" : lastRun.activity_type ?? "Run"}
                    {lastRun.average_heartrate && ` · ${Math.round(lastRun.average_heartrate)} bpm avg`}
                  </p>
                  <span className={`text-[10px] font-semibold tabular-nums ${
                    status.color === "green" ? "text-green-600" :
                    status.color === "orange" ? "text-orange-600" :
                    status.color === "gray" ? "text-gray-400" :
                    "text-blue-600"
                  }`}>{status.label}</span>
                </div>
                <p className="text-sm text-gray-400">
                  {lastRunDistDisplay && `${lastRunDistDisplay} logged.`} No post-run note yet.
                </p>
              </div>
            ) : (
              <div className="px-4 py-4">
                <p className="text-sm text-gray-400">No runs logged yet — connect Strava to get started.</p>
              </div>
            )}
            {/* Week context strip */}
            <div className="flex items-center justify-between border-t border-gray-50 bg-gray-50 px-4 py-2">
              <span className="text-[10px] text-gray-400">{status.detail}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold tabular-nums text-gray-600">{currentWeekDisplay} this week</span>
                {weekDelta !== null && weekDayNum >= 4 ? (
                  <span className={`text-[10px] tabular-nums ${
                    weekDelta > 10 ? "text-orange-500" : weekDelta >= 0 ? "text-green-600" : "text-gray-400"
                  }`}>
                    {weekDelta >= 0 ? "+" : ""}{weekDelta}%
                  </span>
                ) : weekDayNum < 4 ? (
                  <span className="text-[10px] text-gray-300">day {weekDayNum}</span>
                ) : null}
              </div>
            </div>
          </div>

          {/* ── Zone 2: Race center ─────────────────────────────────────── */}
          {races.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                Goal races
              </h2>
              {races.map((race, idx) => {
                const pred = racePredictions[idx];
                const days = daysUntil(race.race_date);
                const isA = race.priority === "A";
                const raceLabel = race.race_name ?? (race.goal ? race.goal.replace(/_/g, " ") : "Race");
                const distLabel = race.goal_distance_miles
                  ? useMetric
                    ? `${Math.round(race.goal_distance_miles * 1.60934 * 10) / 10} km`
                    : `${race.goal_distance_miles} mi`
                  : null;
                return (
                  <div key={race.id} className="rounded-xl border border-gray-100 bg-white shadow-sm">
                    <div className="px-5 py-4">
                      {/* Race header */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {race.priority && (
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                                race.priority === "A" ? "bg-red-100 text-red-700" :
                                race.priority === "B" ? "bg-orange-100 text-orange-700" :
                                "bg-sky-100 text-sky-700"
                              }`}>
                                {race.priority}
                              </span>
                            )}
                            <p className="truncate text-base font-semibold">{raceLabel}</p>
                          </div>
                          <p className="mt-0.5 text-xs text-gray-400">
                            {formatDate(race.race_date, "long")}
                            {distLabel && <span className="ml-2">{distLabel}</span>}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          {days ? (
                            <>
                              <p className="text-2xl font-bold tabular-nums text-gray-900">{days}</p>
                              <p className="text-[10px] text-gray-400">days</p>
                            </>
                          ) : (
                            <p className="text-sm font-semibold text-gray-400">Passed</p>
                          )}
                        </div>
                      </div>

                      {/* Prediction */}
                      {pred ? (
                        <div className={`mt-3 border-t border-gray-50 pt-3 grid gap-3 ${race.goal_time_minutes ? "grid-cols-3" : "grid-cols-2"}`}>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-gray-400">Projected</p>
                            <p className="text-xl font-bold tabular-nums text-gray-900">
                              {pred.predictedFormatted}
                            </p>
                            <p className="text-[10px] text-gray-400">{pred.rangeLabel ?? "Likely finish window"}: {pred.rangeFormatted}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-gray-400">Based on</p>
                            <p className="text-sm font-medium text-gray-700 leading-snug">
                              {pred.sourceLabel}
                            </p>
                            {pred.caveat && (
                              <p className="text-[10px] text-amber-500 mt-0.5">{pred.caveat}</p>
                            )}
                          </div>
                          {race.goal_time_minutes && (
                            <div>
                              <p className="text-[10px] uppercase tracking-wide text-gray-400">vs Goal</p>
                              {pred.predictedMinutes <= race.goal_time_minutes ? (
                                <>
                                  <p className="text-sm font-medium text-green-600">On track</p>
                                  <p className="text-[10px] text-gray-400">Goal: {formatTime(race.goal_time_minutes)}</p>
                                </>
                              ) : (
                                <>
                                  <p className="text-sm font-medium text-orange-500">
                                    +{formatTime(pred.predictedMinutes - race.goal_time_minutes)} off
                                  </p>
                                  <p className="text-[10px] text-gray-400">Goal: {formatTime(race.goal_time_minutes)}</p>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-gray-400">
                          Log more runs to generate a finish time prediction.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {/* ── Zone 3: Fitness trends ──────────────────────────────────── */}
          <section className="space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
              Is it working?
            </h2>

            {/* Aerobic efficiency */}
            {effSeries.length >= 4 ? (() => {
              const effInterp = currentEffVal != null ? interpretEfficiency(currentEffVal) : null;
              return (
                <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
                  {/* Headline: trajectory first */}
                  <div className="mb-1 flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold text-gray-800 leading-snug">{effHeadline}</p>
                    {vdotResult.vdot != null && (
                      <span className="text-[10px] text-gray-400 tabular-nums shrink-0 pt-0.5">
                        VDOT <span className="font-semibold text-gray-600">{Math.round(vdotResult.vdot)}</span>
                      </span>
                    )}
                  </div>
                  {/* Chart */}
                  <div className="mt-3">
                    <LineChart data={effSeries} />
                  </div>
                  {/* Spectrum + supporting detail */}
                  <div className="mt-4 pt-3 border-t border-gray-50 space-y-3">
                    <EfficiencySpectrum value={currentEffVal ?? 1.0} />
                    {effInterp && currentEffVal != null && (
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs tabular-nums text-gray-400">{currentEffVal.toFixed(3)} m/beat</span>
                        <span className="text-xs text-gray-500">·</span>
                        <span className="text-xs font-medium text-gray-600">{effInterp.tier}</span>
                      </div>
                    )}
                    <p className="text-[10px] text-gray-400 leading-relaxed">
                      This measures how far you travel per heartbeat on easy runs. It rises gradually with consistent aerobic mileage — most runners see meaningful improvement over 3–6 months of steady training.
                    </p>
                  </div>
                </div>
              );
            })() : (
              <div className="rounded-xl border border-dashed border-gray-200 bg-white px-5 py-4">
                <p className="text-sm font-semibold text-gray-700">Aerobic efficiency</p>
                <p className="mt-1 text-xs text-gray-400">
                  Need {Math.max(0, 4 - effSeries.length)} more runs with HR data to show the trend.
                </p>
              </div>
            )}

            {/* Training zones */}
            {(zoneStrip.runs.length > 0 || zoneStrip.maxHREstimate != null) && (
              <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm space-y-4">
                <div>
                  <p className="text-sm font-semibold">Training zones — last 6 weeks</p>
                  <p className="text-xs text-gray-400 mt-0.5">Each dot = one run · mostly green with 1–2 red per week is healthy</p>
                </div>

                {zoneStrip.runs.length > 0 && (
                  <RunZoneStrip runs={zoneStrip.runs} weeks={zoneStrip.weeks} />
                )}

                {/* HR zones bar */}
                {zoneStrip.maxHREstimate != null && (
                  <div className="pt-3 border-t border-gray-50">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        Heart rate zones
                      </p>
                      <p className="text-[10px] text-gray-300">
                        est. max HR ~{Math.round(zoneStrip.maxHREstimate)} bpm
                      </p>
                    </div>
                    <HRZoneBar maxHR={zoneStrip.maxHREstimate} />
                    <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1.5">
                      {[
                        { dot: "bg-green-400", label: "Easy", desc: "Z1–Z2 · < 75% max HR · aerobic base" },
                        { dot: "bg-amber-400", label: "Moderate", desc: "Z3 · 75–85% · comfortably hard" },
                        { dot: "bg-red-400", label: "Hard", desc: "Z4–Z5 · > 85% · threshold & VO2 max" },
                      ].map(z => (
                        <div key={z.label} className="flex items-start gap-1.5 col-span-3 sm:col-span-1">
                          <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${z.dot}`} />
                          <div>
                            <p className="text-[10px] font-semibold text-gray-600">{z.label}</p>
                            <p className="text-[10px] text-gray-400">{z.desc}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Weekly mileage chart */}
            <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Weekly {distUnit} — last 12 weeks</p>
                  {avgMiles > 0 && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      Avg {useMetric ? Math.round(avgMiles * 1.60934 * 10) / 10 : Math.round(avgMiles * 10) / 10} {distUnit}/week
                    </p>
                  )}
                </div>
                {loadTrend.flagged && (
                  <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">
                    ⚠ Load spike
                  </span>
                )}
              </div>
              <BarChart data={weeklyMiles} threshold={thresholdDisplay} useMetric={useMetric} />
              {thresholdDisplay > 0 && (
                <p className="mt-2 text-xs text-gray-400">
                  Orange line: 10% above your recent average. Exceeding it regularly raises injury risk.
                </p>
              )}
            </div>
          </section>

          {/* ── Zone 4: Key notes ───────────────────────────────────────── */}
          {(paceZones || keyNotes.length > 0) && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                  Key notes
                </h2>
                {latestInsightDate && (
                  <span className="text-[10px] text-gray-300">
                    From run {formatDate(latestInsightDate)}
                  </span>
                )}
              </div>
              <div className="rounded-xl border border-gray-100 bg-white shadow-sm divide-y divide-gray-50">
                {/* Pacing zones — always first, single structured row */}
                {paceZones && (
                  <div className="px-4 py-3.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                      Pacing zones
                    </p>
                    <p className="text-sm font-mono text-gray-700">{paceZones}</p>
                  </div>
                )}
                {/* Extracted coaching notes */}
                {keyNotes.map((note, i) => (
                  <div key={i} className="flex items-baseline gap-3 px-4 py-3.5">
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-gray-400 w-20">
                      {note.label}
                    </span>
                    <p className="text-sm text-gray-700">{note.text}</p>
                  </div>
                ))}
              </div>
            </section>
          )}


          {/* ── Last 7 days ─────────────────────────────────────────── */}
          {lastWeekRuns.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                Last 7 days
              </h2>
              <div className="rounded-xl border border-gray-100 bg-white shadow-sm divide-y divide-gray-50">
                {lastWeekRuns.map((run, i) => {
                  const zoneColor = {
                    easy: "bg-green-400",
                    moderate: "bg-amber-400",
                    hard: "bg-red-400",
                    race: "bg-blue-400",
                  }[run.zone];
                  const zoneLabel = {
                    easy: "Easy", moderate: "Moderate", hard: "Hard", race: "Race",
                  }[run.zone];
                  return (
                    <div key={i} className="px-4 py-3.5 flex items-start gap-3">
                      <div className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${zoneColor}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-gray-800 truncate">
                            {run.activity_name ?? (run.activity_type === "TrailRun" ? "Trail run" : run.activity_type ?? "Run")}
                          </p>
                          <div className="flex items-center gap-2 shrink-0">
                            {run.distDisplay && (
                              <span className="text-[10px] text-gray-400 tabular-nums">{run.distDisplay}</span>
                            )}
                            {run.average_heartrate && (
                              <span className="text-[10px] text-gray-400 tabular-nums">{Math.round(run.average_heartrate)} bpm</span>
                            )}
                          </div>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          {formatDate(run.start_date)} · <span className="font-medium">{zoneLabel}</span>
                        </p>
                        {run.deansNote && (
                          <p className="text-xs text-gray-600 mt-1.5 leading-relaxed">{run.deansNote}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Empty state */}
          {activities.length === 0 && (
            !user.strava_athlete_id ? (
              <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-orange-100">
                  <span className="text-base font-bold text-[#FC4C02]">S</span>
                </div>
                <p className="text-sm font-semibold text-gray-800">Connect Strava to unlock your overview</p>
                <p className="mt-1 text-xs text-gray-400 max-w-xs mx-auto">
                  Dean analyzes your runs automatically. Connect Strava and your training insights will appear here.
                </p>
                <a
                  href={`/api/auth/strava?userId=${user.id}`}
                  className="mt-4 inline-block rounded-lg bg-[#FC4C02] px-5 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
                >
                  Connect Strava
                </a>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-gray-200 bg-white p-8 text-center">
                <p className="text-sm font-medium text-gray-600">No runs logged yet</p>
                <p className="mt-1 text-xs text-gray-400">
                  Complete a run and sync it to Strava — your insights will appear here automatically.
                </p>
              </div>
            )
          )}

          <p className="pb-4 text-center text-[10px] text-gray-300">Coach Dean · Reply to any text to chat</p>
            </div>}
          />
        </div>
      </div>
    </>
  );
}

// ─── No-token screen ──────────────────────────────────────────────────────────

function NoTokenScreen({ expired = false }: { expired?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gray-50 px-6 py-12">
      <div className="text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-xl font-bold text-white">
          D
        </div>
        <h1 className="mt-4 text-xl font-bold">Coach Dean</h1>
        <p className="mt-2 text-sm text-gray-500">
          {expired
            ? "That link has expired or isn't valid. Enter your number and I'll text you a fresh one."
            : "Enter your phone number and I'll text you a link to your dashboard."}
        </p>
      </div>
      <div className="w-full max-w-sm">
        <RequestLinkForm />
      </div>
    </div>
  );
}
