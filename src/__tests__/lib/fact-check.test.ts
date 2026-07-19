import { describe, it, expect } from "vitest";
import { checkStatedFacts, buildFactCorrection, type FactGroundTruth } from "@/lib/fact-check";

const truth: FactGroundTruth = {
  week_number: 7,
  weekly_target: 25,
  week_distance_completed: 12.4,
  days_until_race: 38,
  injuryHoldActive: false,
  unit: "mi",
};

describe("checkStatedFacts", () => {
  it("returns no mismatches when all stated facts match", () => {
    expect(
      checkStatedFacts(
        { week_number: 7, weekly_target: 25, week_distance_completed: 12, days_until_race: 38 },
        truth
      )
    ).toEqual([]);
  });

  it("returns no mismatches when the message states no facts (all null)", () => {
    expect(
      checkStatedFacts(
        { week_number: null, weekly_target: null, week_distance_completed: null, days_until_race: null },
        truth
      )
    ).toEqual([]);
  });

  it("handles a missing or malformed stated_facts payload", () => {
    expect(checkStatedFacts(undefined, truth)).toEqual([]);
    expect(checkStatedFacts(null, truth)).toEqual([]);
    expect(checkStatedFacts("junk", truth)).toEqual([]);
    expect(checkStatedFacts({ week_number: "seven" }, truth)).toEqual([]);
  });

  it("flags a wrong week number exactly", () => {
    const result = checkStatedFacts({ week_number: 10 }, truth);
    expect(result).toEqual([{ fact: "week_number", stated: 10, actual: 7 }]);
  });

  it("allows ±1 day slack on days_until_race but flags beyond it", () => {
    expect(checkStatedFacts({ days_until_race: 39 }, truth)).toEqual([]);
    expect(checkStatedFacts({ days_until_race: 37 }, truth)).toEqual([]);
    expect(checkStatedFacts({ days_until_race: 45 }, truth)).toEqual([
      { fact: "days_until_race", stated: 45, actual: 38 },
    ]);
  });

  it("allows rounding slack on distances but flags a real divergence", () => {
    // 10% of 25 = 2.5 tolerance
    expect(checkStatedFacts({ weekly_target: 26 }, truth)).toEqual([]);
    expect(checkStatedFacts({ weekly_target: 40 }, truth)).toEqual([
      { fact: "weekly_target", stated: 40, actual: 25 },
    ]);
    // small truth values get the ±1 floor: truth 12.4 → tolerance max(1, 1.24)
    expect(checkStatedFacts({ week_distance_completed: 13 }, truth)).toEqual([]);
    expect(checkStatedFacts({ week_distance_completed: 20 }, truth)).toEqual([
      { fact: "week_distance_completed", stated: 20, actual: 12.4 },
    ]);
  });

  it("skips facts whose ground truth is null (e.g. weekly target during injury hold)", () => {
    const holdTruth: FactGroundTruth = { ...truth, weekly_target: null };
    expect(checkStatedFacts({ weekly_target: 40 }, holdTruth)).toEqual([]);
  });

  it("reports multiple mismatches at once", () => {
    const result = checkStatedFacts({ week_number: 10, weekly_target: 40 }, truth);
    expect(result.map((m) => m.fact).sort()).toEqual(["week_number", "weekly_target"]);
  });

  it("flags plan_source: full_arc while an injury hold is active", () => {
    const holdTruth: FactGroundTruth = { ...truth, injuryHoldActive: true };
    expect(checkStatedFacts({ plan_source: "full_arc" }, holdTruth)).toEqual([
      { fact: "plan_source", stated: "full_arc", actual: "return_to_run" },
    ]);
  });

  it("allows plan_source: return_to_run while an injury hold is active", () => {
    const holdTruth: FactGroundTruth = { ...truth, injuryHoldActive: true };
    expect(checkStatedFacts({ plan_source: "return_to_run" }, holdTruth)).toEqual([]);
  });

  it("allows plan_source: full_arc when there is no active injury hold", () => {
    expect(checkStatedFacts({ plan_source: "full_arc" }, truth)).toEqual([]);
  });
});

describe("buildFactCorrection", () => {
  it("names each wrong fact with stated vs actual values and asks for one re-delivery", () => {
    const text = buildFactCorrection(
      [
        { fact: "week_number", stated: 10, actual: 7 },
        { fact: "weekly_target", stated: 40, actual: 25 },
      ],
      truth
    );
    expect(text).toContain("DELIVERY REJECTED");
    expect(text).toContain("your message says 10, but the actual value is 7");
    expect(text).toContain("your message says 40, but the actual value is 25");
    expect(text).toContain("(mi)");
    expect(text).toContain("Call deliver_message again");
  });

  it("uses km wording for metric users", () => {
    const kmTruth: FactGroundTruth = { ...truth, unit: "km" };
    const text = buildFactCorrection([{ fact: "weekly_target", stated: 60, actual: 40 }], kmTruth);
    expect(text).toContain("(km)");
  });

  it("gives a custom instruction for a plan_source mismatch instead of generic stated/actual wording", () => {
    const text = buildFactCorrection(
      [{ fact: "plan_source", stated: "full_arc", actual: "return_to_run" }],
      { ...truth, injuryHoldActive: true }
    );
    expect(text).toContain("RETURN-TO-RUN CONTEXT");
    expect(text).toContain("injury hold");
    expect(text).not.toContain("your message says full_arc");
  });
});
