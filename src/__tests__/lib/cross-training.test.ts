import { describe, it, expect } from "vitest";
import { classifyCrossTrainingEffort, computeRunGapSignal, buildPostRunMileageLine } from "@/lib/cross-training";

const emptyWeekTotals = { runMiles: 0, bikeMiles: 0, crossTrainSessions: 0 };

const base = {
  movingTimeSeconds: 1200,
  averageWatts: null,
  workoutType: null,
  activityName: null,
  lthrEstimate: null,
};

describe("classifyCrossTrainingEffort — low-friction defaults", () => {
  it("classifies a low absolute-HR walk as easy, never moderate", () => {
    // The "my heart rate was 82bpm, that was very easy" complaint: with no LTHR
    // anchor the old code defaulted to moderate. 82bpm is unambiguously easy.
    const { effort } = classifyCrossTrainingEffort({
      ...base,
      activityType: "Walk",
      averageHeartrate: 82,
    });
    expect(effort).toBe("easy");
  });

  it("defaults a walk with no intensity data to easy, not moderate", () => {
    const { effort } = classifyCrossTrainingEffort({
      ...base,
      activityType: "Walk",
      averageHeartrate: null,
    });
    expect(effort).toBe("easy");
  });

  it("defaults yoga with no data to easy", () => {
    const { effort } = classifyCrossTrainingEffort({
      ...base,
      activityType: "Yoga",
      averageHeartrate: null,
    });
    expect(effort).toBe("easy");
  });

  it("still calls genuinely elevated absolute HR hard", () => {
    const { effort } = classifyCrossTrainingEffort({
      ...base,
      activityType: "Ride",
      averageHeartrate: 160,
    });
    expect(effort).toBe("hard");
  });

  it("falls back to easy (not moderate) when there is no data at all", () => {
    const { effort } = classifyCrossTrainingEffort({
      ...base,
      activityType: "Rowing",
      averageHeartrate: null,
    });
    expect(effort).toBe("easy");
  });

  it("still honors LTHR-based moderate when an anchor exists", () => {
    // 150bpm at 170 LTHR = 88% → Z3 moderate. The LTHR path is unchanged.
    const { effort } = classifyCrossTrainingEffort({
      ...base,
      activityType: "Ride",
      averageHeartrate: 150,
      lthrEstimate: 170,
    });
    expect(effort).toBe("moderate");
  });
});

