import { describe, it, expect } from "vitest";
import {
  EXERCISES,
  ROUTINES,
  getRoutine,
  routineKeyForInjuryText,
  composeStrengthRoutine,
  buildStoredRoutine,
  posterUrl,
} from "@/lib/strength-library";

describe("strength-library — catalog integrity", () => {
  it("every routine references only known exercise ids", () => {
    for (const r of ROUTINES) {
      for (const id of r.exerciseIds) {
        expect(EXERCISES[id], `routine "${r.key}" references unknown exercise "${id}"`).toBeDefined();
      }
    }
  });

  it("routine keys are unique", () => {
    const keys = ROUTINES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every routine has 4–5 exercises and a non-empty note + frequency", () => {
    for (const r of ROUTINES) {
      expect(r.exerciseIds.length).toBeGreaterThanOrEqual(4);
      expect(r.exerciseIds.length).toBeLessThanOrEqual(5);
      expect(r.note.length).toBeGreaterThan(0);
      expect(r.frequency.length).toBeGreaterThan(0);
    }
  });

  it("includes the universal hip_core base routine with no match keywords (default-only)", () => {
    const base = getRoutine("hip_core");
    expect(base).not.toBeNull();
    expect(base!.matches).toEqual([]);
  });
});

describe("routineKeyForInjuryText — mapping", () => {
  it.each([
    ["my left achilles is sore", "calf"],
    ["IT band syndrome on the right", "it_band"],
    ["recurring shin splints", "shin"],
    ["plantar fasciitis in my heel", "foot"],
    ["runner's knee / patellar pain", "knee"],
    ["pulled hamstring", "hamstring"],
    ["tight piriformis", "piriformis"],
    ["groin strain", "groin"],
    ["rolled my ankle", "ankle"],
    ["lower back tightness", "back"],
    ["weak glutes", "glute"],
    ["hip flexor tightness", "hip"],
  ])("maps %q → %q", (text, expected) => {
    expect(routineKeyForInjuryText(text)).toBe(expected);
  });

  it("returns null for empty / unrecognized text", () => {
    expect(routineKeyForInjuryText(null)).toBeNull();
    expect(routineKeyForInjuryText("")).toBeNull();
    expect(routineKeyForInjuryText("feeling great, no issues")).toBeNull();
  });

  it("prefers the more specific term when multiple could match", () => {
    // "it band" should win over the generic substring scan picking up nothing else
    expect(routineKeyForInjuryText("knee pain from IT band")).toBe("it_band");
  });
});

describe("composeStrengthRoutine — generation", () => {
  it("returns null when there is no injury signal at all", () => {
    expect(composeStrengthRoutine({ bodyParts: [], injuryText: null })).toBeNull();
    expect(composeStrengthRoutine({ bodyParts: [null, undefined], injuryText: "" })).toBeNull();
  });

  it("builds a site-specific routine from a body part", () => {
    const r = composeStrengthRoutine({ bodyParts: ["left achilles"], injuryText: null });
    expect(r).not.toBeNull();
    expect(r!.routine_key).toBe("calf");
    expect(r!.exercises.length).toBe(4);
    expect(r!.exercises[0]).toHaveProperty("name");
    expect(r!.exercises[0]).toHaveProperty("specs");
    expect(r!.poster_url).toBe(posterUrl("calf"));
  });

  it("builds from free-text injury history when no body part field is set", () => {
    const r = composeStrengthRoutine({ bodyParts: [], injuryText: "IT band issues in 2023, stress fracture 2022" });
    expect(r!.routine_key).toBe("it_band");
  });

  it("falls back to the hip_core base when there is history but no recognizable part", () => {
    const r = composeStrengthRoutine({ bodyParts: [], injuryText: "had some niggles last year, nothing specific" });
    expect(r!.routine_key).toBe("hip_core");
  });

  it("produces a stored shape compatible with the coach reader (name/specs/reason)", () => {
    const r = buildStoredRoutine("knee")!;
    for (const ex of r.exercises) {
      expect(typeof ex.name).toBe("string");
      expect(typeof ex.specs).toBe("string");
      expect(typeof ex.reason).toBe("string");
    }
    expect(r.frequency).toMatch(/week/i);
    expect(r.note.length).toBeGreaterThan(0);
  });

  it("buildStoredRoutine returns null for an unknown key", () => {
    expect(buildStoredRoutine("not_a_routine")).toBeNull();
  });
});

describe("posterUrl", () => {
  it("uses the routine key as the filename stem", () => {
    expect(posterUrl("it_band")).toMatch(/it_band\.png$/);
  });
});
