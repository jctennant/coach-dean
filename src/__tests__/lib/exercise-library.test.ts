import { describe, it, expect } from "vitest";
import {
  KNOWN_REHAB_PARTS,
  getRehabData,
  normalizeBodyPart,
  BODY_PART_EXERCISES,
  CROSS_TRAINING_ALTERNATIVES,
} from "@/lib/exercise-library";

describe("exercise-library — catalog integrity", () => {
  it("all known parts have at least 3 exercises", () => {
    for (const part of KNOWN_REHAB_PARTS) {
      expect(BODY_PART_EXERCISES[part].length, `${part} has too few exercises`).toBeGreaterThanOrEqual(3);
    }
  });

  it("KNOWN_REHAB_PARTS matches BODY_PART_EXERCISES keys", () => {
    expect(new Set(KNOWN_REHAB_PARTS)).toEqual(new Set(Object.keys(BODY_PART_EXERCISES)));
  });

  it("has 12 known body parts", () => {
    expect(KNOWN_REHAB_PARTS).toHaveLength(12);
  });
});

describe("getRehabData", () => {
  it.each(["it_band", "hamstring", "knee", "shin", "calf", "foot", "hip", "piriformis", "glute", "back", "ankle", "groin"])(
    "returns data for known part: %s",
    (part) => {
      const result = getRehabData(part);
      expect(result).not.toBeNull();
      expect(result!.exercises.length).toBeGreaterThan(0);
      expect(Array.isArray(result!.crossTraining)).toBe(true);
    }
  );

  it("returns null for unknown body part", () => {
    expect(getRehabData("shoulder")).toBeNull();
    expect(getRehabData("wrist")).toBeNull();
    expect(getRehabData("")).toBeNull();
    expect(getRehabData("xyz_unknown")).toBeNull();
  });

  it("cross-training list exists for major parts", () => {
    const partsWithCrossTraining = Object.keys(CROSS_TRAINING_ALTERNATIVES);
    for (const part of partsWithCrossTraining) {
      const result = getRehabData(part);
      expect(result!.crossTraining.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeBodyPart", () => {
  it.each([
    ["knee", "knee"],
    ["shin", "shin"],
    ["it_band", "it_band"],
    ["IT band", "it_band"],
    ["hamstring", "hamstring"],
    ["hammy", "hamstring"],
    ["achilles", "calf"],
    ["plantar fasciitis", "foot"],
    ["arch pain", "foot"],
    ["iliotibial", "it_band"],
    ["piriformis", "piriformis"],
    ["glute", "glute"],
    ["glutes", "glute"],
    ["ankle", "ankle"],
    ["back", "back"],
    ["groin", "groin"],
    ["hip", "hip"],
  ])("normalizes %q → %q", (input, expected) => {
    expect(normalizeBodyPart(input)).toBe(expected);
  });

  it("returns null for unrecognized parts", () => {
    expect(normalizeBodyPart("shoulder")).toBeNull();
    expect(normalizeBodyPart("wrist")).toBeNull();
    expect(normalizeBodyPart("elbow")).toBeNull();
  });
});
