/**
 * Plan tab — renders the full training plan calendar.
 * Ported from _legacy/page.tsx. Receives all data as props from the
 * parent server component (page.tsx), which fetches the extra fields.
 */

"use client";

import { useState } from "react";
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

const ARC_PHASE_FILL_FUTURE: Record<string, string> = {
  base: "#bae6fd", build: "#fed7aa", peak: "#fecaca",
  taper: "#e9d5ff", deload: "#bbf7d0",
};
const ARC_PHASE_FILL_CURRENT: Record<string, string> = {
  base: "#0ea5e9", build: "#f97316", peak: "#ef4444",
  taper: "#a855f7", deload: "#22c55e",
};

function TrainingArcChart({
  planWeeks, currentWeekNum, allRaceWeekNums,
}: {
  planWeeks: PlanWeek[];
  currentWeekNum: number;
  allRaceWeekNums: number[];
}) {
  const FLAG_H = 20;
  const CHART_H = 72;
  const LABEL_H = 16;
  const SVG_H = FLAG_H + CHART_H + LABEL_H;
  const BAR_W = 18;
  const GAP = 2;
  const n = planWeeks.length;
  const totalW = n * (BAR_W + GAP) - GAP;

  const maxMileage = Math.max(...planWeeks.map(w => w.mileage_target), 1);
  const raceWeekSet = new Set(allRaceWeekNums);

  // Sparse label cadence: every 2 weeks for short plans, every 4 for long
  const labelEvery = n <= 12 ? 2 : 4;

  return (
    <div className="overflow-x-auto">
      <svg width={totalW} height={SVG_H} style={{ display: "block" }}>
        <line x1={0} y1={FLAG_H + CHART_H} x2={totalW} y2={FLAG_H + CHART_H} stroke="#e5e7eb" strokeWidth={1} />
        {planWeeks.map((week, i) => {
          const x = i * (BAR_W + GAP);
          const isCurrent = week.week_number === currentWeekNum;
          const isPast = week.week_number < currentWeekNum;
          const isRace = raceWeekSet.has(week.week_number);

          const barH = Math.max(3, (week.mileage_target / maxMileage) * CHART_H);
          const barY = FLAG_H + CHART_H - barH;

          const fill = isCurrent
            ? (ARC_PHASE_FILL_CURRENT[week.phase] ?? "#374151")
            : isPast
            ? "#d1d5db"
            : (ARC_PHASE_FILL_FUTURE[week.phase] ?? "#e5e7eb");

          const showLabel = week.week_number === 1
            || week.week_number % labelEvery === 0
            || week.week_number === n;

          return (
            <g key={week.week_number}>
              <rect x={x} y={barY} width={BAR_W} height={barH} fill={fill} rx={2} />
              {isCurrent && (
                <rect x={x - 0.5} y={barY - 0.5} width={BAR_W + 1} height={barH + 1}
                  fill="none" stroke="#111827" strokeWidth={1.5} rx={2} />
              )}
              {isRace && (
                <g>
                  <line x1={x + BAR_W / 2} y1={FLAG_H - 2} x2={x + BAR_W / 2} y2={barY - 1}
                    stroke="#ef4444" strokeWidth={1} strokeDasharray="2,2" />
                  <circle cx={x + BAR_W / 2} cy={FLAG_H / 2} r={5} fill="#ef4444" />
                  <text x={x + BAR_W / 2} y={FLAG_H / 2 + 3.5} textAnchor="middle"
                    fontSize={6} fill="white" fontFamily="system-ui,sans-serif" fontWeight="700">R</text>
                </g>
              )}
              {showLabel && (
                <text x={x + BAR_W / 2} y={FLAG_H + CHART_H + LABEL_H - 2}
                  textAnchor="middle" fontSize={8} fill="#9ca3af"
                  fontFamily="system-ui,sans-serif">
                  {week.week_number}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {/* Phase legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        {(["base", "build", "peak", "taper", "deload"] as const)
          .filter(p => planWeeks.some(w => w.phase === p))
          .map(p => (
            <div key={p} className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ background: ARC_PHASE_FILL_CURRENT[p] ?? "#9ca3af" }} />
              <span className="text-xs text-gray-400">{PHASE_LABELS[p] ?? p}</span>
            </div>
          ))}
        <div className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />
          <span className="text-xs text-gray-400">Race</span>
        </div>
      </div>
    </div>
  );
}

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

      {/* Training arc chart */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Training Arc</h2>
        <TrainingArcChart
          planWeeks={planWeeks}
          currentWeekNum={currentWeekNum}
          allRaceWeekNums={allRaceWeekNums}
        />
      </div>

      {/* Full training arc */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">All Weeks</h2>
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

      <RemovePlanSection userId={userId} />
    </div>
  );
}

function RemovePlanSection({ userId }: { userId: string }) {
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function handleRemove() {
    setRemoving(true);
    await fetch("/api/plan/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    window.location.reload();
  }

  return (
    <div className="pb-4 text-center">
      {confirm ? (
        <p className="text-xs text-gray-400">
          Remove your plan?{" "}
          <button
            onClick={handleRemove}
            disabled={removing}
            className="text-red-500 underline underline-offset-2 hover:text-red-700 disabled:opacity-50"
          >
            {removing ? "Removing…" : "Yes, remove"}
          </button>
          {" · "}
          <button onClick={() => setConfirm(false)} className="underline underline-offset-2 hover:text-gray-600">
            Cancel
          </button>
        </p>
      ) : (
        <p className="text-xs text-gray-400">
          Text Dean anytime to discuss your plan.{" "}
          <button onClick={() => setConfirm(true)} className="underline underline-offset-2 hover:text-gray-600">
            Remove plan
          </button>
        </p>
      )}
    </div>
  );
}
