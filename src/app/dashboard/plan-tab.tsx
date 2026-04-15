/**
 * Plan tab — renders the full training plan calendar.
 * Ported from _legacy/page.tsx. Receives all data as props from the
 * parent server component (page.tsx), which fetches the extra fields.
 */

"use client";

import { useState } from "react";
import { parseKeyWorkoutMiles } from "@/lib/parse-key-workout-miles";
import { PlanImportForm } from "./plan-import-form";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlanWeek = {
  week_number: number;
  phase: string;
  mileage_target: number;
  mileage_target_min?: number; // set when plan has mileage ranges (uploaded plans)
  mileage_target_max?: number;
  long_run_target: number;
  key_workout: string;
  notes: string;
};

export type PlanSession = {
  day: string; // "Mon", "Tue", etc.
  date: string;
  label: string;
  optional?: boolean;
};

export type PlanRace = {
  id: string;
  race_name: string | null;
  race_date: string;
  priority: string;
  goal: string;
  goal_distance_miles: number | null;
};

export type PlanTabProps = {
  planWeeks: PlanWeek[];
  totalWeeks: number;
  currentWeekNum: number;
  currentPhase: string | null;
  weeklyMileageTarget: number;
  weeklyPlanSessions: PlanSession[] | null;
  planCreatedDateStr: string | null;
  trainingDays: string[] | null;
  overrideDays: string[] | null;
  isOverrideActive: boolean;
  actualMilesByWeek: Record<number, number>;
  week1Monday: string; // ISO date string (YYYY-MM-DD) — avoids Date serialization
  allRaceWeekNums: number[];
  todayDayIdx: number;
  upcomingRaces: PlanRace[];
  useMetric: boolean;
  goalLabel: string;
  raceDate: string | null;
  raceDays: number | null;
  hasPlan: boolean;
  userId: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT: Record<string, string> = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
  Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};
const DAY_SHORT_TO_FULL: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

