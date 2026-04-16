/**
 * estimateMaxHR
 *
 * Estimates an athlete's true maximum heart rate from Strava activity data.
 * Used by the dashboard (page.tsx) and coach respond route.
 *
 * Why estimation is hard:
 *   Strava HR monitors frequently produce brief sensor spikes — a dropped
 *   contact or ECG artifact reads 210–230 bpm for a second, which gets stored
 *   as the activity's max_heartrate. Taking the raw maximum across activities
 *   almost always returns one of these spikes.
 *
 * Strategy — tiered by activity reliability:
 *
 *   Tier 1 — Race (workout_type = 1)
 *     Most reliable: athlete is pushing at maximum sustainable effort throughout.
 *     In a race the gap between avg HR and peak HR is small (≈5–12 bpm).
 *     Ratio cap: max / avg < 1.15. A reading above that on a race is almost
 *     certainly a sensor spike.
 *
 *   Tier 2 — Flagged workout (workout_type = 3, i.e. Strava "Workout" type)
 *     Reliable for intervals and tempo: athlete hit hard zones, but recovery
 *     jogs drag avg HR down, so the peak/avg gap is legitimately larger.
 *     Ratio cap: max / avg < 1.30.
 *
 *   Tier 3 — All runs
 *     Least reliable, used only when no race or workout data exists.
 *     Ratio cap: max / avg < 1.40.
 *
 *   Within each tier a secondary gap check runs: if the single top reading is
 *   15+ bpm above the next-highest in that tier, it's discarded as a spike
 *   that slipped through the ratio filter.
 *
 *   Final value × 1.02: even in a race, athletes typically reach 97–99% of
 *   true physiological max, so a small safety margin is appropriate.
 *
 *   Fallback: if no activities have both avg and max HR stored, estimate from
 *   the highest average_heartrate seen × 1.12.
 */

export type ActivityForMaxHR = {
  activity_type: string | null;
  workout_type: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
};

const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

export function estimateMaxHR(activities: ActivityForMaxHR[]): number | null {
  // Base pool: run activities with both HR fields present and plausible values
  const pool = activities.filter(
    a =>
      RUN_TYPES.has(a.activity_type ?? "") &&
      (a.max_heartrate ?? 0) > 100 &&
      (a.average_heartrate ?? 0) > 60
  );

  const tiers: Array<{ workoutTypes: (number | null)[]; ratioMax: number }> = [
    { workoutTypes: [1],          ratioMax: 1.15 }, // race
    { workoutTypes: [3],          ratioMax: 1.30 }, // intervals / tempo
    { workoutTypes: [0, 2, null], ratioMax: 1.40 }, // regular / long run
  ];

  for (const tier of tiers) {
    const candidates = pool
      .filter(
        a =>
          tier.workoutTypes.includes(a.workout_type ?? null) &&
          a.max_heartrate! / a.average_heartrate! < tier.ratioMax
      )
      .map(a => a.max_heartrate!)
      .sort((a, b) => b - a); // descending

    if (candidates.length === 0) continue;

    // Gap check: skip isolated spike that ratio filter didn't catch
    const top = candidates[0]!;
    const second = candidates[1];
    const best = second != null && top - second > 15 ? second : top;
    return best * 1.02;
  }

  // Fallback: no activities with both HR fields — estimate from avg HR
  const avgHRs = pool
    .filter(a => a.average_heartrate != null)
    .map(a => a.average_heartrate!);
  if (avgHRs.length === 0) return null;
  return Math.max(...avgHRs) * 1.12;
}
