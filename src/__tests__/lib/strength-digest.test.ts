import { describe, it, expect } from "vitest";
import {
  formatStrengthDigest,
  isStrengthDigest,
  exerciseIdsFromDigest,
  exerciseNamesAreUnambiguous,
  parseStrengthFollowUp,
} from "@/lib/strength-digest";
import { ROUTINES, getRoutine } from "@/lib/strength-library";
import { buildCadenceOffer } from "@/lib/cadence-offer";

const SHIN_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sun"];

describe("formatStrengthDigest", () => {
  it("fits every routine in the catalog inside one SMS bubble", () => {
    for (const routine of ROUTINES) {
      const digest = formatStrengthDigest({ routineKey: routine.key, days: ["Tue", "Fri"] });
      expect(digest, routine.key).not.toBeNull();
      expect(digest!.text.length, `${routine.key} digest length`).toBeLessThan(480);
    }
  });

  it("renders the routine with one line per exercise", () => {
    const digest = formatStrengthDigest({ routineKey: "shin", days: SHIN_DAYS, activeInjury: true })!;
    expect(digest.text).toContain("Shin splints routine — daily this week");
    expect(digest.text).toContain("› Toe taps on a stair — 2×20");
    expect(digest.exerciseIds).toEqual(getRoutine("shin")!.exerciseIds);
    expect(digest.truncated).toBe(false);
  });

  it("names the days when the routine isn't daily", () => {
    const digest = formatStrengthDigest({ routineKey: "hamstring", days: ["Tue", "Fri"] })!;
    expect(digest.text).toContain("2× this week (Tue/Fri)");
  });

  it("strips parenthetical qualifiers so lines stay short", () => {
    const digest = formatStrengthDigest({ routineKey: "calf", days: SHIN_DAYS })!;
    // "Eccentric heel drops off step — straight knee 3×15, bent knee 3×15" keeps its specs;
    // it's the NAME's trailing parenthetical that goes.
    expect(digest.text).not.toContain("(straight knee)");
  });

  it("drops the plyometric drills for an injured athlete", () => {
    const injured = formatStrengthDigest({ routineKey: "hip_core", days: ["Tue"], activeInjury: true })!;
    expect(injured.text).not.toContain("Bounding");
    expect(injured.text).not.toContain("A-skips");
  });

  it("uses an adapted exercise list when one is given", () => {
    const digest = formatStrengthDigest({
      routineKey: "shin",
      exerciseIds: ["toe_taps", "calf_stretch"],
      days: ["Tue", "Thu"],
    })!;
    expect(digest.exerciseIds).toEqual(["toe_taps", "calf_stretch"]);
    expect(digest.text).not.toContain("Ankle alphabet");
  });

  it("truncates rather than overflowing, and says how to get the rest", () => {
    const digest = formatStrengthDigest({ routineKey: "hip_core", days: ["Tue"], maxChars: 200 })!;
    expect(digest.truncated).toBe(true);
    expect(digest.text).toMatch(/\+\d+ more — ask me for the rest/);
    expect(digest.text.length).toBeLessThan(300);
  });

  it("returns null when there's no routine to render", () => {
    expect(formatStrengthDigest({ routineKey: null })).toBeNull();
    expect(formatStrengthDigest({ routineKey: "nonsense" })).toBeNull();
  });

  it("carries no dashboard link — SMS is the surface", () => {
    const digest = formatStrengthDigest({ routineKey: "shin", days: SHIN_DAYS })!;
    expect(digest.text).not.toContain("coachdean.ai");
    expect(digest.text).not.toContain("/plan/");
  });
});

describe("isStrengthDigest", () => {
  it("recognises a digest it produced", () => {
    for (const routine of ROUTINES) {
      const digest = formatStrengthDigest({ routineKey: routine.key, days: ["Tue"] })!;
      expect(isStrengthDigest(digest.text), routine.key).toBe(true);
    }
  });

  it("does not fire on other deterministic bubbles", () => {
    expect(isStrengthDigest(buildCadenceOffer({ activeInjury: false, bodyPart: null }))).toBe(false);
    expect(isStrengthDigest("Rest of this week:\nWed 8/12 — Easy 3mi")).toBe(false);
    expect(isStrengthDigest("Nice work today — that's your longest run in three weeks.")).toBe(false);
  });
});

describe("exerciseIdsFromDigest", () => {
  it("round-trips the exercises a digest listed", () => {
    const digest = formatStrengthDigest({ routineKey: "shin", days: SHIN_DAYS })!;
    expect(exerciseIdsFromDigest(digest.text)).toEqual(digest.exerciseIds);
  });

  it("round-trips an adapted list too", () => {
    const digest = formatStrengthDigest({
      routineKey: "knee",
      exerciseIds: ["vmo_quad_set", "step_down", "glute_bridge"],
      days: ["Tue", "Thu"],
    })!;
    expect(exerciseIdsFromDigest(digest.text)).toEqual(["vmo_quad_set", "step_down", "glute_bridge"]);
  });

  it("keeps exercise names unambiguous so the reverse lookup can't mis-illustrate", () => {
    // Guard: two exercises collapsing to the same shortened name would silently send the wrong
    // illustration. Adding such a pair to the catalog should fail here, loudly.
    expect(exerciseNamesAreUnambiguous()).toBe(true);
  });
});

describe("parseStrengthFollowUp", () => {
  const digest = formatStrengthDigest({ routineKey: "shin", days: SHIN_DAYS })!.text;

  it("accepts the ways athletes ask to see a movement", () => {
    for (const msg of ["how do I do that?", "show me", "what do these look like", "can I see pictures", "not sure how to do these"]) {
      expect(parseStrengthFollowUp(msg, digest), msg).not.toBeNull();
    }
  });

  it("accepts a bare yes, since the digest invites one", () => {
    for (const msg of ["yes", "yeah", "sure", "ok"]) {
      expect(parseStrengthFollowUp(msg, digest), msg).toEqual({ wantsImages: true });
    }
  });

  it("narrows to a single exercise when the athlete names one", () => {
    expect(parseStrengthFollowUp("how do I do the toe taps?", digest))
      .toEqual({ wantsImages: true, exerciseIds: ["toe_taps"] });
    expect(parseStrengthFollowUp("what does the soleus stretch look like", digest))
      .toEqual({ wantsImages: true, exerciseIds: ["soleus_stretch"] });
  });

  it("falls through to normal coaching for anything else", () => {
    for (const msg of [
      "can we move the long run to Saturday?",
      "I did my rehab today",
      "how many miles is my long run",
      "my shin hurt on that run",
    ]) {
      expect(parseStrengthFollowUp(msg, digest), msg).toBeNull();
    }
  });
});