// ---------------------------------------------------------------------------
// computeRunGapSignal — deterministic "how long since this athlete last ran"
// signal, no LLM call
// ---------------------------------------------------------------------------
describe("computeRunGapSignal", () => {
  const refDate = new Date("2026-07-16T12:00:00Z"); // Thursday

  it("returns null daysSinceLastRun and 0 consecutiveCrossTrainOnlyDays with no activities", () => {
    const signal = computeRunGapSignal([], "UTC", refDate);
    expect(signal).toEqual({ daysSinceLastRun: null, consecutiveCrossTrainOnlyDays: 0, gapBeforeLastRun: null });
  });

  it("returns 0 days since last run when the athlete ran today", () => {
    const signal = computeRunGapSignal(
      [{ activity_type: "Run", start_date: "2026-07-16T08:00:00Z" }],
      "UTC",
      refDate
    );
    expect(signal.daysSinceLastRun).toBe(0);
  });

  it("counts consecutiveCrossTrainOnlyDays as the run gap when cross-training corroborates it", () => {
    const signal = computeRunGapSignal(
      [
        { activity_type: "Run", start_date: "2026-07-10T08:00:00Z" }, // 6 days before refDate
        { activity_type: "Ride", start_date: "2026-07-14T08:00:00Z" },
        { activity_type: "Elliptical", start_date: "2026-07-12T08:00:00Z" },
      ],
      "UTC",
      refDate
    );
    expect(signal.daysSinceLastRun).toBe(6);
    expect(signal.consecutiveCrossTrainOnlyDays).toBe(6);
  });

  it("returns 0 consecutiveCrossTrainOnlyDays when there's a run gap but no corroborating cross-training", () => {
    const signal = computeRunGapSignal(
      [{ activity_type: "Run", start_date: "2026-07-10T08:00:00Z" }],
      "UTC",
      refDate
    );
    expect(signal.daysSinceLastRun).toBe(6);
    expect(signal.consecutiveCrossTrainOnlyDays).toBe(0);
  });

  it("uses the most recent run, not the oldest, when multiple runs exist", () => {
    const signal = computeRunGapSignal(
      [
        { activity_type: "Run", start_date: "2026-07-01T08:00:00Z" },
        { activity_type: "Run", start_date: "2026-07-14T08:00:00Z" }, // 2 days before refDate
        { activity_type: "TrailRun", start_date: "2026-07-05T08:00:00Z" },
      ],
      "UTC",
      refDate
    );
    expect(signal.daysSinceLastRun).toBe(2);
  });

  it("treats Treadmill as a run (the previously-inconsistent classification, now fixed)", () => {
    const signal = computeRunGapSignal(
      [{ activity_type: "Treadmill", start_date: "2026-07-16T08:00:00Z" }],
      "UTC",
      refDate
    );
    expect(signal.daysSinceLastRun).toBe(0);
  });

  it("safely ignores activities with a null activity_type", () => {
    const signal = computeRunGapSignal(
      [
        { activity_type: null, start_date: "2026-07-16T08:00:00Z" },
        { activity_type: "Run", start_date: "2026-07-13T08:00:00Z" },
      ],
      "UTC",
      refDate
    );
    expect(signal.daysSinceLastRun).toBe(3);
  });

  it("computes gapBeforeLastRun as the days between the two most recent runs", () => {
    const signal = computeRunGapSignal(
      [
        { activity_type: "Run", start_date: "2026-07-16T08:00:00Z" }, // today — the "testing the waters" run
        { activity_type: "Run", start_date: "2026-07-04T08:00:00Z" }, // 12 days before that
      ],
      "UTC",
      refDate
    );
    expect(signal.daysSinceLastRun).toBe(0);
    expect(signal.gapBeforeLastRun).toBe(12);
  });

  it("returns null gapBeforeLastRun when only one run exists in history", () => {
    const signal = computeRunGapSignal(
      [{ activity_type: "Run", start_date: "2026-07-16T08:00:00Z" }],
      "UTC",
      refDate
    );
    expect(signal.gapBeforeLastRun).toBeNull();
  });

  it("collapses same-day duplicate run entries before computing gapBeforeLastRun", () => {
    const signal = computeRunGapSignal(
      [
        { activity_type: "Run", start_date: "2026-07-16T08:00:00Z" },
        { activity_type: "Run", start_date: "2026-07-16T18:00:00Z" }, // same local day, second session
        { activity_type: "Run", start_date: "2026-07-01T08:00:00Z" },
      ],
      "UTC",
      refDate
    );
    expect(signal.daysSinceLastRun).toBe(0);
    expect(signal.gapBeforeLastRun).toBe(15);
  });
});

describe("buildPostRunMileageLine — distance for non-run/bike activities", () => {
  it("reports a walk in miles, not minutes", () => {
    const line = buildPostRunMileageLine("Walk", 4828, emptyWeekTotals, false); // ~3mi
    expect(line).toBe("3mi walk today. First session logged this week.");
  });

  it("reports a hike in miles", () => {
    const line = buildPostRunMileageLine("Hike", 8047, emptyWeekTotals, false); // 5mi
    expect(line).toBe("5mi hike today. First session logged this week.");
  });

  it("reports a walk in km for metric users", () => {
    const line = buildPostRunMileageLine("Walk", 4828, emptyWeekTotals, true);
    expect(line).toBe("4.8km walk today. First session logged this week.");
  });

  it("reports a pool swim in yards for non-metric users", () => {
    const line = buildPostRunMileageLine("Swim", 1000, emptyWeekTotals, false); // ~1094yd
    expect(line).toBe("1094yd swim today. First session logged this week.");
  });

  it("reports a swim in meters for metric users", () => {
    const line = buildPostRunMileageLine("Swim", 1000, emptyWeekTotals, true);
    expect(line).toBe("1000m swim today. First session logged this week.");
  });

  it("labels open water swims distinctly", () => {
    const line = buildPostRunMileageLine("OpenWaterSwim", 2000, emptyWeekTotals, false);
    expect(line).toBe("2187yd open water swim today. First session logged this week.");
  });

  it("still reports strength/no-distance sessions by label only, no distance line", () => {
    const line = buildPostRunMileageLine("WeightTraining", null, emptyWeekTotals, false);
    expect(line).toBe("Strength session today. First session logged this week.");
  });
});
