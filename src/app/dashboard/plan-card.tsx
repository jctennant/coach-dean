"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlanArcChart, type ArcWeek } from "./plan-arc-chart";
import { PlanImportForm } from "./plan-import-form";

type CurrentWeekData = {
  mileage_target: number;
  mileage_target_min?: number;
  mileage_target_max?: number;
  long_run_target: number;
  key_workout: string;
  phase: string;
};

type PlanCardProps = {
  userId: string;
  currentWeek: number;
  totalWeeks: number;
  currentWeekData: CurrentWeekData | null;
  allWeeks: ArcWeek[];
  raceWeekNums: number[];
  useMetric: boolean;
};

function fmtDist(miles: number, useMetric: boolean): string {
  if (useMetric) return `${Math.round(miles * 1.60934 * 10) / 10} km`;
  return `${Math.round(miles * 10) / 10} mi`;
}

export function PlanCard({
  userId, currentWeek, totalWeeks, currentWeekData, allWeeks, raceWeekNums, useMetric,
}: PlanCardProps) {
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const router = useRouter();

  async function handleRemove() {
    setRemoving(true);
    try {
      await fetch("/api/plan/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      router.refresh();
    } catch {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  if (replacing) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-700">Replace plan</p>
          <button onClick={() => setReplacing(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
        </div>
        <PlanImportForm userId={userId} />
      </div>
    );
  }

  const hasMileageRange =
    currentWeekData?.mileage_target_min != null &&
    currentWeekData?.mileage_target_max != null &&
    currentWeekData.mileage_target_max > currentWeekData.mileage_target_min;

  const mileageDisplay = hasMileageRange
    ? `${fmtDist(currentWeekData!.mileage_target_min!, useMetric)}–${fmtDist(currentWeekData!.mileage_target_max!, useMetric)}`
    : currentWeekData?.mileage_target
      ? `~${fmtDist(currentWeekData.mileage_target, useMetric)}`
      : null;

  const longRunDisplay = currentWeekData?.long_run_target && currentWeekData.long_run_target > 0
    ? `~${fmtDist(currentWeekData.long_run_target, useMetric)}`
    : null;

  const keyWorkout = currentWeekData?.key_workout || null;

  return (
    <div className="space-y-4">
      {/* Week header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-base font-bold text-gray-900">Week {currentWeek} of {totalWeeks}</p>
          {currentWeekData?.phase && currentWeekData.phase !== "base" && (
            <p className="text-xs text-gray-400 mt-0.5 capitalize">{currentWeekData.phase} phase</p>
          )}
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400 tabular-nums">
            {Math.round((currentWeek / totalWeeks) * 100)}% complete
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-100 rounded-full h-1">
        <div
          className="bg-indigo-500 h-1 rounded-full transition-all"
          style={{ width: `${Math.min(100, (currentWeek / totalWeeks) * 100)}%` }}
        />
      </div>

      {/* Key metrics */}
      {(mileageDisplay || longRunDisplay) && (
        <div className={`grid gap-3 ${mileageDisplay && longRunDisplay ? "grid-cols-2" : "grid-cols-1"}`}>
          {mileageDisplay && (
            <div className="rounded-xl bg-gray-50 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Mileage</p>
              <p className="text-xl font-bold text-gray-900 leading-none">{mileageDisplay}</p>
              <p className="text-[10px] text-gray-400 mt-1">this week</p>
            </div>
          )}
          {longRunDisplay && (
            <div className="rounded-xl bg-gray-50 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Long Run</p>
              <p className="text-xl font-bold text-gray-900 leading-none">{longRunDisplay}</p>
              <p className="text-[10px] text-gray-400 mt-1">target</p>
            </div>
          )}
        </div>
      )}

      {/* Quality session */}
      {keyWorkout && (
        <div className="rounded-xl bg-gray-50 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Quality Session</p>
          <p className="text-sm text-gray-700 leading-snug">{keyWorkout}</p>
        </div>
      )}

      {/* Arc chart */}
      {allWeeks.length > 0 && (
        <div className="pt-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Plan Arc</p>
          <PlanArcChart
            weeks={allWeeks}
            currentWeek={currentWeek}
            totalWeeks={totalWeeks}
            raceWeekNums={raceWeekNums}
            useMetric={useMetric}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-center gap-4 pt-1">
        <button
          onClick={() => setReplacing(true)}
          className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2"
        >
          Replace plan
        </button>
        <span className="text-gray-200">·</span>
        {confirmRemove ? (
          <span className="text-xs text-gray-500">
            Remove?{" "}
            <button
              onClick={handleRemove}
              disabled={removing}
              className="text-red-500 font-medium hover:text-red-700"
            >
              {removing ? "Removing…" : "Yes, remove"}
            </button>
            {" · "}
            <button onClick={() => setConfirmRemove(false)} className="hover:text-gray-700">
              Cancel
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmRemove(true)}
            className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2"
          >
            Remove plan
          </button>
        )}
      </div>
    </div>
  );
}
