import type { Metadata } from "next";
import { supabase } from "@/lib/supabase";
import RequestLinkForm from "./request-link-form";
import { TokenPersist } from "./token-manager";
import { computeLoadTrend, computeAerobicEfficiencyTrend, computeACWR } from "@/lib/training-analytics";
import type { ActivityForAnalytics } from "@/lib/training-analytics";
import type { DashboardInsights } from "@/lib/dashboard-insights";

export const metadata: Metadata = {
  title: "Your Dashboard — Coach Dean",
  description: "Your training insights from Coach Dean.",
};

// ─── Types ────────────────────────────────────────────────────────────────────

type StravaBestEffort = {
  name: string;
  elapsed_time: number;
  distance: number;
  start_date: string;
  pr_rank: number | null;
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
  elevation_gain_feet: number | null;
  elevation_loss_feet: number | null;
  race_altitude_ft: number | null;
  trail_subtype: string | null;
  course_record_minutes: number | null;
};

type ConversationRow = {
  content: string;
  message_type: string | null;
  created_at: string | null;
  strava_activity_id: number | null;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function formatDate(dateStr: string, fmt: "short" | "long" = "short"): string {
  const d = dateStr.length === 10 ? new Date(dateStr + "T12:00:00Z") : new Date(dateStr);
  return d.toLocaleDateString("en-US",
    fmt === "long"
      ? { month: "long", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric" }
  );
}

function daysUntil(dateStr: string): number | null {
  const days = Math.ceil(
    (new Date(dateStr + "T12:00:00Z").getTime() - Date.now()) / (24 * 60 * 60 * 1000)
  );
  return days > 0 ? days : null;
}

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

function weekKey(date: Date, timezone: string): string {
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const [y, m, d] = localStr.split("-").map(Number);
  const local = new Date(Date.UTC(y!, m! - 1, d!));
  const dow = local.getUTCDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mon = new Date(Date.UTC(y!, m! - 1, d! - daysToMon));
  return mon.toISOString().slice(0, 10);
}

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

function buildWeeklyEfficiency(
  activities: ActivityRow[],
  timezone: string
): { label: string; val: number }[] {
  const RUN = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  const byWeek: Record<string, number[]> = {};
  for (const a of activities) {
    if (!RUN.has(a.activity_type ?? "")) continue;
    if ((a.distance_meters ?? 0) < 3000) continue;
    if (a.workout_type === 1) continue;
    if (!a.average_heartrate || !a.moving_time_seconds) continue;
    const ae = getAerobicEfficiency(a);
    if (!ae) continue;
    const k = weekKey(new Date(a.start_date), timezone);
    if (!byWeek[k]) byWeek[k] = [];
    byWeek[k].push(ae);
  }

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

function computeStatus(
  loadTrend: ReturnType<typeof computeLoadTrend>,
  effTrend: ReturnType<typeof computeAerobicEfficiencyTrend>,
  currentWeekMiles: number,
  weekDayNum: number
): { label: string; color: "orange" | "green" | "blue" | "gray"; detail: string } {
  if (currentWeekMiles === 0 && loadTrend.weeklyMiles.every(m => m === 0)) {
    return { label: "No recent activity", color: "gray", detail: "Connect Strava to start tracking" };
  }
  if (loadTrend.flagged && effTrend.trend === "worsening") {
    return { label: "Watch your load this week", color: "orange", detail: "Mileage jumped and efficiency is dipping — easy week?" };
  }
  if (loadTrend.flagged) {
    return { label: "Watch your load this week", color: "orange", detail: "Mileage spiked — keep remaining runs easy" };
  }
  if (effTrend.trend === "improving") {
    return { label: "Fitness building", color: "green", detail: "Aerobic efficiency is trending up" };
  }
  if (effTrend.trend === "worsening") {
    return { label: "Check recovery", color: "orange", detail: "Efficiency is dipping — may need more easy running" };
  }
  const earlyWeek = weekDayNum <= 3;
  return {
    label: "Holding steady",
    color: "blue",
    detail: earlyWeek ? "Load and efficiency stable — week in progress" : "Load and efficiency are stable",
  };
}

type ZoneRun = {
  date: string;
  zone: "easy" | "moderate" | "hard" | "race";
  signal: "workout_type" | "hr" | "pace" | "default";
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

  const maxHREstimate = (() => {
    const hrs = activities
      .filter(a => RUN.has(a.activity_type ?? "") && a.average_heartrate != null)
      .map(a => a.average_heartrate!);
    if (hrs.length === 0) return null;
    return Math.max(...hrs) * 1.12;
  })();

  const now = new Date();
  const weekSet: Set<string> = new Set();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    weekSet.add(weekKey(d, timezone));
  }
  const weeks = Array.from(weekSet);

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 42);

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

    if (a.workout_type === 1) { runs.push({ date: wk, zone: "race", signal: "workout_type" }); continue; }
    if (a.workout_type === 3) { runs.push({ date: wk, zone: "hard", signal: "workout_type" }); continue; }
    if (a.workout_type === 2) { runs.push({ date: wk, zone: "easy", signal: "workout_type" }); continue; }

    if (maxHREstimate && a.average_heartrate) {
      const hrPct = a.average_heartrate / maxHREstimate;
      if (hrPct < 0.75) runs.push({ date: wk, zone: "easy", signal: "hr" });
      else if (hrPct < 0.85) runs.push({ date: wk, zone: "moderate", signal: "hr" });
      else runs.push({ date: wk, zone: "hard", signal: "hr" });
      continue;
    }

    if (easyPaceSec && a.moving_time_seconds && a.distance_meters) {
      const paceSec = a.moving_time_seconds / (a.distance_meters / 1609.34);
      if (paceSec >= easyPaceSec - 45) runs.push({ date: wk, zone: "easy", signal: "pace" });
      else if (tempoPaceSec && paceSec <= tempoPaceSec + 15) runs.push({ date: wk, zone: "hard", signal: "pace" });
      else runs.push({ date: wk, zone: "moderate", signal: "pace" });
      continue;
    }

    runs.push({ date: wk, zone: "moderate", signal: "default" });
  }

  return { runs, weeks, maxHREstimate };
}

