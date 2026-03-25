import { supabase } from "@/lib/supabase";
import RequestLinkForm from "./request-link-form";

type PlanWeek = {
  week_number: number;
  phase: string;
  mileage_target: number;
  long_run_target: number;
  key_workout: string;
  notes: string;
};

const PHASE_LABELS: Record<string, string> = {
  base: "Base",
  build: "Build",
  peak: "Peak",
  taper: "Taper",
};

const PHASE_COLORS: Record<string, string> = {
  base: "bg-sky-100 text-sky-700",
  build: "bg-orange-100 text-orange-700",
  peak: "bg-red-100 text-red-700",
  taper: "bg-purple-100 text-purple-700",
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

function isTrialActive(trialStartedAt: string | null): boolean {
  if (!trialStartedAt) return false;
  const started = new Date(trialStartedAt);
  const daysSinceStart = (Date.now() - started.getTime()) / (24 * 60 * 60 * 1000);
  return daysSinceStart <= 7;
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
    .select("id, name, trial_started_at, onboarding_data")
    .eq("dashboard_token", token)
    .single();

  if (!user) {
    return <NoTokenScreen expired />;
  }

  // Fetch training plan and current state in parallel
  const [{ data: planData }, { data: stateData }, { data: profileData }] = await Promise.all([
    supabase
      .from("training_plans")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single(),
    supabase
      .from("training_state")
      .select("current_week, current_phase, weekly_mileage_target")
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("training_profiles")
      .select("goal, race_date, goal_distance_miles")
      .eq("user_id", user.id)
      .single(),
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
  const raceDate = profileData?.race_date ?? planData.race_date;

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
  // For named races: show the actual distance (e.g. "7.4 mi") if it was explicitly parsed,
  // otherwise fall back to the standard bucket label (e.g. "Marathon" for Boston).
  const distanceSuffix = raceName
    ? (specificDistanceMiles ? `${specificDistanceMiles} mi` : standardLabel)
    : standardLabel;
  const goalLabel = raceName
    ? `${raceName}${distanceSuffix ? ` · ${distanceSuffix}` : ""}`
    : standardLabel
    ?? (specificDistanceMiles ? `${specificDistanceMiles} mi race` : goalBucket);
  const raceDays = daysUntilRace(raceDate as string | null);
  const trialActive = isTrialActive(user.trial_started_at as string | null);
  const currentWeek = planWeeks.find(w => w.week_number === currentWeekNum) ?? planWeeks[0];

  return (
    <div className="min-h-screen bg-gray-50">
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
        {/* Hero: goal + meta */}
        <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          {goalLabel && (
            <p className="text-base font-semibold text-gray-900 leading-snug">{goalLabel}</p>
          )}
          <div className="flex flex-wrap gap-3 text-sm text-gray-500">
            {raceDate && (
              <span>Race: {formatRaceDate(raceDate as string)}</span>
            )}
            {raceDays && (
              <span className="font-medium text-gray-700">{raceDays} days to go</span>
            )}
          </div>
          <div className="pt-1">
            <span className="text-sm font-medium text-gray-800">
              Week {currentWeekNum} of {totalWeeks}
            </span>
            {currentWeek && (
              <span className={`ml-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${PHASE_COLORS[currentWeek.phase] ?? "bg-gray-100 text-gray-700"}`}>
                {PHASE_LABELS[currentWeek.phase] ?? currentWeek.phase} Phase
              </span>
            )}
          </div>
        </div>

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
                <p className="text-2xl font-bold text-gray-900">{currentWeek.mileage_target} <span className="text-sm font-normal text-gray-500">mi</span></p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-0.5">Long run</p>
                <p className="text-2xl font-bold text-gray-900">{currentWeek.long_run_target} <span className="text-sm font-normal text-gray-500">mi</span></p>
              </div>
            </div>
            {currentWeek.key_workout && (
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-1">Key workout</p>
                <p className="text-sm text-gray-800 font-medium">{currentWeek.key_workout}</p>
              </div>
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
              // Blur logic: trial active → all visible; expired → only show past + current + 1 next
              const isVisible = trialActive || isPast || isCurrent || week.week_number === currentWeekNum + 1;

              if (!isVisible) {
                // Show blurred paywall card once, then a CTA
                if (week.week_number === currentWeekNum + 2) {
                  return <PaywallCTA key="paywall" remainingWeeks={totalWeeks - currentWeekNum - 1} />;
                }
                return null;
              }

              return (
                <WeekCard
                  key={week.week_number}
                  week={week}
                  isCurrent={isCurrent}
                  isPast={isPast}
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

function WeekCard({ week, isCurrent, isPast }: { week: PlanWeek; isCurrent: boolean; isPast: boolean }) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        isCurrent
          ? "border-gray-900 bg-white"
          : isPast
          ? "border-gray-100 bg-gray-50 opacity-60"
          : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-gray-700 shrink-0">Week {week.week_number}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${PHASE_COLORS[week.phase] ?? "bg-gray-100 text-gray-700"}`}>
            {PHASE_LABELS[week.phase] ?? week.phase}
          </span>
          {isCurrent && (
            <span className="rounded-full bg-gray-900 px-2 py-0.5 text-xs font-medium text-white shrink-0">Now</span>
          )}
        </div>
        <span className="text-sm font-semibold text-gray-900 shrink-0">{week.mileage_target} mi</span>
      </div>
      {week.key_workout && (
        <p className="mt-2 text-xs text-gray-500 leading-snug">{week.key_workout}</p>
      )}
    </div>
  );
}

function PaywallCTA({ remainingWeeks }: { remainingWeeks: number }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white p-5 text-center">
      <p className="text-sm font-semibold text-gray-800 mb-1">
        {remainingWeeks} more {remainingWeeks === 1 ? "week" : "weeks"} in your plan
      </p>
      <p className="text-xs text-gray-500 mb-4">
        Your free preview has ended. Unlock your full training arc to see the complete build, peak, and taper.
      </p>
      <a
        href="https://coachdean.ai/#pricing"
        className="inline-block rounded-full bg-gray-900 px-5 py-2 text-sm font-medium text-white"
      >
        Unlock full plan
      </a>
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
        <RequestLinkForm />
      </div>
    </div>
  );
}