const PHASE_COLORS: Record<string, string> = {
  base: "bg-sky-100 text-sky-700",
  build: "bg-orange-100 text-orange-700",
  peak: "bg-red-100 text-red-700",
  taper: "bg-purple-100 text-purple-700",
  deload: "bg-green-100 text-green-700",
};
const PHASE_LABELS: Record<string, string> = {
  base: "Base", build: "Build", peak: "Peak", taper: "Taper", deload: "Deload",
};
const PRIORITY_COLORS: Record<string, string> = {
  A: "bg-red-100 text-red-700",
  B: "bg-orange-100 text-orange-700",
  C: "bg-sky-100 text-sky-700",
};
const GOAL_DISTANCE_LABELS: Record<string, string> = {
  mile: "Mile", "5k": "5K", "10k": "10K", half_marathon: "Half Marathon",
  marathon: "Marathon", "30k": "30K", "50k": "50K", "50mi": "50 Miles",
  "100k": "100K", "100mi": "100 Miles", trail_race: "Trail Race",
  general_fitness: "General Fitness", return_to_running: "Return to Running",
  injury_recovery: "Injury Recovery",
};
const STANDARD_BUCKET_MILES: Record<string, number> = {
  mile: 1.0, "5k": 3.107, "10k": 6.214, half_marathon: 13.109, marathon: 26.219,
  "30k": 18.641, "50k": 31.069, "50mi": 50.0, "100k": 62.137, "100mi": 100.0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

type DayWorkout = {
  day: string;
  shortDay: string;
  type: "long" | "key" | "easy" | "rest" | "optional";
  label: string;
  miles: number | null;
};

function buildDailyPlan(week: PlanWeek, trainingDays: string[]): DayWorkout[] {
  const normalized = trainingDays.map(d => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase());
  const sorted = [...normalized].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  const longRunDay = sorted[sorted.length - 1];
  const keyWorkoutDay = sorted.length > 2 ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const easyDays = sorted.filter(d => d !== longRunDay && d !== keyWorkoutDay);

  const longRunMi = week.long_run_target;
  const isEasyKeyWorkout = /^easy/i.test(week.key_workout || "");
  const parsedKeyMi = keyWorkoutDay && week.key_workout && !isEasyKeyWorkout
    ? parseKeyWorkoutMiles(week.key_workout) : null;
  const keyWorkoutMi = keyWorkoutDay && !isEasyKeyWorkout
    ? (parsedKeyMi !== null ? parsedKeyMi : Math.round(week.mileage_target * 0.20 * 2) / 2)
    : 0;
  const totalEasy = Math.max(0, week.mileage_target - longRunMi - keyWorkoutMi);
  const easyDayCount = isEasyKeyWorkout ? sorted.length - 1 : easyDays.length;
  const easyMi = easyDayCount > 0 ? Math.round((totalEasy / easyDayCount) * 10) / 10 : 0;

  return DAY_ORDER.map(day => {
    const shortDay = DAY_SHORT[day]!;
    if (!sorted.includes(day)) return { day, shortDay, type: "rest", label: "Rest", miles: null };
    if (day === longRunDay) return { day, shortDay, type: "long", label: "Long run", miles: longRunMi };
    if (day === keyWorkoutDay) {
      if (isEasyKeyWorkout) return { day, shortDay, type: "easy", label: "Easy run", miles: easyMi };
      return { day, shortDay, type: "key", label: week.key_workout || "Key workout", miles: keyWorkoutMi };
    }
    return { day, shortDay, type: "easy", label: "Easy run", miles: easyMi };
  });
}

function buildDailyPlanFromSessions(sessions: PlanSession[]): DayWorkout[] {
  const sessionByDay = new Map(sessions.map(s => [s.day, s]));

  function classifySession(label: string): "long" | "key" | "easy" | "rest" {
    const l = label.toLowerCase();
    if (l.includes("long run")) return "long";
    if (l.startsWith("easy")) return "easy";
    if (l.includes("tempo") || l.includes("interval") || l.includes("repeat") ||
        l.includes("stride") || l.includes("threshold") || l.includes("fartlek") ||
        l.includes("vo2") || l.includes("hills")) return "key";
    return "easy";
  }

  function parseMiles(label: string): number | null {
    const miMatch = label.match(/(\d+(?:\.\d+)?)\s*mi(?!\w)/i);
    if (miMatch) return parseFloat(miMatch[1]!);
    const kmMatch = label.match(/(\d+(?:\.\d+)?)\s*km(?!\w)/i);
    if (kmMatch) return parseFloat(kmMatch[1]!) / 1.60934;
    return null;
  }

  return DAY_ORDER.map(day => {
    const shortDay = DAY_SHORT[day]!;
    const dayShort = Object.entries(DAY_SHORT_TO_FULL).find(([, v]) => v === day)?.[0];
    const session = dayShort ? sessionByDay.get(dayShort) : undefined;
    if (!session) return { day, shortDay, type: "rest", label: "Rest", miles: null };
    if (session.optional) {
      return { day, shortDay, type: "optional" as const, label: session.label, miles: parseMiles(session.label) };
    }
    return { day, shortDay, type: classifySession(session.label), label: session.label, miles: parseMiles(session.label) };
  });
}

function fmtDist(miles: number, useMetric: boolean): string {
  if (useMetric) return `${Math.round(miles * 1.60934 * 10) / 10} km`;
  return `${miles} mi`;
}

function formatRaceDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function WeekCard({
  week, isCurrent, isPast, actualMiles, weekStartDate, isRaceWeek, useMetric,
}: {
  week: PlanWeek;
  isCurrent: boolean;
  isPast: boolean;
  actualMiles: number | null;
  weekStartDate?: Date;
  isRaceWeek?: boolean;
  useMetric?: boolean;
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
    <div className={`rounded-xl border p-4 ${
      isCurrent ? "border-gray-900 bg-white" : isPast ? "border-gray-100 bg-gray-50" : "border-gray-200 bg-white"
    }`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className={`text-sm font-semibold shrink-0 ${isPast ? "text-gray-400" : "text-gray-700"}`}>
            Week {week.week_number}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${PHASE_COLORS[week.phase] ?? "bg-gray-100 text-gray-700"}`}>
            {PHASE_LABELS[week.phase] ?? week.phase}
          </span>
          {isCurrent && <span className="rounded-full bg-gray-900 px-2 py-0.5 text-xs font-medium text-white shrink-0">Now</span>}
          {isRaceWeek && <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white shrink-0">Race day</span>}
          {completed && <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 shrink-0">✓ Done</span>}
          {attempted && <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700 shrink-0">Partial</span>}
          {missed && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-400 shrink-0">—</span>}
        </div>
        <div className="text-right shrink-0">
          {isPast && actualMiles !== null && actualMiles > 0 ? (
            <div className="flex items-baseline gap-1">
              <span className={`text-sm font-semibold ${completed ? "text-green-700" : "text-yellow-700"}`}>
                {fmtDist(Math.round(actualMiles * 10) / 10, !!useMetric)}
              </span>
              <span className="text-xs text-gray-400">
                / {week.mileage_target_min != null && week.mileage_target_max != null
                  ? `${fmtDist(week.mileage_target_min, !!useMetric)}–${fmtDist(week.mileage_target_max, !!useMetric)}`
                  : fmtDist(week.mileage_target, !!useMetric)}
              </span>
            </div>
          ) : (
            <span className={`text-sm font-semibold ${isPast ? "text-gray-400" : "text-gray-900"}`}>
              {week.mileage_target_min != null && week.mileage_target_max != null
                ? `${fmtDist(week.mileage_target_min, !!useMetric)}–${fmtDist(week.mileage_target_max, !!useMetric)}`
                : fmtDist(week.mileage_target, !!useMetric)}
            </span>
          )}
        </div>
      </div>
      {dateRange && (
        <p className={`mt-1 text-xs ${isPast ? "text-gray-300" : "text-gray-400"}`}>{dateRange}</p>
      )}
      {week.key_workout && (
        <p className={`mt-2 text-xs leading-snug ${isPast ? "text-gray-400" : "text-gray-500"}`}>
          {week.key_workout}
        </p>
      )}
    </div>
  );
}

function UpcomingRacesList({ races, useMetric }: { races: PlanRace[]; useMetric: boolean }) {
  const showPriority = races.length > 1;
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Upcoming Races</h2>
      <div className="space-y-2">
        {races.map(race => {
          const days = (() => {
            const r = new Date(race.race_date + "T12:00:00Z");
            const d = Math.ceil((r.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
            return d > 0 ? d : null;
          })();
          const isNonStd = race.goal_distance_miles != null
            && Math.abs(race.goal_distance_miles - (STANDARD_BUCKET_MILES[race.goal] ?? -1)) > 0.5;
          const distLabel = isNonStd
            ? fmtDist(race.goal_distance_miles!, useMetric)
            : GOAL_DISTANCE_LABELS[race.goal] ?? race.goal.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
          return (
            <div key={race.id} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {showPriority && (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold shrink-0 ${PRIORITY_COLORS[race.priority] ?? "bg-gray-100 text-gray-600"}`}>
                    {race.priority}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{race.race_name ?? distLabel}</p>
                  <p className="text-xs text-gray-400">
                    {formatRaceDate(race.race_date)}{race.race_name ? ` · ${distLabel}` : ""}
                  </p>
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

// ─── Main export ──────────────────────────────────────────────────────────────

export function PlanTab({
  planWeeks, totalWeeks, currentWeekNum, currentPhase, weeklyMileageTarget,
  weeklyPlanSessions, planCreatedDateStr, trainingDays, overrideDays,
  isOverrideActive, actualMilesByWeek, week1Monday: week1MondayStr,
  allRaceWeekNums, todayDayIdx, upcomingRaces, useMetric, goalLabel,
  raceDate, raceDays, hasPlan, userId,
}: PlanTabProps) {
  const distUnit = useMetric ? "km" : "mi";
  const week1Monday = new Date(week1MondayStr + "T00:00:00Z");

  if (!hasPlan) {
    return (
      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-gray-700">No training plan yet</p>
        <p className="mt-1 text-xs text-gray-400">
          Text Dean to get a personalized plan, or import your current plan below.
        </p>
        <PlanImportForm userId={userId} />
      </div>
    );
  }

  const allRaceWeekSet = new Set(allRaceWeekNums);
  const currentWeek = planWeeks.find(w => w.week_number === currentWeekNum) ?? planWeeks[0];
  const effectiveTrainingDays = isOverrideActive ? overrideDays : trainingDays;

  const visiblePlanSessions = weeklyPlanSessions && planCreatedDateStr
    ? weeklyPlanSessions.filter(s => s.date >= planCreatedDateStr)
    : weeklyPlanSessions ?? null;

  const dailyPlan = visiblePlanSessions && visiblePlanSessions.length > 0
    ? buildDailyPlanFromSessions(visiblePlanSessions)
    : (currentWeek && effectiveTrainingDays && effectiveTrainingDays.length > 0
      ? buildDailyPlan(currentWeek, effectiveTrainingDays)
      : null);

  const currentWeekActualMiles = actualMilesByWeek[currentWeekNum] ?? null;

  return (
    <div className="space-y-4">
      {/* Hero: goal + race countdown */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
        {goalLabel && (
          <p className="text-lg font-bold text-gray-900 leading-snug">{goalLabel}</p>
        )}
        {raceDate && (
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Race day</p>
              <p className="text-sm font-medium text-gray-700">{formatRaceDate(raceDate)}</p>
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

      {/* Upcoming races (when there are multiple) */}
      {upcomingRaces.length > 1 && (
        <UpcomingRacesList races={upcomingRaces} useMetric={useMetric} />
      )}

      {/* Current week detail */}
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
              {currentWeek.mileage_target_min != null && currentWeek.mileage_target_max != null ? (
                <p className="text-2xl font-bold text-gray-900">
                  {fmtDist(currentWeek.mileage_target_min, useMetric)}
                  <span className="text-lg font-normal text-gray-400">–</span>
                  {fmtDist(currentWeek.mileage_target_max, useMetric)}
                </p>
              ) : (
                <p className="text-2xl font-bold text-gray-900">
                  {useMetric ? Math.round(weeklyMileageTarget * 1.60934 * 10) / 10 : weeklyMileageTarget}
                  {" "}<span className="text-sm font-normal text-gray-500">{distUnit}</span>
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Long run</p>
              <p className="text-2xl font-bold text-gray-900">
                {useMetric ? Math.round(currentWeek.long_run_target * 1.60934 * 10) / 10 : currentWeek.long_run_target}
                {" "}<span className="text-sm font-normal text-gray-500">{distUnit}</span>
              </p>
            </div>
          </div>
          {/* Miles logged this week */}
          {currentWeekActualMiles !== null && currentWeekActualMiles > 0 && weeklyMileageTarget > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-400">Done this week</span>
                <span className="text-xs font-semibold text-gray-700">
                  {fmtDist(Math.round(currentWeekActualMiles * 10) / 10, useMetric)} / {fmtDist(weeklyMileageTarget, useMetric)}
                </span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-1.5">
                <div
                  className={`h-1.5 rounded-full ${currentWeekActualMiles >= weeklyMileageTarget ? "bg-green-500" : "bg-gray-900"}`}
                  style={{ width: `${Math.min(100, (currentWeekActualMiles / weeklyMileageTarget) * 100)}%` }}
                />
              </div>
            </div>
          )}
          {/* Daily breakdown */}
          {dailyPlan ? (
            <div className="divide-y divide-gray-100 rounded-xl border border-gray-100 overflow-hidden">
              {dailyPlan.map(d => {
                const dayIdx = DAY_ORDER.indexOf(d.day);
                const isPastDay = dayIdx < todayDayIdx;
                const isOptional = d.type === "optional";
                const isDimmed = d.type === "rest" || isPastDay;
                const rowBg = isDimmed || isOptional ? "bg-gray-50" : "bg-white";
                const dayColor = isDimmed ? "text-gray-300" : isOptional ? "text-gray-400" : "text-gray-500";
                const labelColor = isDimmed ? "text-gray-300" : isOptional ? "text-gray-400 italic" : "text-gray-600";
                const valueColor = isDimmed ? "text-gray-300" : isOptional ? "text-gray-400" : d.type === "key" ? "font-semibold text-gray-900" : "text-gray-500";
                return (
                  <div key={d.day} className={`flex items-center justify-between px-3 py-2 ${rowBg}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-xs font-semibold w-7 shrink-0 ${dayColor}`}>{d.shortDay}</span>
                      <span className={`text-sm leading-snug ${labelColor}`}>{d.label}</span>
                    </div>
                    {d.miles !== null && (
                      <span className={`text-sm shrink-0 ml-2 ${valueColor}`}>
                        {fmtDist(d.miles, useMetric)}
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
            <div className="border-t border-gray-100 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1">Coach&apos;s Note</p>
              <p className="text-sm text-gray-600 leading-relaxed">{currentWeek.notes}</p>
            </div>
          )}
        </div>
      )}

      {/* Full training arc */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Full Training Arc</h2>
        <div className="space-y-2">
          {planWeeks.map(week => {
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
                isRaceWeek={allRaceWeekSet.has(week.week_number)}
                useMetric={useMetric}
              />
            );
          })}
        </div>
      </div>

      <ReplacePlanSection userId={userId} />
    </div>
  );
}

function ReplacePlanSection({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pb-4">
      {open ? (
        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-gray-600">Replace plan</p>
            <button onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
          <PlanImportForm userId={userId} />
        </div>
      ) : (
        <p className="text-center text-xs text-gray-400">
          Text Dean anytime to discuss your plan.{" "}
          <button onClick={() => setOpen(true)} className="underline underline-offset-2 hover:text-gray-600">
            Replace plan
          </button>
        </p>
      )}
    </div>
  );
}
