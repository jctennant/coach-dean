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
  // Fixed clock so "today"/"yesterday" assertions don't drift with the wall clock. The
  // activity below starts at 15:00Z = 9am in Denver on the same calendar day as NOW.
  const TZ = "America/Denver";
  const NOW = new Date("2026-08-16T18:00:00Z");
  const TODAY = "2026-08-16T15:00:00Z";

  const one = (
    activity_type: string | null,
    distance_meters: number | null,
    isMetric: boolean,
    extra: { moving_time_seconds?: number | null; start_date?: string | null } = {},
  ) =>
    buildPostRunMileageLine(
      [{ activity_type, distance_meters, start_date: TODAY, ...extra }],
      emptyWeekTotals,
      isMetric,
      TZ,
      NOW,
    );

  it("reports a walk in miles, not minutes", () => {
    expect(one("Walk", 4828, false)).toBe("3mi walk today. First session logged this week."); // ~3mi
  });

  it("reports a hike in miles", () => {
    expect(one("Hike", 8047, false)).toBe("5mi hike today. First session logged this week."); // 5mi
  });

  it("reports a walk in km for metric users", () => {
    expect(one("Walk", 4828, true)).toBe("4.8km walk today. First session logged this week.");
  });

  it("reports a pool swim in yards for non-metric users", () => {
    expect(one("Swim", 1000, false)).toBe("1094yd swim today. First session logged this week."); // ~1094yd
  });

  it("reports a swim in meters for metric users", () => {
    expect(one("Swim", 1000, true)).toBe("1000m swim today. First session logged this week.");
  });

  it("labels open water swims distinctly", () => {
    expect(one("OpenWaterSwim", 2000, false)).toBe("2187yd open water swim today. First session logged this week.");
  });

  it("reports no-distance sessions by duration, so the line is never a bare label", () => {
    // Previously "Strength session today." — and when Dean's optional line 2 came back
    // empty, that fragment was the whole SMS. Duration is what Strava actually has here.
    expect(one("WeightTraining", null, false, { moving_time_seconds: 1_800 })).toBe(
      "30min strength session today. First session logged this week."
    );
  });

  it("falls back to the bare label when there is neither distance nor duration", () => {
    expect(one("WeightTraining", null, false, { moving_time_seconds: null })).toBe(
      "Strength session today. First session logged this week."
    );
  });
});

describe("buildPostRunMileageLine — dating and multi-activity batches", () => {
  const TZ = "America/Denver";
  const NOW = new Date("2026-08-16T18:00:00Z"); // 12pm Denver, Sunday Aug 16

  it("says yesterday for a retroactively uploaded activity, not today", () => {
    // The 2026-08-16 bug: a walk from the 15th announced as "0.9mi walk today" because
    // line 1 hardcoded the word regardless of when the activity actually happened.
    const line = buildPostRunMileageLine(
      [{ activity_type: "Walk", distance_meters: 1448, start_date: "2026-08-15T14:00:00Z" }],
      emptyWeekTotals,
      false,
      TZ,
      NOW,
    );
    expect(line).toBe("0.9mi walk yesterday. First session logged this week.");
  });

  it("names the weekday for activities a few days back", () => {
    const line = buildPostRunMileageLine(
      [{ activity_type: "Run", distance_meters: 8047, start_date: "2026-08-13T14:00:00Z" }],
      emptyWeekTotals,
      false,
      TZ,
      NOW,
    );
    expect(line).toBe("5mi run Thursday. First session logged this week.");
  });

  it("joins same-day activities under one shared day label", () => {
    const line = buildPostRunMileageLine(
      [
        { activity_type: "Walk", distance_meters: 1448, start_date: "2026-08-16T14:00:00Z" },
        { activity_type: "Swim", distance_meters: 720, start_date: "2026-08-16T16:00:00Z" },
      ],
      { runMiles: 0, bikeMiles: 0, crossTrainSessions: 7 },
      false,
      TZ,
      NOW,
    );
    expect(line).toBe("0.9mi walk + 787yd swim today. 7 cross-training sessions this week.");
  });

  it("dates each activity separately when a batch spans days", () => {
    // Gwyneth's actual 2026-08-16 batch: a walk from the 15th and a swim from the 16th,
    // bulk-uploaded together. One shared "today" would have been wrong for the walk.
    const line = buildPostRunMileageLine(
      [
        { activity_type: "Swim", distance_meters: 720, start_date: "2026-08-16T07:52:00Z" },
        { activity_type: "Walk", distance_meters: 1448, start_date: "2026-08-15T08:42:00Z" },
      ],
      { runMiles: 0, bikeMiles: 0, crossTrainSessions: 7 },
      false,
      TZ,
      NOW,
    );
    expect(line).toBe("0.9mi walk yesterday, 787yd swim today. 7 cross-training sessions this week.");
  });

  it("returns just the week summary when there are no activities", () => {
    const line = buildPostRunMileageLine([], { runMiles: 12, bikeMiles: 0, crossTrainSessions: 0 }, false, TZ, NOW);
    expect(line).toBe("12mi running this week.");
  });
});
