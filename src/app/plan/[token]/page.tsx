import { notFound } from "next/navigation";
import { verifyPlanToken } from "@/lib/session-token";
import { getRoutine, EXERCISES } from "@/lib/strength-library";
import { supabase } from "@/lib/supabase";
import { ExerciseSection } from "./ExerciseSection";
import { getRecoveryEstimate } from "@/lib/exercise-library";
import type { StoredStrengthRoutine } from "@/lib/strength-library";

// ── helpers ──────────────────────────────────────────────────────────────────

function weekBounds(timezone: string): { weekStart: string; weekEnd: string; today: string } {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d);
  const todayStr = fmt(new Date());
  const [y, m, d] = todayStr.split("-").map(Number);
  const localToday = new Date(Date.UTC(y, m - 1, d));
  const dow = localToday.getUTCDay(); // 0=Sun
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(localToday.getTime() + daysToMon * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return {
    weekStart: monday.toISOString().split("T")[0],
    weekEnd: sunday.toISOString().split("T")[0],
    today: todayStr,
  };
}

function weeksUntil(raceDate: string, timezone: string): number {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d);
  const todayStr = fmt(new Date());
  const msPerWeek = 7 * 86400000;
  const diff = new Date(raceDate).getTime() - new Date(todayStr).getTime();
  return Math.max(0, Math.round(diff / msPerWeek));
}

function formatPace(metersPerSecond: number, isMetric: boolean): string {
  const paceSecPerUnit = isMetric
    ? 1000 / metersPerSecond
    : 1609.34 / metersPerSecond;
  const mins = Math.floor(paceSecPerUnit / 60);
  const secs = Math.round(paceSecPerUnit % 60);
  return `${mins}:${secs.toString().padStart(2, "0")} /${isMetric ? "km" : "mi"}`;
}

