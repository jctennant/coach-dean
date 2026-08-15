import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inferTrainingDaysFromActivities } from "@/lib/infer-training-days";

// Fixed reference date so "lookbackDays" windows are deterministic regardless of when
// the suite runs. All dates below are within 28 days of this. inferTrainingDaysFromActivities
// computes its lookback cutoff from the real wall clock (Date.now()), so the fixture dates
// only stay valid if the system clock is pinned to match — otherwise the cutoff drifts away
// from NOW as real time passes and activities silently fall outside the lookback window.
const NOW = new Date("2026-08-02T12:00:00Z"); // a Sunday
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("inferTrainingDaysFromActivities", () => {
  it("returns null when there's no run history", () => {
    expect(inferTrainingDaysFromActivities([], "UTC")).toBeNull();
  });

  it("returns null with only a single week of data, even if consistent", () => {
    // One week: Mon, Wed, Sat runs — a real pattern, but only one data point.
    const activities = [
      { activity_type: "Run", start_date: daysAgo(1) }, // Sat
      { activity_type: "Run", start_date: daysAgo(4) }, // Wed
      { activity_type: "Run", start_date: daysAgo(6) }, // Mon
    ];
    expect(inferTrainingDaysFromActivities(activities, "UTC")).toBeNull();
  });

  it("infers a consistent 3x/week pattern across multiple weeks", () => {
    // Mon/Wed/Sat runs across 3 consecutive weeks — a clear standing schedule.
    const activities = [
      { activity_type: "Run", start_date: daysAgo(1) },  // Sat, week 0
      { activity_type: "Run", start_date: daysAgo(4) },  // Wed, week 0
      { activity_type: "Run", start_date: daysAgo(6) },  // Mon, week 0
      { activity_type: "Run", start_date: daysAgo(8) },  // Sat, week 1
      { activity_type: "Run", start_date: daysAgo(11) }, // Wed, week 1
      { activity_type: "Run", start_date: daysAgo(13) }, // Mon, week 1
      { activity_type: "Run", start_date: daysAgo(15) }, // Sat, week 2
      { activity_type: "Run", start_date: daysAgo(18) }, // Wed, week 2
      { activity_type: "Run", start_date: daysAgo(20) }, // Mon, week 2
    ];
    const result = inferTrainingDaysFromActivities(activities, "UTC");
    expect(result).toEqual(["monday", "wednesday", "saturday"]);
  });

  it("returns null for scattershot history with no repeated weekday", () => {
    // Every run on a different weekday across weeks — no day repeats often enough.
    const activities = [
      { activity_type: "Run", start_date: daysAgo(1) },  // Sat
      { activity_type: "Run", start_date: daysAgo(9) },  // Fri
      { activity_type: "Run", start_date: daysAgo(17) }, // Thu
    ];
    expect(inferTrainingDaysFromActivities(activities, "UTC")).toBeNull();
  });

  it("ignores non-run activity types (bike, swim, strength)", () => {
    const activities = [
      { activity_type: "Ride", start_date: daysAgo(1) },
      { activity_type: "Swim", start_date: daysAgo(4) },
      { activity_type: "WeightTraining", start_date: daysAgo(6) },
    ];
    expect(inferTrainingDaysFromActivities(activities, "UTC")).toBeNull();
  });

  it("ignores activities outside the lookback window", () => {
    const activities = [
      { activity_type: "Run", start_date: daysAgo(35) },
      { activity_type: "Run", start_date: daysAgo(42) },
      { activity_type: "Run", start_date: daysAgo(49) },
    ];
    expect(inferTrainingDaysFromActivities(activities, "UTC", 28)).toBeNull();
  });
});
