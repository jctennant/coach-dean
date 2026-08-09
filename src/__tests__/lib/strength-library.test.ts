import { describe, it, expect } from "vitest";
import {
  EXERCISES,
  ROUTINES,
  getRoutine,
  rehabSessionsPerWeek,
  routineExerciseIds,
  DRILL_EXERCISE_IDS,
  routineKeyForInjuryText,
  composeStrengthRoutine,
  buildStoredRoutine,
  posterUrl,
  exercisePosterUrl,
  hasExerciseImage,
  illustratedExerciseIds,
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

  it("every routine has 9–13 exercises (a full 20–30 min session) and a non-empty note + frequency", () => {
    for (const r of ROUTINES) {
      expect(r.exerciseIds.length).toBeGreaterThanOrEqual(9);
      expect(r.exerciseIds.length).toBeLessThanOrEqual(13);
      expect(r.note.length).toBeGreaterThan(0);
      expect(r.frequency.length).toBeGreaterThan(0);
    }
  });

  it("hip_core is the largest routine (includes running-form drills) at 13 exercises", () => {
    const base = getRoutine("hip_core")!;
    expect(base.exerciseIds.length).toBe(13);
  });

  it("includes the universal hip_core base routine with no match keywords (default-only)", () => {
    const base = getRoutine("hip_core");
    expect(base).not.toBeNull();
    expect(base!.matches).toEqual([]);
  });
});

describe("illustratedExerciseIds — art-gated catalog subset", () => {
  it("only returns ids that have a committed image and every id is a real catalog entry", () => {
    const ids = illustratedExerciseIds();
    for (const id of ids) {
      expect(EXERCISES[id], `illustrated id "${id}" is not in the catalog`).toBeDefined();
      expect(hasExerciseImage(id)).toBe(true);
    }
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
    ["pelvis has been sore after long runs", "pelvis"],
    ["pelvic pain on the left side", "pelvis"],
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
    expect(r!.exercises.length).toBe(9);
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

describe("exercisePosterUrl", () => {
  it("uses the exercise id as the filename stem, under /strength-exercises", () => {
    expect(exercisePosterUrl("clamshells")).toBe("/strength-exercises/clamshells.png");
  });
});

describe("hasExerciseImage", () => {
  it("returns true once art has been committed under public/strength-exercises/", () => {
    expect(hasExerciseImage("clamshells")).toBe(true);
  });

  it("every exercise in the catalog has an image (full 53-exercise rollout is complete)", () => {
    for (const id of Object.keys(EXERCISES)) {
      expect(hasExerciseImage(id), `missing image for exercise "${id}"`).toBe(true);
    }
  });

  it("returns false for an unknown exercise id without throwing", () => {
    expect(hasExerciseImage("not_a_real_exercise")).toBe(false);
  });
});

describe("newly added exercises — routine wiring", () => {
  it("fire_hydrant is wired into the piriformis routine", () => {
    expect(getRoutine("piriformis")!.exerciseIds).toContain("fire_hydrant");
  });

  it("running-form drills (a_skip, high_knees, bounding) are only in hip_core, not injury routines", () => {
    const drillIds = ["a_skip", "high_knees", "bounding"];
    for (const r of ROUTINES) {
      const hasDrills = drillIds.some((id) => r.exerciseIds.includes(id));
      if (r.key === "hip_core") {
        expect(hasDrills).toBe(true);
      } else {
        expect(hasDrills).toBe(false);
      }
    }
  });
});

describe("frequencyPerWeek", () => {
  it("is set on every routine", () => {
    for (const r of ROUTINES) {
      expect(r.frequencyPerWeek.min).toBeGreaterThan(0);
      expect(r.frequencyPerWeek.max).toBeGreaterThanOrEqual(r.frequencyPerWeek.min);
    }
  });

  it("gives low-load routines a daily range and high-eccentric ones a recovery gap", () => {
    // The distinction the single shared REHAB_FREQ string used to erase: shin/calf/foot are
    // low-load loading and mobility, the hamstring routine is Nordics and hip thrusts.
    for (const key of ["shin", "calf", "foot", "ankle"]) {
      expect(getRoutine(key)!.frequencyPerWeek).toEqual({ min: 5, max: 7 });
    }
    expect(getRoutine("hamstring")!.frequencyPerWeek).toEqual({ min: 2, max: 3 });
    expect(getRoutine("knee")!.frequencyPerWeek).toEqual({ min: 3, max: 5 });
  });

  it("keeps the display string consistent with the range", () => {
    expect(getRoutine("shin")!.frequency).toContain("5–7×");
    expect(getRoutine("hamstring")!.frequency).toContain("2–3×");
  });
});

describe("rehabSessionsPerWeek", () => {
  it("scales with severity inside the routine's own range", () => {
    expect(rehabSessionsPerWeek("shin", "mild", true)).toBe(5);
    expect(rehabSessionsPerWeek("shin", "moderate", true)).toBe(6);
    expect(rehabSessionsPerWeek("shin", "severe", true)).toBe(7);
    expect(rehabSessionsPerWeek("hamstring", "mild", true)).toBe(2);
    expect(rehabSessionsPerWeek("hamstring", "severe", true)).toBe(3);
  });

  it("starts at the low end when severity is unknown", () => {
    expect(rehabSessionsPerWeek("shin", null, true)).toBe(5);
  });

  it("gives an athlete with no ACTIVE injury a single session, whatever their history says", () => {
    // composeStrengthRoutine matches on injury_notes, which never expires — an athlete whose
    // shin splints resolved months ago must not be scheduled as though they were hurt.
    expect(rehabSessionsPerWeek("shin", "moderate", false)).toBe(1);
    expect(rehabSessionsPerWeek("hip_core", null, false)).toBe(1);
  });

  it("falls back to one session for an unknown routine", () => {
    expect(rehabSessionsPerWeek("nonsense", "severe", true)).toBe(1);
    expect(rehabSessionsPerWeek(null, "severe", true)).toBe(1);
  });
});

describe("routineExerciseIds", () => {
  it("drops the plyometric drills for an injured athlete", () => {
    // hip_core's note has always said "skip these if returning from injury" — nothing enforced it.
    const healthy = routineExerciseIds("hip_core");
    const injured = routineExerciseIds("hip_core", { activeInjury: true });
    expect(healthy.filter(id => DRILL_EXERCISE_IDS.has(id))).toHaveLength(3);
    expect(injured.filter(id => DRILL_EXERCISE_IDS.has(id))).toHaveLength(0);
    expect(injured).toHaveLength(healthy.length - 3);
  });

  it("leaves routines without drills untouched", () => {
    expect(routineExerciseIds("shin", { activeInjury: true })).toEqual(getRoutine("shin")!.exerciseIds);
  });

  it("returns nothing for an unknown key", () => {
    expect(routineExerciseIds("nonsense")).toEqual([]);
  });
});
