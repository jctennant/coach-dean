import type { Metadata } from "next";
import { supabase } from "@/lib/supabase";
import RequestLinkForm from "./request-link-form";
import { TokenPersist, LocalTokenRedirect } from "./token-manager";

export const metadata: Metadata = {
  title: "Your Training Plan — Coach Dean",
  description: "View your personalized running training plan from Coach Dean.",
  openGraph: {
    title: "Your Training Plan — Coach Dean",
    description: "View your personalized running training plan from Coach Dean.",
    url: "https://coachdean.ai/dashboard",
    siteName: "Coach Dean",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Coach Dean" }],
  },
};

type PlanWeek = {
  week_number: number;
  phase: string;
  mileage_target: number;
  long_run_target: number;
  key_workout: string;
  notes: string;
};

type Race = {
  id: string;
  race_name: string | null;
  race_date: string;
  priority: string;
  goal: string;
  goal_distance_miles: number | null;
};

type DayWorkout = {
  day: string;
  shortDay: string;
  type: "long" | "key" | "easy" | "rest";
  label: string;
  miles: number | null;
};

type PlanSession = {
  day: string; // "Mon", "Tue", etc.
  date: string;
  label: string;
};

const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT: Record<string, string> = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
  Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};

function buildDailyPlan(week: PlanWeek, trainingDays: string[]): DayWorkout[] {
  // Normalize to title case — DB stores lowercase ("tuesday"), DAY_ORDER uses title case ("Tuesday")
  const normalized = trainingDays.map(d => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase());
  const sorted = [...normalized].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  const longRunDay = sorted[sorted.length - 1];
  const keyWorkoutDay = sorted.length > 2 ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const easyDays = sorted.filter(d => d !== longRunDay && d !== keyWorkoutDay);

  const longRunMi = week.long_run_target;
  // Parse miles from key_workout text. Handles:
  //   "4mi tempo" → 4
  //   "4x800m" → 4 × 0.5mi = 2mi
  //   "6x1mi repeats" → 6mi
  //   "5x1000m" → 5 × 0.621mi ≈ 3.1mi
  function parseKeyWorkoutMiles(text: string): number | null {
    const direct = text.match(/^(\d+(?:\.\d+)?)\s*mi/i);
    if (direct) return parseFloat(direct[1]!);
    const interval = text.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(m|km|mi)/i);
    if (interval) {
      const reps = parseInt(interval[1]!);
      const dist = parseFloat(interval[2]!);
      const unit = interval[3]!.toLowerCase();
      const distMi = unit === "mi" ? dist : unit === "km" ? dist * 0.621371 : dist / 1609.34;
      return Math.round(reps * distMi * 10) / 10;
    }
    return null;
  }
  const parsedKeyMi = keyWorkoutDay && week.key_workout ? parseKeyWorkoutMiles(week.key_workout) : null;
  const keyWorkoutMi = keyWorkoutDay
    ? (parsedKeyMi !== null ? parsedKeyMi : Math.round(week.mileage_target * 0.20 * 2) / 2)
    : 0;
  const totalEasy = Math.max(0, week.mileage_target - longRunMi - keyWorkoutMi);
  const easyMi = easyDays.length > 0 ? Math.round((totalEasy / easyDays.length) * 10) / 10 : 0;

  return DAY_ORDER.map(day => {
    const shortDay = DAY_SHORT[day]!;
    if (!sorted.includes(day)) return { day, shortDay, type: "rest", label: "Rest", miles: null };
    if (day === longRunDay) return { day, shortDay, type: "long", label: "Long run", miles: longRunMi };
    if (day === keyWorkoutDay) return { day, shortDay, type: "key", label: week.key_workout || "Key workout", miles: keyWorkoutMi };
    return { day, shortDay, type: "easy", label: "Easy run", miles: easyMi };
  });
}

const DAY_SHORT_TO_FULL: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

function buildDailyPlanFromSessions(sessions: PlanSession[]): DayWorkout[] {
  const sessionByDay = new Map(sessions.map(s => [s.day, s]));

  function classifySession(label: string): "long" | "key" | "easy" | "rest" {
    const l = label.toLowerCase();
    if (l.includes("long run")) return "long";
    if (l.includes("tempo") || l.includes("interval") || l.includes("repeat") ||
        l.includes("stride") || l.includes("threshold") || l.includes("fartlek") ||
        l.includes("vo2") || l.includes("hills")) return "key";
    return "easy";
  }

  function parseMiles(label: string): number | null {
    const m = label.match(/(\d+(?:\.\d+)?)\s*mi(?!\w)/i);
    return m ? parseFloat(m[1]!) : null;
  }

  return DAY_ORDER.map(day => {
    const shortDay = DAY_SHORT[day]!;
    const dayShort = Object.entries(DAY_SHORT_TO_FULL).find(([, v]) => v === day)?.[0];
    const session = dayShort ? sessionByDay.get(dayShort) : undefined;
    if (!session) return { day, shortDay, type: "rest", label: "Rest", miles: null };
    return {
      day,
      shortDay,
      type: classifySession(session.label),
      label: session.label,
      miles: parseMiles(session.label),
    };
  });
}

