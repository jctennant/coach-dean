"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlanImportForm } from "./plan-import-form";

type CurrentWeekData = {
  mileage_target: number;
  mileage_target_min?: number;
  mileage_target_max?: number;
  long_run_target: number;
  key_workout: string;
  phase: string;
};

export type PlanCardProps = {
  userId: string;
  currentWeek: number;
  totalWeeks: number;
  currentWeekData: CurrentWeekData | null;
  useMetric: boolean;
  // Actual progress this week (from Strava)
  actualDisplay: number;
  targetDisplay: number | null;
  distUnit: string;
  progressPct: number;
  isUploadedPlan: boolean;
  // Remaining easy miles after long run + quality session (null if unparseable)
  easyMilesRemaining: number | null;
};

const PHASE_LABELS: Record<string, string> = {
  build: "Build", peak: "Peak", taper: "Taper", deload: "Deload", base: "Base",
};

function fmtDist(miles: number, useMetric: boolean): string {
  if (useMetric) return `${Math.round(miles * 1.60934 * 10) / 10} km`;
  return `${Math.round(miles * 10) / 10} mi`;
}

export function PlanCard({
  userId, currentWeek, totalWeeks, currentWeekData, useMetric,
  actualDisplay, targetDisplay, distUnit, progressPct,
  isUploadedPlan, easyMilesRemaining,
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

  const phase = currentWeekData?.phase;
  const showPhase = phase && phase !== "base" && PHASE_LABELS[phase];

  const hasMileageRange =
    currentWeekData?.mileage_target_min != null &&
    currentWeekData?.mileage_target_max != null &&
    currentWeekData.mileage_target_max > currentWeekData.mileage_target_min;

  // Prefer the training_state-derived targetDisplay (reflects any in-week adjustments),
  // but fall back to the plan's own week mileage_target when state hasn't been written yet
  // (e.g. brand-new plan, or edge cases where training_state is missing).
  const planWeekTarget = currentWeekData?.mileage_target && currentWeekData.mileage_target > 0
    ? currentWeekData.mileage_target
    : null;
  const targetLabel = hasMileageRange
    ? `${fmtDist(currentWeekData!.mileage_target_min!, useMetric)}–${fmtDist(currentWeekData!.mileage_target_max!, useMetric)} target`
    : targetDisplay != null
      ? `${targetDisplay} ${distUnit} target`
      : planWeekTarget != null
        ? `${fmtDist(planWeekTarget, useMetric)} target`
        : null;

  const longRunDisplay = currentWeekData?.long_run_target && currentWeekData.long_run_target > 0
    ? fmtDist(currentWeekData.long_run_target, useMetric)
    : null;

  const keyWorkout = currentWeekData?.key_workout || null;

  return (
    <div className="space-y-5">
      {/* Week header */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-800">Week {currentWeek} of {totalWeeks}</p>
        {showPhase && (
          <span className="text-xs text-gray-400">{PHASE_LABELS[phase!]} phase</span>
        )}
      </div>

      {/* Mileage progress */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-bold tabular-nums text-gray-900">{actualDisplay}</span>
            <span className="text-sm text-gray-400">{distUnit} done</span>
          </div>
          {targetLabel && (
            <span className="text-sm text-gray-400 shrink-0">{targetLabel}</span>
          )}
        </div>
        <div className="w-full bg-gray-100 rounded-full h-1.5">
          <div
            className="bg-green-500 h-1.5 rounded-full transition-all"
            style={{ width: `${Math.min(100, progressPct)}%` }}
          />
        </div>
      </div>

      {/* Key sessions */}
      {(longRunDisplay || keyWorkout) && (
        <div className="divide-y divide-gray-50 border-t border-gray-50 pt-1">
          {longRunDisplay && (
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Long run</span>
              <span className="text-sm font-semibold text-gray-800">~{longRunDisplay}</span>
            </div>
          )}
          {keyWorkout && (
            <div className="py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Quality</p>
              <p className="text-sm text-gray-700 leading-snug">{keyWorkout}</p>
            </div>
          )}
          {easyMilesRemaining != null && easyMilesRemaining > 0 && (
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Easy miles</span>
              <span className="text-sm font-semibold text-gray-800">~{fmtDist(easyMilesRemaining, useMetric)}</span>
            </div>
          )}
        </div>
      )}

      {/* Guidance */}
      <p className="text-[11px] text-gray-400 leading-snug">
        Hit the target with easy-effort runs across your training days — the long run and quality session are the only structured pieces.
      </p>

      {/* Plan actions — only for imported plans. Dean-generated plans are managed via SMS. */}
      {isUploadedPlan && (
      <div className="flex items-center justify-center gap-4 pt-1 border-t border-gray-50">
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
            <button onClick={handleRemove} disabled={removing} className="text-red-500 font-medium hover:text-red-700">
              {removing ? "Removing…" : "Yes, remove"}
            </button>
            {" · "}
            <button onClick={() => setConfirmRemove(false)} className="hover:text-gray-700">Cancel</button>
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
      )}
    </div>
  );
}
