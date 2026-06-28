import { describe, it, expect } from "vitest";
import { classifyCrossTrainingEffort } from "@/lib/cross-training";

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