const PRIORITY_COLORS: Record<string, string> = {
  A: "bg-red-100 text-red-700",
  B: "bg-orange-100 text-orange-700",
  C: "bg-sky-100 text-sky-700",
};

const PHASE_LABELS: Record<string, string> = {
  base: "Base",
  build: "Build",
  peak: "Peak",
  taper: "Taper",
  deload: "Deload",
};

const PHASE_COLORS: Record<string, string> = {
  base: "bg-sky-100 text-sky-700",
  build: "bg-orange-100 text-orange-700",
  peak: "bg-red-100 text-red-700",
  taper: "bg-purple-100 text-purple-700",
  deload: "bg-green-100 text-green-700",
};

function formatRaceDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function daysUntilRace(raceDateStr: string | null): number | null {
  if (!raceDateStr) return null;
  const race = new Date(raceDateStr + "T12:00:00Z");
  const now = new Date();
  const days = Math.ceil((race.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  return days > 0 ? days : null;
}


export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return <NoTokenScreen />;
  }

  // Look up user by dashboard token
  const { data: user } = await supabase
    .from("users")
    .select("id, name, onboarding_data")
    .eq("dashboard_token", token)
    .single();

  if (!user) {
    return <NoTokenScreen expired />;
  }

  // Fetch training plan, current state, activities, and races in parallel
  const [{ data: planData }, { data: stateData }, { data: profileData }, { data: activities }, { data: racesData }] = await Promise.all([
    supabase
      .from("training_plans")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single(),
    supabase
      .from("training_state")
      .select("current_week, current_phase, weekly_mileage_target, weekly_plan_sessions")
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("training_profiles")
      .select("goal, race_date, goal_distance_miles, training_days")
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("activities")
      .select("start_date, distance_meters, activity_type")
      .eq("user_id", user.id)
      .order("start_date", { ascending: true }),
    supabase
      .from("races")
      .select("id, race_name, race_date, priority, goal, goal_distance_miles")
      .eq("user_id", user.id)
      .gte("race_date", new Date().toISOString().split("T")[0]!)
      .order("race_date", { ascending: true }),
  ]);

  if (!planData) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 py-12">
        <div className="max-w-sm text-center">
          <p className="text-lg font-semibold">Plan not ready yet</p>
          <p className="mt-2 text-sm text-gray-500">
            Your training plan is being generated. Check back in a few minutes or reply to Dean&apos;s last text.
          </p>
        </div>
      </div>
    );
  }

  const planWeeks = (planData.weeks as PlanWeek[] | null) ?? [];
  const totalWeeks = planData.total_weeks ?? planWeeks.length;
  const currentWeekNum = (stateData?.current_week as number | null) ?? 1;
  const currentWeek = planWeeks.find(w => w.week_number === currentWeekNum) ?? planWeeks[0];
  const trainingDays = (profileData?.training_days as string[] | null) ?? null;
  const upcomingRaces = (racesData ?? []) as Race[];
  const weeklyPlanSessions = (stateData?.weekly_plan_sessions as PlanSession[] | null) ?? null;
  const dailyPlan = weeklyPlanSessions && weeklyPlanSessions.length > 0
    ? buildDailyPlanFromSessions(weeklyPlanSessions)
    : (currentWeek && trainingDays && trainingDays.length > 0
      ? buildDailyPlan(currentWeek, trainingDays)
      : null);

  // Partial-week logic — must run before week1Monday is used so date anchors are correct.
  // If the user onboarded mid-week with no remaining workouts (e.g. Saturday, no Sunday run),
  // shift week 1 forward to start on Monday. Everything downstream (date labels, activity
  // bucketing, race week badge) uses the adjusted anchor automatically.
  const todayDayName = new Date().toLocaleDateString("en-US", { weekday: "long" });
  const todayDayIdx = DAY_ORDER.indexOf(todayDayName);
  const remainingWorkoutsThisWeek = dailyPlan
    ? dailyPlan.filter(d => DAY_ORDER.indexOf(d.day) >= todayDayIdx && d.type !== "rest")
    : null;
  const noRemainingWorkouts = remainingWorkoutsThisWeek !== null && remainingWorkoutsThisWeek.length === 0;

  // Week 1 anchor: Monday of the plan-creation week, shifted forward 7 days when no workouts remain.
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  const planCreatedAt = new Date(planData.created_at as string);
  const dayOfWeek = planCreatedAt.getUTCDay(); // 0=Sun, 1=Mon...
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const week1Monday = new Date(planCreatedAt);
  week1Monday.setUTCDate(week1Monday.getUTCDate() + daysToMonday + (noRemainingWorkouts ? 7 : 0));
  week1Monday.setUTCHours(0, 0, 0, 0);

  const actualMilesByWeek: Record<number, number> = {};
  for (const activity of activities ?? []) {
    if (!RUN_TYPES.has(activity.activity_type as string)) continue;
    const actMs = new Date(activity.start_date as string).getTime();
    const weekNum = Math.floor((actMs - week1Monday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
    if (weekNum >= 1 && weekNum <= totalWeeks) {
      actualMilesByWeek[weekNum] = (actualMilesByWeek[weekNum] ?? 0) + (activity.distance_meters as number) / 1609.34;
    }
  }
  const raceDate = profileData?.race_date ?? planData.race_date;

  // Which plan week does the race fall in (for "Race day" badge)?
  const raceWeekNum = (raceDate as string | null)
    ? Math.floor((new Date((raceDate as string) + "T12:00:00Z").getTime() - week1Monday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1
    : null;

  // Build a human-readable goal label: prefer specific race name over generic bucket
  const onboardingData = (user.onboarding_data as Record<string, unknown> | null) ?? {};
  const raceName = (onboardingData.race_name as string | null) ?? null;
  // onboarding_data.goal_distance_miles is only set when the parser extracted a non-standard
  // distance (e.g. 7.4 mi for Dipsea). training_profiles.goal_distance_miles is backfilled
  // with the standard bucket distance (e.g. 6.214 for 10k) — don't use that for display.
  const specificDistanceMiles = (onboardingData.goal_distance_miles as number | null) ?? null;
  const goalBucket = profileData?.goal ?? planData.goal;
  const GOAL_LABELS: Record<string, string> = {
    mile: "Mile", "5k": "5K", "10k": "10K", half_marathon: "Half Marathon",
    marathon: "Marathon", "30k": "30K", "50k": "50K", "50mi": "50 Miles",
    "100k": "100K", "100mi": "100 Miles", general_fitness: "General Fitness",
    return_to_running: "Return to Running", injury_recovery: "Injury Recovery",
  };
  const standardLabel = GOAL_LABELS[goalBucket as string] ?? null;
  // For named races: show the actual distance (e.g. "7.4 mi") if it was explicitly parsed.
  // Do NOT fall back to the standard bucket label for named races — the bucket may be stale
  // from a previously-named race (e.g. "10K" from Dipsea showing on Sierre Zinal).
  // For unnamed goals, show the standard bucket label as usual.
  const distanceSuffix = raceName
    ? (specificDistanceMiles ? `${specificDistanceMiles} mi` : null)
    : standardLabel;
  const goalLabel = raceName
    ? `${raceName}${distanceSuffix ? ` · ${distanceSuffix}` : ""}`
    : standardLabel
    ?? (specificDistanceMiles ? `${specificDistanceMiles} mi race` : goalBucket);
  const raceDays = daysUntilRace(raceDate as string | null);
  const currentWeekActualMiles = actualMilesByWeek[currentWeekNum] ?? null;

  const displayMileageTarget = currentWeek?.mileage_target ?? 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <TokenPersist token={token} />
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-4">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <a href="/">
            <img src="/heavy_logo.svg" alt="Coach Dean" style={{ height: 32 }} />
          </a>
          <span className="text-xs text-gray-400">Your Training Plan</span>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {/* Hero: goal + race countdown + week progress */}
        <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
          {/* Race name */}
          {goalLabel && (
            <p className="text-lg font-bold text-gray-900 leading-snug">{goalLabel}</p>
          )}

          {/* Race date + countdown */}
          {raceDate && (
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Race day</p>
                <p className="text-sm font-medium text-gray-700">{formatRaceDate(raceDate as string)}</p>
              </div>
              {raceDays && (
                <div className="text-right">
                  <p className="text-3xl font-bold text-gray-900 leading-none">{raceDays}</p>
                  <p className="text-xs text-gray-400 mt-0.5">days to go</p>
                </div>
              )}
            </div>
          )}

          {/* Week progress bar */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-semibold text-gray-800">
                Week {currentWeekNum} of {totalWeeks}
              </span>
              {currentWeek && (
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PHASE_COLORS[currentWeek.phase] ?? "bg-gray-100 text-gray-700"}`}>
                  {PHASE_LABELS[currentWeek.phase] ?? currentWeek.phase} Phase
                </span>
              )}
            </div>
            <div className="w-full bg-gray-100 rounded-full h-1.5">
              <div
                className="bg-gray-900 h-1.5 rounded-full"
                style={{ width: `${Math.min(100, (currentWeekNum / totalWeeks) * 100)}%` }}
              />
            </div>
          </div>
        </div>

        {/* Upcoming races — only show when there are multiple races (B/C alongside A).
            A single race is already represented by the header countdown, so the section
            would just be redundant. */}
        {upcomingRaces.length > 1 && (
          <UpcomingRaces races={upcomingRaces} />
        )}

        {/* Current week card */}
        {currentWeek && (
          <div className="bg-white rounded-2xl border-2 border-gray-900 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">This Week</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PHASE_COLORS[currentWeek.phase] ?? "bg-gray-100 text-gray-700"}`}>
                {PHASE_LABELS[currentWeek.phase] ?? currentWeek.phase}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-gray-400 mb-0.5">Weekly target</p>
                <p className="text-2xl font-bold text-gray-900">
                  {displayMileageTarget}
                  {" "}<span className="text-sm font-normal text-gray-500">mi</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-0.5">Long run</p>
                <p className="text-2xl font-bold text-gray-900">{currentWeek.long_run_target} <span className="text-sm font-normal text-gray-500">mi</span></p>
              </div>
            </div>
            {/* Progress bar for miles logged this week */}
            {currentWeekActualMiles !== null && currentWeekActualMiles > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-400">Done this week</span>
                  <span className="text-xs font-semibold text-gray-700">
                    {Math.round(currentWeekActualMiles * 10) / 10} / {displayMileageTarget} mi
                  </span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-1.5">
                  <div
                    className={`h-1.5 rounded-full ${currentWeekActualMiles >= displayMileageTarget ? "bg-green-500" : "bg-gray-900"}`}
                    style={{ width: `${Math.min(100, (currentWeekActualMiles / displayMileageTarget) * 100)}%` }}
                  />
                </div>
              </div>
            )}
            {dailyPlan ? (
              <div className="divide-y divide-gray-100 rounded-xl border border-gray-100 overflow-hidden">
                {dailyPlan.map(d => {
                  const dayIdx = DAY_ORDER.indexOf(d.day);
                  const isPastDay = dayIdx < todayDayIdx;
                  const isDimmed = d.type === "rest" || isPastDay;
                  return (
                    <div key={d.day} className={`flex items-center justify-between px-3 py-2 ${isDimmed ? "bg-gray-50" : "bg-white"}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-xs font-semibold w-7 shrink-0 ${isDimmed ? "text-gray-300" : "text-gray-500"}`}>{d.shortDay}</span>
                        <span className={`text-sm leading-snug ${isDimmed ? "text-gray-300" : "text-gray-600"}`}>
                          {d.label}
                        </span>
                      </div>
                      {d.miles !== null && (
                        <span className={`text-sm shrink-0 ml-2 ${isDimmed ? "text-gray-300" : d.type === "key" ? "font-semibold text-gray-900" : "text-gray-500"}`}>
                          {d.miles} mi
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              currentWeek.key_workout && (
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 mb-1">Key workout</p>
                  <p className="text-sm text-gray-800 font-medium">{currentWeek.key_workout}</p>
                </div>
              )
            )}
            {currentWeek.notes && (
              <p className="text-xs text-gray-500 italic">{currentWeek.notes}</p>
            )}
          </div>
        )}

        {/* Plan arc */}
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Full Training Arc</h2>
          <div className="space-y-2">
            {planWeeks.map((week) => {
              const isCurrent = week.week_number === currentWeekNum;
              const isPast = week.week_number < currentWeekNum;

              const weekStart = new Date(week1Monday);
              weekStart.setUTCDate(week1Monday.getUTCDate() + (week.week_number - 1) * 7);
              return (
                <WeekCard
                  key={week.week_number}
                  week={week}
                  isCurrent={isCurrent}
                  isPast={isPast}
                  actualMiles={actualMilesByWeek[week.week_number] ?? null}
                  weekStartDate={weekStart}
                  isRaceWeek={raceWeekNum === week.week_number}
                />
              );
            })}
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 pb-6">
          Text Dean anytime to discuss your plan.
        </p>
      </div>
    </div>
  );
}

const GOAL_DISTANCE_LABELS: Record<string, string> = {
  mile: "Mile", "5k": "5K", "10k": "10K", half_marathon: "Half Marathon",
  marathon: "Marathon", "30k": "30K", "50k": "50K", "50mi": "50 Miles",
  "100k": "100K", "100mi": "100 Miles",
};

function UpcomingRaces({ races }: { races: Race[] }) {
  const showPriority = races.length > 1;
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Upcoming Races</h2>
      <div className="space-y-2">
        {races.map(race => {
          const days = daysUntilRace(race.race_date);
          const distanceLabel = race.goal_distance_miles
            ? GOAL_DISTANCE_LABELS[race.goal] ?? `${race.goal_distance_miles} mi`
            : GOAL_DISTANCE_LABELS[race.goal] ?? race.goal;
          return (
            <div key={race.id} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {showPriority && (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold shrink-0 ${PRIORITY_COLORS[race.priority] ?? "bg-gray-100 text-gray-600"}`}>
                    {race.priority}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{race.race_name ?? distanceLabel}</p>
                  <p className="text-xs text-gray-400">{formatRaceDate(race.race_date)}{race.race_name ? ` · ${distanceLabel}` : ""}</p>
                </div>
              </div>
              {days && (
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-gray-700 leading-none">{days}</p>
                  <p className="text-xs text-gray-400">days</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekCard({ week, isCurrent, isPast, actualMiles, weekStartDate, isRaceWeek }: {
  week: PlanWeek;
  isCurrent: boolean;
  isPast: boolean;
  actualMiles: number | null;
  weekStartDate?: Date;
  isRaceWeek?: boolean;
}) {
  const completed = isPast && actualMiles !== null && actualMiles >= week.mileage_target * 0.8;
  const attempted = isPast && actualMiles !== null && actualMiles > 0 && !completed;
  const missed = isPast && (actualMiles === null || actualMiles === 0);

  const weekEnd = weekStartDate ? new Date(weekStartDate) : null;
  if (weekEnd) weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const dateRange = weekStartDate && weekEnd
    ? `${weekStartDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} – ${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`
    : null;

  return (
    <div
      className={`rounded-xl border p-4 ${
        isCurrent
          ? "border-gray-900 bg-white"
          : isPast
          ? "border-gray-100 bg-gray-50"
          : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className={`text-sm font-semibold shrink-0 ${isPast ? "text-gray-400" : "text-gray-700"}`}>Week {week.week_number}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${PHASE_COLORS[week.phase] ?? "bg-gray-100 text-gray-700"}`}>
            {PHASE_LABELS[week.phase] ?? week.phase}
          </span>
          {isCurrent && (
            <span className="rounded-full bg-gray-900 px-2 py-0.5 text-xs font-medium text-white shrink-0">Now</span>
          )}
          {isRaceWeek && (
            <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white shrink-0">Race day</span>
          )}
          {completed && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 shrink-0">✓ Done</span>
          )}
          {attempted && (
            <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700 shrink-0">Partial</span>
          )}
          {missed && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-400 shrink-0">—</span>
          )}
        </div>
        <div className="text-right shrink-0">
          {isPast && actualMiles !== null && actualMiles > 0 ? (
            <div className="flex items-baseline gap-1">
              <span className={`text-sm font-semibold ${completed ? "text-green-700" : "text-yellow-700"}`}>{Math.round(actualMiles * 10) / 10}</span>
              <span className="text-xs text-gray-400">/ {week.mileage_target} mi</span>
            </div>
          ) : (
            <span className={`text-sm font-semibold ${isPast ? "text-gray-400" : "text-gray-900"}`}>{week.mileage_target} mi</span>
          )}
        </div>
      </div>
      {dateRange && (
        <p className={`mt-1 text-xs ${isPast ? "text-gray-300" : "text-gray-400"}`}>{dateRange}</p>
      )}
      {week.key_workout && (
        <p className={`mt-2 text-xs leading-snug ${isPast ? "text-gray-400" : "text-gray-500"}`}>{week.key_workout}</p>
      )}
    </div>
  );
}


function NoTokenScreen({ expired = false }: { expired?: boolean }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <p className="text-lg font-semibold text-gray-900">
            {expired ? "Link expired or not found" : "Get your training plan"}
          </p>
          <p className="text-sm text-gray-500">
            Enter your phone number and we&apos;ll text you a fresh link to your plan.
          </p>
        </div>
        {expired ? <RequestLinkForm /> : <LocalTokenRedirect />}
      </div>
    </div>
  );
}
