import { describe, it, expect } from "vitest";
import { computeSessionsStatus } from "@/app/api/coach/respond/route";

const TZ = "America/New_York";

function todayISO(daysAgo = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

function activity(
  overrides: Partial<{
    activity_name: string | null;
    workout_type: number | null;
    distance_meters: number;
    start_date: string;
    activity_type: string;
  }>
) {
  return {
    activity_type: "Run",
    distance_meters: 5 * 1609.34,
    moving_time_seconds: 2400,
    average_heartrate: null,
    max_heartrate: null,
    elevation_gain: null,
    average_pace: "8:00",
    start_date: todayISO(),
    average_cadence: null,
    gear_name: null,
    source: null,
    aerobic_efficiency: null,
    cardiac_decoupling_pct: null,
    workout_type: null,
    activity_name: null,
    ...overrides,
  };
}

describe("computeSessionsStatus", () => {
  it("marks long run DONE when a week run exceeds 85% of planned distance", () => {
    const status = computeSessionsStatus(
      [activity({ distance_meters: 8 * 1609.34 })], // 8mi run
      TZ,
      9, // planned 9mi long run → threshold 7.65mi
      null
    );
    expect(status.longRun.done).toBe(true);
    expect(status.longRun.activity?.miles).toBeCloseTo(8, 0);
  });

  it("marks long run PENDING when the longest run is below the 85% threshold", () => {
    const status = computeSessionsStatus(
      [activity({ distance_meters: 5 * 1609.34 })], // 5mi
      TZ,
      9, // threshold 7.65mi
      null
    );
    expect(status.longRun.done).toBe(false);
  });

  it("marks quality DONE when an activity has workout_type=3", () => {
    const status = computeSessionsStatus(
      [activity({ workout_type: 3, name: "Evening Run" })],
      TZ,
      null,
      "Tempo 5mi"
    );
    expect(status.quality.done).toBe(true);
  });

  it("marks quality DONE when activity name contains a quality keyword", () => {
    const status = computeSessionsStatus(
      [activity({ activity_name: "Tempo Tuesday" })],
      TZ,
      null,
      "Tempo 5mi"
    );
    expect(status.quality.done).toBe(true);
  });

  it("marks quality DONE for interval-style rep patterns in the name", () => {
    const status = computeSessionsStatus(
      [activity({ activity_name: "6x800m track" })],
      TZ,
      null,
      "Intervals 5mi"
    );
    expect(status.quality.done).toBe(true);
  });

  it("marks quality PENDING when no matching signals are present", () => {
    const status = computeSessionsStatus(
      [activity({ activity_name: "Morning jog" })],
      TZ,
      null,
      "Tempo 5mi"
    );
    expect(status.quality.done).toBe(false);
  });

  it("ignores non-run activities", () => {
    const status = computeSessionsStatus(
      [activity({ activity_type: "Ride", distance_meters: 30 * 1609.34 })],
      TZ,
      9,
      null
    );
    expect(status.longRun.done).toBe(false);
  });
});