function metersToDisplay(meters: number, isMetric: boolean): string {
  const val = isMetric ? meters / 1000 : meters / 1609.34;
  return `${val.toFixed(1)}${isMetric ? "km" : "mi"}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "long", day: "numeric", timeZone: "UTC",
  });
}

// ── pain timeline SVG ─────────────────────────────────────────────────────────

type PainPoint = { date: string; pain_level: number };

function PainChart({ points, holdSince, today }: { points: PainPoint[]; holdSince: string; today: string }) {
  if (points.length === 0) return null;

  const W = 300;
  const H = 64;
  const PAD = { top: 8, right: 8, bottom: 8, left: 24 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const startMs = new Date(holdSince).getTime();
  const endMs = new Date(today).getTime();
  const totalMs = Math.max(endMs - startMs, 1);

  const toX = (dateStr: string) =>
    PAD.left + ((new Date(dateStr).getTime() - startMs) / totalMs) * chartW;
  const toY = (level: number) =>
    PAD.top + ((10 - level) / 10) * chartH;

  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const pathD = sorted
    .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(p.date).toFixed(1)} ${toY(p.pain_level).toFixed(1)}`)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label="Pain level over time">
      {/* Y-axis labels */}
      <text x={PAD.left - 4} y={PAD.top + 4} textAnchor="end" fontSize="8" fill="#9ca3af">10</text>
      <text x={PAD.left - 4} y={PAD.top + chartH / 2 + 3} textAnchor="end" fontSize="8" fill="#9ca3af">5</text>
      <text x={PAD.left - 4} y={PAD.top + chartH} textAnchor="end" fontSize="8" fill="#9ca3af">0</text>
      {/* Zero line (pain-free) */}
      <line
        x1={PAD.left} y1={toY(0)}
        x2={PAD.left + chartW} y2={toY(0)}
        stroke="#d1fae5" strokeWidth="1" strokeDasharray="3 3"
      />
      {/* Chart line */}
      <path d={pathD} fill="none" stroke="#111827" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {/* Data points */}
      {sorted.map((p) => (
        <circle
          key={p.date}
          cx={toX(p.date).toFixed(1)}
          cy={toY(p.pain_level).toFixed(1)}
          r="3"
          fill="white"
          stroke="#111827"
          strokeWidth="2"
        />
      ))}
    </svg>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default async function PlanPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const planPayload = verifyPlanToken(token);
  if (!planPayload) notFound();

  const { userId } = planPayload;

  const utcToday = new Date().toISOString().split("T")[0];

  const [userResult, stateResult, planResult, raceResult, profileResult] = await Promise.all([
    supabase.from("users").select("name, timezone").eq("id", userId).single(),
    supabase.from("training_state")
      .select("current_week, current_phase, weekly_mileage_target, weekly_plan_sessions, weekly_strength_day, weekly_strength_routine_key, injury_hold_since, last_pain_level, pain_reported_at")
      .eq("user_id", userId).maybeSingle(),
    supabase.from("training_plans").select("total_weeks")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("races").select("race_name, race_date, goal_distance_miles, goal")
      .eq("user_id", userId).gte("race_date", utcToday)
      .order("race_date", { ascending: true }).limit(1).maybeSingle(),
    supabase.from("training_profiles")
      .select("dashboard_insights, preferred_units, injury_body_part, injury_severity").eq("user_id", userId).maybeSingle(),
  ]);

  if (userResult.error) notFound();

  const user = userResult.data;
  const state = stateResult.data;
  const plan = planResult.data;
  const race = raceResult.data;
  const profile = profileResult.data;

  const timezone = user.timezone ?? "UTC";
  const { weekStart, weekEnd, today } = weekBounds(timezone);
  const isMetric = profile?.preferred_units === "km";

  const injuryHoldSince = (state?.injury_hold_since as string | null) ?? null;

  // Fetch pain check-ins (last 30 days) and this week's activities in parallel
  const dailySessionKey = `plan:${userId}:${today}`;
  const holdStart = injuryHoldSince ?? addDays(today, -30);
  const [activitiesResult, strengthSessionResult, painCheckinsResult] = await Promise.all([
    supabase.from("activities")
      .select("start_date, distance_meters, activity_type, average_pace")
      .eq("user_id", userId)
      .gte("start_date", weekStart)
      .lte("start_date", weekEnd + "T23:59:59Z"),
    supabase.from("pt_sessions")
      .select("exercises_done")
      .eq("user_id", userId)
      .eq("session_key", dailySessionKey)
      .maybeSingle(),
    injuryHoldSince
      ? supabase.from("pain_checkins")
          .select("date, pain_level")
          .eq("user_id", userId)
          .gte("date", holdStart)
          .order("date", { ascending: true })
      : Promise.resolve({ data: null }),
  ]);

  const activities = activitiesResult.data ?? [];
  const initialDone: string[] = strengthSessionResult.data?.exercises_done ?? [];
  const painPoints: PainPoint[] = (painCheckinsResult.data ?? []) as PainPoint[];

  // Weekly mileage so far (running only)
  const runActivities = activities.filter((a) => a.activity_type === "Run");
  const weekMileageSoFar = runActivities.reduce((sum, a) => {
    return sum + (isMetric ? (a.distance_meters ?? 0) / 1000 : (a.distance_meters ?? 0) / 1609.34);
  }, 0);
  const weekTarget = state?.weekly_mileage_target ?? null;

  // Sessions: mark done if there's an activity on that date
  type Session = { day: string; date: string; label: string };
  const sessions = ((state?.weekly_plan_sessions ?? []) as Session[]);
  const activityDates = new Set(activities.map((a) => (a.start_date ?? "").split("T")[0]));

  // Strength routine: prefer this week's deterministically-scheduled routine key
  // (weekly_strength_routine_key, re-evaluated every plan generation/recap from current
  // injury status); fall back to the profile's stored injury-triggered routine for users
  // whose training_state predates weekly strength scheduling.
  const insights = profile?.dashboard_insights as Record<string, unknown> | null;
  const storedRoutine = insights?.strength_recovery as StoredStrengthRoutine | null;
  const scheduledStrengthDay = (state?.weekly_strength_day as string | null) ?? null;
  const routineKey = (state?.weekly_strength_routine_key as string | null) ?? storedRoutine?.routine_key ?? null;
  const routine = routineKey ? getRoutine(routineKey) : null;
  const exercises = routine ? routine.exerciseIds.map((id) => EXERCISES[id]).filter(Boolean) : [];

  const weeksOut = race ? weeksUntil(race.race_date, timezone) : null;
  const currentWeek = state?.current_week ?? null;
  const totalWeeks = plan?.total_weeks ?? null;
  const progressPct =
    currentWeek && totalWeeks ? Math.min(100, Math.round((currentWeek / totalWeeks) * 100)) : null;

  const phase = state?.current_phase;
  const firstName = user.name?.split(" ")[0] ?? "Your";

  // Recovery estimate
  const bodyPart = (profile?.injury_body_part as string | null) ?? null;
  const severity = (profile?.injury_severity as "mild" | "moderate" | "severe" | null) ?? null;
  const recoveryEstimate = bodyPart ? getRecoveryEstimate(bodyPart, severity) : null;
  const holdDays = injuryHoldSince
    ? Math.floor((new Date(today).getTime() - new Date(injuryHoldSince).getTime()) / 86400000)
    : 0;
  const earliestReturnDate = injuryHoldSince && recoveryEstimate
    ? addDays(injuryHoldSince, recoveryEstimate.minWeeks * 7)
    : null;
  const latestReturnDate = injuryHoldSince && recoveryEstimate
    ? addDays(injuryHoldSince, recoveryEstimate.maxWeeks * 7)
    : null;
  const latestPainLevel = (state?.last_pain_level as number | null) ?? null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-md bg-white min-h-screen">

        {/* Header */}
        <div className="px-5 pt-8 pb-5 border-b border-gray-100">
          <p className="text-xs font-medium tracking-widest text-gray-400 uppercase">Coach Dean</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">{firstName}&apos;s {injuryHoldSince ? "Recovery" : "Plan"}</h1>
        </div>

        {/* Injury recovery section — shown instead of race progress when on hold */}
        {injuryHoldSince ? (
          <div className="px-5 py-5 border-b border-gray-100">
            <p className="text-xs font-semibold tracking-widest text-gray-400 uppercase mb-3">Recovery</p>

            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <p className="font-bold text-gray-900 capitalize">{bodyPart?.replace(/_/g, " ") ?? "Injury"} hold</p>
                <p className="text-sm text-gray-500 mt-0.5">
                  Day {holdDays} · started {fmtDate(injuryHoldSince)}
                </p>
                {latestPainLevel !== null && (
                  <p className="text-sm text-gray-500 mt-0.5">
                    Last pain report: <span className={`font-semibold ${latestPainLevel <= 2 ? "text-green-600" : latestPainLevel <= 5 ? "text-yellow-600" : "text-red-500"}`}>{latestPainLevel}/10</span>
                  </p>
                )}
              </div>
              {earliestReturnDate && latestReturnDate && (
                <div className="text-right shrink-0">
                  <p className="text-xs text-gray-400 uppercase tracking-wide mb-0.5">Est. return</p>
                  <p className="text-sm font-semibold text-gray-700">{fmtDate(earliestReturnDate)}</p>
                  <p className="text-xs text-gray-400">to {fmtDate(latestReturnDate)}</p>
                </div>
              )}
            </div>

            {/* Pain timeline chart */}
            {painPoints.length >= 2 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-400">Pain level over time</p>
                  <p className="text-xs text-gray-400">lower is better</p>
                </div>
                <PainChart points={painPoints} holdSince={injuryHoldSince} today={today} />
                <div className="flex justify-between mt-1">
                  <p className="text-xs text-gray-300">{fmtDate(injuryHoldSince)}</p>
                  <p className="text-xs text-gray-300">Today</p>
                </div>
              </div>
            )}

            {painPoints.length === 1 && (
              <p className="text-xs text-gray-400 mt-1">Check back tomorrow to see your progress trend.</p>
            )}
            {painPoints.length === 0 && (
              <p className="text-xs text-gray-400 mt-1">Reply to your morning check-in with a pain level to track your recovery here.</p>
            )}
          </div>
        ) : (
          /* Race progress — shown when not on injury hold */
          race && (
            <div className="px-5 py-5 border-b border-gray-100">
              <p className="text-xs font-semibold tracking-widest text-gray-400 uppercase mb-3">Race</p>
              <p className="font-bold text-gray-900">{race.race_name}</p>
              <p className="text-sm text-gray-500 mt-0.5">
                {new Date(race.race_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                {weeksOut !== null && ` · ${weeksOut} week${weeksOut === 1 ? "" : "s"} out`}
              </p>
              {progressPct !== null && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-400">
                      Week {currentWeek} of {totalWeeks}
                      {phase ? ` · ${phase.replace(/_/g, " ")}` : ""}
                    </span>
                    <span className="text-xs text-gray-400">{progressPct}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gray-900 transition-all"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {/* This week — only shown when not on hold */}
        {!injuryHoldSince && sessions.length > 0 && (
          <div className="px-5 py-5 border-b border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold tracking-widest text-gray-400 uppercase">This Week</p>
              {weekTarget && (
                <p className="text-xs text-gray-400">
                  {weekMileageSoFar.toFixed(1)} / {weekTarget}{isMetric ? "km" : "mi"}
                </p>
              )}
            </div>
            <div className="space-y-2">
              {sessions.map((s) => {
                const isDone = activityDates.has(s.date);
                const isToday = s.date === today;
                const isPast = s.date < today;
                const activity = activities.find((a) => (a.start_date ?? "").startsWith(s.date));
                return (
                  <div
                    key={s.date}
                    className={`flex items-start gap-3 rounded-lg px-3 py-2.5 ${isToday ? "bg-gray-50 ring-1 ring-gray-200" : ""}`}
                  >
                    <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                      isDone ? "bg-green-500" : isPast ? "bg-gray-200" : "border-2 border-gray-200"
                    }`}>
                      {isDone && (
                        <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`text-xs font-medium ${isToday ? "text-gray-900" : "text-gray-500"}`}>
                          {s.day}
                          {isToday && <span className="ml-1 text-gray-400 font-normal">· today</span>}
                        </span>
                        {isDone && activity?.distance_meters && (
                          <span className="text-xs text-green-600 shrink-0">
                            {metersToDisplay(activity.distance_meters, isMetric)}
                            {activity.average_pace
                              ? ` · ${formatPace(Number(activity.average_pace), isMetric)}`
                              : ""}
                          </span>
                        )}
                      </div>
                      <p className={`text-sm mt-0.5 ${isDone ? "text-gray-400 line-through" : isToday ? "text-gray-900 font-medium" : "text-gray-600"}`}>
                        {s.label}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Strength routine */}
        {routine && exercises.length > 0 && (
          <div className="px-5 py-5">
            <div className="mb-3">
              <p className="text-xs font-semibold tracking-widest text-gray-400 uppercase mb-1">Strength</p>
              <p className="font-bold text-gray-900">{routine.label}</p>
              {scheduledStrengthDay && (
                <p className="text-sm text-gray-700 mt-0.5">Scheduled: {scheduledStrengthDay}</p>
              )}
              <p className="text-sm text-gray-500 mt-0.5">{routine.note}</p>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/strength-posters/${routine.key}.png`}
              alt={`${routine.label} exercises`}
              className="w-full rounded-xl mb-4"
            />
            <ExerciseSection
              exercises={exercises}
              routineKey={routine.key}
              token={token}
              today={today}
              initialDone={initialDone}
            />
            <p className="mt-4 text-xs text-gray-400">{routine.frequency}</p>
          </div>
        )}

        {/* Empty state */}
        {!race && !injuryHoldSince && sessions.length === 0 && !routine && (
          <div className="px-5 py-12 text-center">
            <p className="text-gray-400 text-sm">Your plan is being set up — check back after your first coaching message.</p>
          </div>
        )}

      </div>
    </div>
  );
}
