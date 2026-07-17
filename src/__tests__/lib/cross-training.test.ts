import { describe, it, expect } from "vitest";
import { classifyCrossTrainingEffort, computeRunGapSignal } from "@/lib/cross-training";

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
    expect(signal).toEqual({ daysSinceLastRun: null, consecutiveCrossTrainOnlyDays: 0 });
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
});