function interpretEfficiency(ae: number): string {
  if (ae >= 1.85) return "Elite endurance";
  if (ae >= 1.60) return "Advanced endurance base";
  if (ae >= 1.35) return "Strong aerobic foundation";
  if (ae >= 1.10) return "Developing aerobic engine";
  if (ae >= 1.00) return "Building your base";
  return "Getting started";
}

// ─── SVG components ───────────────────────────────────────────────────────────

function BarChart({
  data,
  avgMiles,
  useMetric,
}: {
  data: { label: string; miles: number; isCurrent: boolean }[];
  avgMiles: number;
  useMetric: boolean;
}) {
  const values = data.map(d => useMetric ? d.miles * 1.60934 : d.miles);
  const avg = useMetric ? avgMiles * 1.60934 : avgMiles;
  const max = Math.max(...values, avg * 1.15, 1);
  const W = 560, H = 110;
  const PL = 4, PR = 4, PT = 8, PB = 22;
  const barW = Math.floor((W - PL - PR) / data.length);
  const chartH = H - PT - PB;

  const getColor = (v: number, isCurrent: boolean) => {
    if (isCurrent) return "#166534";          // dark green — current week
    if (avg > 0 && v > avg * 1.1) return "#f59e0b"; // amber — spike
    return "#bbf7d0";                          // light green — normal
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: "280px" }} aria-label="Weekly mileage">
      {data.map((d, i) => {
        const v = values[i]!;
        const barH = v > 0 ? Math.max(3, (v / max) * chartH) : 0;
        const x = PL + i * barW + 2;
        const y = PT + chartH - barH;
        const isLast = i === data.length - 1;
        return (
          <g key={i}>
            <rect x={x} y={y} width={Math.max(1, barW - 4)} height={barH} rx="2"
              fill={getColor(v, d.isCurrent)} />
            {(i % 4 === 0 || isLast) && (
              <text x={x + (barW - 4) / 2} y={H - 5} textAnchor="middle" fontSize="8" fill="#94a3b8">
                {isLast ? "Now" : d.label}
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
  const W = 560, H = 80;
  const PL = 4, PR = 4, PT = 8, PB = 8;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;

  const pts = vals.map((v, i) => {
    const x = PL + (i / (vals.length - 1)) * chartW;
    const y = PT + chartH * (1 - (v - min) / (max - min));
    return [x, y] as [number, number];
  });
  const polyline = pts.map(([x, y]) => `${x},${y}`).join(" ");

  const half = Math.floor(vals.length / 2);
  const firstAvg = vals.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const lastAvg = vals.slice(-half).reduce((s, v) => s + v, 0) / half;
  const improving = lastAvg > firstAvg * 1.02;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: "200px" }} aria-label="Aerobic efficiency trend">
      <polyline points={polyline} fill="none"
        stroke={improving ? "#166534" : "#94a3b8"} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {/* end dot */}
      {pts[pts.length - 1] && (
        <circle cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r="3.5"
          fill={improving ? "#166534" : "#94a3b8"} />
      )}
    </svg>
  );
}

function RunZoneStrip({ runs, weeks }: { runs: ZoneRun[]; weeks: string[] }) {
  if (runs.length === 0) return null;

  const ZONE_COLOR: Record<ZoneRun["zone"], string> = {
    easy: "#22c55e", moderate: "#f59e0b", hard: "#ef4444", race: "#3b82f6",
  };

  const DOT = 10, GAP = 3, WKGAP = 8;

  const byWeek: Record<string, ZoneRun["zone"][]> = {};
  for (const wk of weeks) byWeek[wk] = [];
  for (const r of runs) {
    if (byWeek[r.date]) byWeek[r.date]!.push(r.zone);
  }

  let totalW = 0;
  for (const wk of weeks) {
    const count = byWeek[wk]?.length ?? 0;
    if (count > 0) totalW += count * (DOT + GAP) - GAP + WKGAP;
  }
  totalW = Math.max(totalW - WKGAP, 10);

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
  const svgH = DOT + LABEL_H + 4;

  return (
    <div>
      <svg viewBox={`0 0 ${totalW} ${svgH}`} className="w-full" style={{ minWidth: "160px" }} aria-label="Run zone history">
        {dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={DOT / 2} r={DOT / 2 - 0.5}
            fill={ZONE_COLOR[d.zone]} opacity="0.85" />
        ))}
        {wkLabels.map((l, i) => (
          <text key={i} x={l.x} y={svgH - 1} textAnchor="middle" fontSize="7" fill="#9ca3af">
            {l.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

function HRZoneBar({ maxHR }: { maxHR: number }) {
  const zones = [
    { label: "Z1", pct: 0.60, color: "#93c5fd" },
    { label: "Z2", pct: 0.75, color: "#34d399" },
    { label: "Z3", pct: 0.85, color: "#fbbf24" },
    { label: "Z4", pct: 0.93, color: "#f97316" },
    { label: "Z5", pct: 1.00, color: "#ef4444" },
  ];
  const prevPcts = [0, 0.60, 0.75, 0.85, 0.93];

  return (
    <div className="space-y-1">
      <div className="flex rounded-md overflow-hidden h-6">
        {zones.map((z) => (
          <div key={z.label} className="flex items-center justify-center flex-1" style={{ backgroundColor: z.color }}>
            <span className="text-[10px] font-bold text-white drop-shadow-sm">{z.label}</span>
          </div>
        ))}
      </div>
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
    </div>
  );
}

function EfficiencySpectrum({ value }: { value: number }) {
  const MIN = 0.8, MAX = 2.0;
  const pct = Math.max(2, Math.min(97, ((value - MIN) / (MAX - MIN)) * 100));

  return (
    <div>
      <div className="relative h-0.5 bg-gray-100 rounded-full mb-3">
        <div
          className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-green-700 border-2 border-white shadow"
          style={{ left: `calc(${pct}% - 6px)` }}
        />
      </div>
      <div className="flex justify-between">
        <span className="text-[10px] text-gray-400">just starting out</span>
        <span className="text-[10px] text-gray-400">elite endurance</span>
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
  ] = await Promise.all([
    supabase
      .from("training_profiles")
      .select("goal, race_date, goal_distance_miles, preferred_units, terrain_type, current_easy_pace, current_tempo_pace, current_interval_pace, injury_notes, manual_prs, training_days, this_week_override_days, this_week_override_expires, dashboard_insights")
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
      .select("id, race_name, race_date, priority, goal_distance_miles, goal_time_minutes, goal, elevation_gain_feet, elevation_loss_feet, race_altitude_ft, trail_subtype, course_record_minutes")
      .eq("user_id", user.id)
      .gte("race_date", new Date().toISOString().split("T")[0]!)
      .order("race_date", { ascending: true })
      .limit(6),
    supabase
      .from("training_state")
      .select("current_week, current_phase, weekly_mileage_target, weekly_plan_sessions")
      .eq("user_id", user.id)
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
    max_heartrate: null,
    elevation_gain: null,
    average_cadence: null,
    aerobic_efficiency: getAerobicEfficiency(a),
    cardiac_decoupling_pct: a.cardiac_decoupling_pct,
  }));

  const loadTrend = computeLoadTrend(analyticsActivities, timezone);
  const acwr = computeACWR(analyticsActivities, timezone);
  const effTrend = computeAerobicEfficiencyTrend(analyticsActivities, timezone);
  const effSeries = buildWeeklyEfficiency(activities, timezone);

  // Current efficiency value (most recent weekly avg)
  const currentEffVal = effSeries[effSeries.length - 1]?.val ?? null;

  // Trend label for aerobic efficiency
  const effTrendLabel = (() => {
    if (effTrend.trend === "improving") return "↑ improving";
    if (effTrend.trend === "worsening") return "↓ declining";
    return "↔ holding steady";
  })();

  // Weekly chart
  const weeklyMiles = buildWeeklyMiles(activities, timezone);
  const currentWeekMiles = weeklyMiles[weeklyMiles.length - 1]?.miles ?? 0;
  const nonZeroWeeks = weeklyMiles.filter(w => w.miles > 0);
  const avgMiles = nonZeroWeeks.length > 0
    ? nonZeroWeeks.reduce((s, w) => s + w.miles, 0) / nonZeroWeeks.length
    : 0;

  // Display values in correct units
  const currentWeekDisplay = useMetric
    ? Math.round(currentWeekMiles * 1.60934 * 10) / 10
    : Math.round(currentWeekMiles * 10) / 10;
  const avgDisplay = useMetric
    ? Math.round(avgMiles * 1.60934 * 10) / 10
    : Math.round(avgMiles * 10) / 10;

  // Weekly target (from training state, or fall back to avg)
  const weeklyTargetMiles = stateData?.weekly_mileage_target ?? (avgMiles > 0 ? Math.round(avgMiles) : null);
  const weeklyTargetDisplay = weeklyTargetMiles
    ? useMetric ? Math.round(weeklyTargetMiles * 1.60934 * 10) / 10 : weeklyTargetMiles
    : null;
  const progressPct = weeklyTargetMiles && weeklyTargetMiles > 0
    ? Math.min(100, (currentWeekMiles / weeklyTargetMiles) * 100)
    : 0;

  // Day of week in athlete's timezone
  const weekDayNum = (() => {
    const map: Record<string, number> = { Su: 7, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
    const narrow = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(new Date());
    return map[narrow.slice(0, 2)] ?? 4;
  })();

  // Status signal
  const status = computeStatus(loadTrend, effTrend, currentWeekMiles, weekDayNum);
  const statusDotClass = {
    orange: "bg-amber-400",
    green: "bg-green-500",
    blue: "bg-blue-400",
    gray: "bg-gray-300",
  }[status.color];

  // Max HR estimate
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  const maxHREstimate = (() => {
    const hrs = activities
      .filter(a => RUN_TYPES.has(a.activity_type ?? "") && a.average_heartrate != null)
      .map(a => a.average_heartrate!);
    if (hrs.length === 0) return null;
    return Math.max(...hrs) * 1.12;
  })();

  // Zone data
  const zoneData = buildZoneStrip(
    activities,
    (profileData?.current_easy_pace as string | null) ?? null,
    (profileData?.current_tempo_pace as string | null) ?? null,
    timezone
  );

  // Last 7 days runs
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

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
      RUN_TYPES.has(a.activity_type ?? "") &&
      new Date(a.start_date) >= sevenDaysAgo &&
      (a.distance_meters ?? 0) > 500
    )
    .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())
    .map(a => {
      let zone: ZoneRun["zone"] = "moderate";
      if (a.workout_type === 1) zone = "race";
      else if (a.workout_type === 3) zone = "hard";
      else if (a.workout_type === 2) zone = "easy";
      else if (maxHREstimate && a.average_heartrate) {
        const hrPct = a.average_heartrate / maxHREstimate;
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

  // Paces
  const rawEasy = (profileData?.current_easy_pace as string | null) ?? null;
  const rawTempo = (profileData?.current_tempo_pace as string | null) ?? null;
  const rawInterval = (profileData?.current_interval_pace as string | null) ?? null;
  const easyRange = rawEasy ? (() => {
    const parts = rawEasy.replace("/mi", "").split(":");
    if (parts.length === 2) {
      const base = parseInt(parts[0]!) * 60 + parseInt(parts[1]!);
      const ceilSec = base + 30;
      return `${rawEasy.replace("/mi", "")}–${Math.floor(ceilSec / 60)}:${String(ceilSec % 60).padStart(2, "0")}/mi`;
    }
    return rawEasy;
  })() : null;

  // Dashboard insights
  const dashboardInsights = (() => {
    const raw = profileData?.dashboard_insights;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.summary !== "string") return null;
    return obj as unknown as DashboardInsights;
  })();

  // ACWR load warning
  const acwrWarning = acwr.acwr !== null ? (() => {
    const ceilingMiles = Math.round(acwr.chronicLoad * 1.3 * 10) / 10;
    const avgMilesAcwr = Math.round(acwr.chronicLoad * 10) / 10;
    const ceilingDisplay = useMetric
      ? `${Math.round(ceilingMiles * 1.60934 * 10) / 10} ${distUnit}`
      : `${ceilingMiles} ${distUnit}`;
    const avgAcwrDisplay = useMetric
      ? `${Math.round(avgMilesAcwr * 1.60934 * 10) / 10} ${distUnit}`
      : `${avgMilesAcwr} ${distUnit}`;
    const exceeded = (acwr.acwr ?? 0) > 1.3;
    return { ceilingDisplay, avgAcwrDisplay, exceeded };
  })() : null;

  return (
    <>
      <TokenPersist token={token} />
      <div className="min-h-screen bg-gray-50 text-gray-900">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="border-b border-gray-200 bg-white px-5 py-4">
          <div className="mx-auto max-w-xl">
            <a href="/">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/heavy_logo.svg" alt="Coach Dean" style={{ height: 32 }} />
            </a>
          </div>
        </div>

        <div className="mx-auto max-w-xl px-5 py-6 space-y-8">

          {/* ══════════════════════════════════════════════════════════════
              SUMMARY
          ══════════════════════════════════════════════════════════════ */}
          <section className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Summary</p>

            {/* Status card: health signal + mileage progress + race chips */}
            <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm space-y-4">
              {/* Status row */}
              <div className="flex items-start gap-3">
                <div className={`mt-1 h-3 w-3 shrink-0 rounded-full ${statusDotClass}`} />
                <div>
                  <p className="text-base font-bold text-gray-900 leading-tight">{status.label}</p>
                  <p className="text-sm text-gray-500 mt-0.5">{status.detail}</p>
                </div>
              </div>

              {/* Weekly mileage progress bar */}
              {weeklyTargetDisplay != null && (
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-green-600"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <span className="text-sm text-gray-600 tabular-nums shrink-0">
                    {currentWeekDisplay} / {weeklyTargetDisplay} {distUnit}
                  </span>
                </div>
              )}

              {/* Race chips */}
              {races.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {races.slice(0, 4).map(race => {
                    const days = daysUntil(race.race_date);
                    const raceLabel = race.race_name ?? (race.goal ? race.goal.replace(/_/g, " ") : "Race");
                    return (
                      <div key={race.id} className="rounded-lg bg-gray-50 px-3 py-2.5">
                        <p className="text-sm font-semibold text-gray-800 leading-tight truncate">{raceLabel}</p>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          {formatDate(race.race_date, "long")}{days ? ` · ${days} days` : ""}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Dean's Focus */}
            {dashboardInsights?.focuses && dashboardInsights.focuses.length > 0 ? (
              <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
                <div className="divide-y divide-gray-50">
                  {dashboardInsights.focuses.map((focus, i) => (
                    <div key={i} className="flex items-baseline gap-3 px-4 py-3.5">
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-gray-400 w-20 leading-snug">
                        {focus.label}
                      </span>
                      <p className="text-sm text-gray-700">{focus.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : activities.length > 0 ? (
              <div className="rounded-xl border border-gray-100 bg-white px-4 py-3.5 shadow-sm">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Dean&apos;s Focus</p>
                <p className="text-sm text-gray-400">Focus areas will appear after your next run.</p>
              </div>
            ) : null}
          </section>

          {/* ══════════════════════════════════════════════════════════════
              INJURY & LOAD
          ══════════════════════════════════════════════════════════════ */}
          {activities.length > 0 && (
            <section className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Injury &amp; Load</p>

              {/* 12-week bar chart */}
              <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold">Weekly mileage — last 12 weeks</p>
                    {avgDisplay > 0 && (
                      <p className="text-xs text-gray-400 mt-0.5">Avg {avgDisplay} {distUnit} / week</p>
                    )}
                  </div>
                  {loadTrend.flagged && (
                    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-semibold text-amber-700 shrink-0">
                      ⚠ Load spike
                    </span>
                  )}
                </div>
                <BarChart data={weeklyMiles} avgMiles={avgMiles} useMetric={useMetric} />

                {/* ACWR plain-language warning */}
                {acwrWarning && (acwrWarning.exceeded || loadTrend.flagged) && (
                  <div className={`mt-3 rounded-lg border px-3 py-2.5 ${
                    acwrWarning.exceeded ? "bg-amber-50 border-amber-100" : "bg-gray-50 border-gray-100"
                  }`}>
                    <p className={`text-[12px] font-medium leading-snug ${acwrWarning.exceeded ? "text-amber-800" : "text-gray-700"}`}>
                      {acwrWarning.exceeded
                        ? `Over safe limit — stay under ${acwrWarning.ceilingDisplay} this week`
                        : `Stay under ${acwrWarning.ceilingDisplay} this week`}
                      {" — "}
                      {acwrWarning.exceeded ? "30%" : "10%"} above your {acwrWarning.avgAcwrDisplay}/week 4-week average.
                      {" "}Dial back remaining runs to protect your recovery.
                    </p>
                  </div>
                )}
              </div>

              {/* Strength & recovery (shown when LLM has generated it from injury notes) */}
              {dashboardInsights?.strength_recovery && (() => {
                const sr = dashboardInsights.strength_recovery!;
                return (
                  <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden"
                    style={{ borderLeft: "4px solid #0d9488" }}>
                    <div className="p-5 space-y-4">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-semibold text-gray-900">Strength &amp; recovery this week</p>
                        <span className="rounded-full bg-teal-50 border border-teal-200 px-2.5 py-0.5 text-[10px] font-medium text-teal-700 shrink-0">
                          From injury history
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 leading-relaxed">{sr.intro}</p>

                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-3">
                          Strength — {sr.frequency}
                        </p>
                        <div className="space-y-3">
                          {sr.exercises.map((ex, i) => (
                            <div key={i} className="flex items-start gap-2.5">
                              <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-500" />
                              <div>
                                <p className="text-sm font-semibold text-gray-800">{ex.name}</p>
                                <p className="text-[11px] text-gray-500 mt-0.5">{ex.specs}</p>
                                <p className="text-[11px] italic text-gray-400 mt-0.5">{ex.reason}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {sr.cross_training && (
                        <div className="border-t border-gray-50 pt-4">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-2.5">
                            Cross-training option
                          </p>
                          <div className="flex items-start gap-3">
                            <span className="text-xl shrink-0">{sr.cross_training.emoji}</span>
                            <div>
                              <p className="text-sm font-semibold text-gray-800">{sr.cross_training.name}</p>
                              <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">{sr.cross_training.desc}</p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </section>
          )}

          {/* ══════════════════════════════════════════════════════════════
              FITNESS PROGRESS
          ══════════════════════════════════════════════════════════════ */}
          {(effSeries.length >= 4 || zoneData.runs.length > 0 || rawEasy || rawTempo || rawInterval) && (
            <section className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Fitness Progress</p>

              <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm space-y-5">
                {/* Aerobic efficiency sparkline */}
                {effSeries.length >= 4 && currentEffVal != null && (
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm text-gray-500">Is it working?</p>
                      <div className="flex items-baseline gap-2 mt-0.5">
                        <span className="text-3xl font-bold tabular-nums text-gray-900">
                          {currentEffVal.toFixed(3)}
                        </span>
                        <span className="text-sm text-gray-400">m/beat</span>
                        <span className={`text-sm font-medium ml-1 ${
                          effTrend.trend === "improving" ? "text-green-600"
                          : effTrend.trend === "worsening" ? "text-red-500"
                          : "text-gray-400"
                        }`}>
                          {effTrendLabel}
                        </span>
                      </div>
                    </div>

                    <LineChart data={effSeries} />

                    <EfficiencySpectrum value={currentEffVal} />

                    <p className="text-[11px] text-gray-400 leading-relaxed">
                      How far you travel per heartbeat on easy runs. Rises gradually with consistent base work — most runners see meaningful improvement over 3–6 months.
                    </p>
                  </div>
                )}

                {/* Training zones ribbon */}
                {zoneData.runs.length > 0 && (
                  <div className={effSeries.length >= 4 ? "border-t border-gray-50 pt-5 space-y-3" : "space-y-3"}>
                    <div>
                      <p className="text-sm font-semibold text-gray-800">Training zones — last 6 weeks</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        Each dot = one run · mostly green with 1–2 red per week is healthy
                      </p>
                    </div>

                    <RunZoneStrip runs={zoneData.runs} weeks={zoneData.weeks} />

                    {/* Zone legend */}
                    <div className="flex items-center gap-4 flex-wrap">
                      {([
                        { zone: "easy",     color: "bg-green-400", label: "Easy" },
                        { zone: "moderate", color: "bg-amber-400",  label: "Moderate" },
                        { zone: "hard",     color: "bg-red-400",   label: "Hard" },
                        { zone: "race",     color: "bg-blue-400",  label: "Race" },
                      ] as const).map(z => (
                        <div key={z.zone} className="flex items-center gap-1.5">
                          <div className={`h-2.5 w-2.5 rounded-full ${z.color}`} />
                          <span className="text-[11px] text-gray-500">{z.label}</span>
                        </div>
                      ))}
                    </div>

                    {/* HR zones bar */}
                    {zoneData.maxHREstimate && (
                      <div className="space-y-2 pt-1">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Heart Rate Zones</p>
                          <p className="text-[10px] text-gray-400">est. max HR ~{Math.round(zoneData.maxHREstimate)} bpm</p>
                        </div>
                        <HRZoneBar maxHR={zoneData.maxHREstimate} />
                        <div className="grid grid-cols-3 gap-x-3 gap-y-1 pt-1">
                          {[
                            { dot: "bg-green-400", label: "Easy", sub: "Z1–Z2 · <75% max HR · aerobic base" },
                            { dot: "bg-amber-400", label: "Moderate", sub: "Z3 · 75–85% · comfortably hard" },
                            { dot: "bg-red-400",   label: "Hard",     sub: "Z4–Z5 · >85% · threshold & VO2 max" },
                          ].map(z => (
                            <div key={z.label}>
                              <div className="flex items-center gap-1">
                                <div className={`h-2 w-2 rounded-full ${z.dot}`} />
                                <span className="text-[11px] font-medium text-gray-700">{z.label}</span>
                              </div>
                              <p className="text-[9px] text-gray-400 mt-0.5 leading-snug">{z.sub}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Prescribed paces */}
                {(easyRange || rawTempo || rawInterval) && (
                  <div className={
                    (effSeries.length >= 4 || zoneData.runs.length > 0)
                      ? "border-t border-gray-50 pt-5 space-y-2"
                      : "space-y-2"
                  }>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Prescribed Paces</p>
                    <div className="flex flex-wrap gap-2">
                      {[
                        easyRange && { label: "Easy", pace: easyRange, dot: "bg-green-400" },
                        rawTempo && { label: "Tempo", pace: rawTempo, dot: "bg-amber-400" },
                        rawInterval && { label: "Intervals", pace: rawInterval, dot: "bg-red-400" },
                      ].filter(Boolean).map((p) => {
                        const pace = p as { label: string; pace: string; dot: string };
                        return (
                          <div key={pace.label} className="rounded-lg bg-gray-50 px-3 py-2.5 flex items-center gap-2">
                            <div className={`h-2 w-2 rounded-full shrink-0 ${pace.dot}`} />
                            <div>
                              <p className="text-[9px] font-semibold uppercase tracking-wide text-gray-400">{pace.label}</p>
                              <p className="text-sm font-bold tabular-nums text-gray-800">{pace.pace}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-gray-400">Pace targets from Dean · not directly linked to HR zones above</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ══════════════════════════════════════════════════════════════
              LAST 7 DAYS
          ══════════════════════════════════════════════════════════════ */}
          {lastWeekRuns.length > 0 && (
            <section className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Last 7 Days</p>
              <div className="rounded-xl border border-gray-100 bg-white shadow-sm divide-y divide-gray-50">
                {lastWeekRuns.map((run, i) => {
                  const zoneColor = {
                    easy: "bg-green-400", moderate: "bg-amber-400",
                    hard: "bg-red-400", race: "bg-blue-400",
                  }[run.zone];
                  const zoneLabel = {
                    easy: "Easy", moderate: "Moderate", hard: "Hard", race: "Race",
                  }[run.zone];
                  return (
                    <div key={i} className="px-4 py-3.5 flex items-center gap-3">
                      <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${zoneColor}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">
                          {run.activity_name ?? (run.activity_type === "TrailRun" ? "Trail run" : run.activity_type ?? "Run")}
                        </p>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          {formatDate(run.start_date)} · {zoneLabel}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        {run.distDisplay && (
                          <p className="text-sm font-medium text-gray-700 tabular-nums">{run.distDisplay}</p>
                        )}
                        {run.average_heartrate && (
                          <p className="text-[11px] text-gray-400 tabular-nums mt-0.5">
                            {Math.round(run.average_heartrate)} bpm
                          </p>
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
                <p className="text-sm font-semibold text-gray-800">Connect Strava to unlock your dashboard</p>
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
        </div>
      </div>
    </>
  );
}

// ─── No-token screen ──────────────────────────────────────────────────────────

function NoTokenScreen({ expired = false }: { expired?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-white px-6 py-12">
      <div className="text-center">
        <div
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-white"
          style={{ background: "#1a5c35" }}
        >
          <span style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif", fontSize: 15, fontWeight: 600, letterSpacing: 0.5 }}>
            CD
          </span>
        </div>
        <h1 className="mt-4 font-serif text-2xl font-normal">Coach Dean</h1>
        <p className="mt-2 text-sm text-gray-500 max-w-xs mx-auto leading-relaxed">
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
