import { describe, it, expect } from "vitest";
import {
  predictRaceTime,
  estimateVDOT,
  predictTimeFromVDOT,
} from "@/lib/race-predictor";
import type { RacePredictionInput } from "@/lib/race-predictor";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

/** 5K in 17:30 (1050s) — workout_type=1 race, VDOT ~62 */
const race5K = {
  activity_type: "Run",
  distance_meters: 5000,
  moving_time_seconds: 1050,
  average_heartrate: 175,
  start_date: "2026-01-15T10:00:00Z",
  workout_type: 1 as number,
};

/** 5K in 17:30 as a best_effort on a tempo run (workout_type=0) */
const tempoWithBestEffort = {
  activity_type: "Run",
  distance_meters: 10000,
  moving_time_seconds: 2400,
  average_heartrate: 160,
  start_date: "2026-01-10T10:00:00Z",
  workout_type: 0 as number,
  best_efforts: [
    { name: "5k", elapsed_time: 1050, distance: 5000 },
    { name: "1 mile", elapsed_time: 310, distance: 1609 }, // too short, ignored
  ],
};

/** Easy run — no useful performance data */
const easyRun = {
  activity_type: "Run",
  distance_meters: 8000,
  moving_time_seconds: 2800,
  average_heartrate: 135,
  start_date: "2026-01-05T10:00:00Z",
  workout_type: 0 as number,
};

/** Long run ~13 miles at easy pace */
const longRun = {
  activity_type: "Run",
  distance_meters: 21000,
  moving_time_seconds: 6300, // 1:45 — ~8:00/mi pace
  average_heartrate: 145,
  start_date: "2026-01-12T08:00:00Z",
  workout_type: 0 as number,
};

function makeInput(
  overrides: Partial<RacePredictionInput> = {},
  activities: RacePredictionInput["activities"] = [race5K]
): RacePredictionInput {
  return {
    activities,
    goalDistanceMiles: 13.1,
    ...overrides,
  };
}

// ─── VDOT derivation ───────────────────────────────────────────────────────────

describe("estimateVDOT — VDOT derivation priority", () => {
  it("returns a plausible VDOT from a 5K race activity (workout_type=1)", () => {
    // 5K in 17:30 → VDOT ~58–63 depending on formula
    const { vdot, source } = estimateVDOT([race5K]);
    expect(vdot).not.toBeNull();
    expect(vdot!).toBeGreaterThan(55);
    expect(vdot!).toBeLessThan(66);
    expect(source).toContain("race");
  });

  it("derives a similar VDOT from best_efforts when no workout_type=1 activity exists", () => {
    // Same 5K time as a best_effort on a training run
    const { vdot, source } = estimateVDOT([tempoWithBestEffort]);
    expect(vdot).not.toBeNull();
    expect(vdot!).toBeGreaterThan(55);
    expect(vdot!).toBeLessThan(66);
    expect(source).toContain("best effort");
  });

  it("prefers workout_type=1 race over best_effort on same run", () => {
    // race5K is workout_type=1 with same time as tempoWithBestEffort's best effort
    const { source } = estimateVDOT([tempoWithBestEffort, race5K]);
    expect(source).toContain("race");
  });

  it("ignores best_efforts shorter than 4800m (mile effort)", () => {
    const activitiesOnlyMileBE = [
      {
        ...easyRun,
        best_efforts: [{ name: "1 mile", elapsed_time: 310, distance: 1609 }],
      },
    ];
    const { vdot } = estimateVDOT(activitiesOnlyMileBE);
    // Should not derive VDOT from the mile effort — no long run either, so null
    expect(vdot).toBeNull();
  });

  it("falls back to easy pace estimate when no race/effort data", () => {
    const { vdot, source } = estimateVDOT([], "9:30");
    expect(vdot).not.toBeNull();
    expect(source).toContain("easy pace");
  });

  it("falls back to long run estimate when no race/effort/easy-pace", () => {
    const { vdot, source } = estimateVDOT([longRun]);
    expect(vdot).not.toBeNull();
    expect(source).toContain("long run");
  });

  it("returns null when there is no usable data", () => {
    const { vdot } = estimateVDOT([easyRun]);
    expect(vdot).toBeNull();
  });

  it("explicit recentRaceDistKm/recentRaceTimeMinutes wins over all activities", () => {
    // race5K gives ~VDOT 62. Explicit 10K in 35min gives ~VDOT 65.
    const result = predictRaceTime({
      activities: [race5K],
      goalDistanceMiles: 13.1,
      recentRaceDistKm: 10,
      recentRaceTimeMinutes: 35,
    });
    // VDOT should be closer to 65 than 62 — half time will be notably faster
    const fromActivity = predictRaceTime({ activities: [race5K], goalDistanceMiles: 13.1 });
    expect(result!.predictedMinutes).toBeLessThan(fromActivity!.predictedMinutes);
  });
});

// ─── predictTimeFromVDOT / Riegel exponent ─────────────────────────────────────

describe("predictTimeFromVDOT — Riegel exponent scaling", () => {
  it("returns a reasonable half marathon time for VDOT 60", () => {
    const min = predictTimeFromVDOT(60, 13.1);
    expect(min).not.toBeNull();
    // VDOT 60 ≈ 1:21–1:25 half
    expect(min!).toBeGreaterThan(79);
    expect(min!).toBeLessThan(90);
  });

  it("scales slower for 50K than linear Riegel from marathon", () => {
    const marathon = predictTimeFromVDOT(55, 26.2)!;
    const fiftyk    = predictTimeFromVDOT(55, 31.1)!;
    // 50K with exponent 1.10 should be disproportionately slower than marathon
    const linearRatio = 31.1 / 26.2;
    const actualRatio = fiftyk / marathon;
    expect(actualRatio).toBeGreaterThan(linearRatio);
  });

  it("scales even slower for 50mi vs 50K (higher exponent)", () => {
    const fiftyk = predictTimeFromVDOT(55, 31.1)!;
    const fiftyMi = predictTimeFromVDOT(55, 50)!;
    const linearRatio50 = 50 / 31.1;
    const actualRatio = fiftyMi / fiftyk;
    expect(actualRatio).toBeGreaterThan(linearRatio50);
  });

  it("returns null for VDOT out of usable range", () => {
    // predictRaceTime returns null for VDOT < 20
    const result = predictRaceTime({ activities: [], goalDistanceMiles: 13.1 });
    expect(result).toBeNull();
  });
});

// ─── Elevation penalties ───────────────────────────────────────────────────────

describe("predictRaceTime — elevation gain penalty", () => {
  // 10-mile race → 10 * 5280 = 52,800 ft of horizontal distance

  it("applies 1.0 min/1000ft for road races", () => {
    const flat  = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "road" }))!;
    const hilly = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "road", elevationGainFeet: 2000 }))!;
    const diff = hilly.predictedMinutes - flat.predictedMinutes;
    expect(diff).toBeCloseTo(2.0, 0); // 2 × 1.0 = 2 min
  });

  it("applies 1.5 min/1000ft for trail races at <10% avg grade", () => {
    // 10-mile trail, 1000ft gain → avg grade ≈ 1.9% (< 10%) → +1.5 min
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "trail", trailSubtype: "groomed", elevationGainFeet: 1000 }))!;
    // The factor string records the exact penalty: "+1.5 min — 1,000ft gain"
    expect(pred.factors.some(f => f.includes("+1.5 min"))).toBe(true);
    expect(pred.factors.some(f => f.includes("1.5 min/1000ft"))).toBe(true);
  });

  it("applies 2.0 min/1000ft for trail races at >10% avg grade", () => {
    // 10-mile trail, 6000ft gain → avg grade ≈ 11.4% (> 10%) → 6 × 2.0 = +12 min
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "trail", trailSubtype: "groomed", elevationGainFeet: 6000 }))!;
    expect(pred.factors.some(f => f.includes("+12.0 min"))).toBe(true);
    expect(pred.factors.some(f => f.includes("2.0 min/1000ft"))).toBe(true);
  });

  it("does not apply gain penalty for < 100ft of gain", () => {
    const flat  = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "road", elevationGainFeet: 0 }))!;
    const tiny  = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "road", elevationGainFeet: 50 }))!;
    expect(flat.predictedMinutes).toEqual(tiny.predictedMinutes);
  });
});

describe("predictRaceTime — steep descent penalty", () => {
  it("adds descent penalty when avg descent grade > 12%", () => {
    // 10-mile race, 8000ft descent → avg = 8000/52800 ≈ 15.2% > 12%
    const noDescent = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "trail", trailSubtype: "groomed" }))!;
    const steep     = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "trail", trailSubtype: "groomed", elevationLossFeet: 8000 }))!;
    const diff = steep.predictedMinutes - noDescent.predictedMinutes;
    expect(diff).toBeCloseTo(4.0, 0); // 8 × 0.5 = 4 min
  });

  it("does NOT add descent penalty when avg grade <= 12%", () => {
    // 10-mile race, 2000ft descent → avg = 2000/52800 ≈ 3.8% < 12%
    const noDescent = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "road" }))!;
    const gentle    = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "road", elevationLossFeet: 2000 }))!;
    expect(noDescent.predictedMinutes).toEqual(gentle.predictedMinutes);
  });
});

// ─── Trail terrain penalty ─────────────────────────────────────────────────────

describe("predictRaceTime — trail terrain subtypes", () => {
  const baseInput = makeInput({ goalDistanceMiles: 13.1, terrainType: "road" });

  function trailPred(subtype: "groomed" | "mixed" | "technical" | "highly_technical") {
    return predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "trail", trailSubtype: subtype }))!;
  }

  it("applies increasing penalties across the four subtypes", () => {
    const road           = predictRaceTime(baseInput)!;
    const groomed        = trailPred("groomed");
    const mixed          = trailPred("mixed");
    const technical      = trailPred("technical");
    const highlyTech     = trailPred("highly_technical");

    expect(groomed.predictedMinutes).toBeGreaterThan(road.predictedMinutes);
    expect(mixed.predictedMinutes).toBeGreaterThan(groomed.predictedMinutes);
    expect(technical.predictedMinutes).toBeGreaterThan(mixed.predictedMinutes);
    expect(highlyTech.predictedMinutes).toBeGreaterThan(technical.predictedMinutes);
  });

  it("groomed adds exactly 10% to base time", () => {
    const road    = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }))!;
    const groomed = trailPred("groomed");
    // groomed = base * 0.10 — check the delta is ~10% of road (road ≈ base)
    expect(groomed.predictedMinutes - road.predictedMinutes).toBeCloseTo(road.predictedMinutes * 0.10, 0);
  });

  it("highly_technical adds exactly 35% to base time", () => {
    const road = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }))!;
    const ht   = trailPred("highly_technical");
    expect(ht.predictedMinutes - road.predictedMinutes).toBeCloseTo(road.predictedMinutes * 0.35, 0);
  });

  it("applies 8% mixed terrain adjustment (terrainType=mixed, no subtype)", () => {
    const road  = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }))!;
    const mixed = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "mixed" }))!;
    expect(mixed.predictedMinutes - road.predictedMinutes).toBeCloseTo(road.predictedMinutes * 0.08, 0);
  });
});

describe("inferTrailSubtype — gain per mile thresholds", () => {
  it("infers groomed when gain/mile <= 250", () => {
    // 10 miles, 2000ft gain → 200 ft/mi → groomed
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "trail", elevationGainFeet: 2000 }))!;
    expect(pred.factors.some(f => f.includes("groomed"))).toBe(true);
  });

  it("infers mixed when gain/mile is 251–500", () => {
    // 10 miles, 3000ft gain → 300 ft/mi → mixed
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "trail", elevationGainFeet: 3000 }))!;
    expect(pred.factors.some(f => f.includes("mixed"))).toBe(true);
  });

  it("infers technical when gain/mile > 500", () => {
    // 10 miles, 6000ft gain → 600 ft/mi → technical
    // (note: this also triggers the > 10% grade path for gain penalty)
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 10, terrainType: "trail", elevationGainFeet: 6000 }))!;
    expect(pred.factors.some(f => f.includes("technical"))).toBe(true);
  });
});

// ─── Heat + humidity penalty ───────────────────────────────────────────────────

describe("predictRaceTime — heat penalty", () => {
  it("applies no penalty at 75°F (boundary)", () => {
    const cool = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, expectedTempF: 70 }))!;
    const boundary = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, expectedTempF: 75 }))!;
    expect(cool.predictedMinutes).toEqual(boundary.predictedMinutes);
  });

  it("applies 2% per 5°F in tier 1 (75–85°F) — e.g. 80°F → 2%", () => {
    const cool = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }))!;
    const hot  = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road", expectedTempF: 80 }))!;
    // 80°F: tier1 = 5°F → (5/5)*0.02 = 2% of base
    const diff = hot.predictedMinutes - cool.predictedMinutes;
    expect(diff).toBeCloseTo(cool.predictedMinutes * 0.02, 0);
  });

  it("stacks tier 2 penalty (85–95°F) at 3.5% per 5°F — e.g. 90°F → 7.5%", () => {
    const cool = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }))!;
    const hot  = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road", expectedTempF: 90 }))!;
    // 90°F: tier1 = 10°F → 4%, tier2 = 5°F → 3.5%, total = 7.5%
    const diff = hot.predictedMinutes - cool.predictedMinutes;
    expect(diff).toBeCloseTo(cool.predictedMinutes * 0.075, 0);
  });

  it("adds 1.5% humidity modifier when humidity > 70%", () => {
    const hot      = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road", expectedTempF: 80 }))!;
    const hotHumid = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road", expectedTempF: 80, expectedHumidityPct: 85 }))!;
    // Extra 1.5% on top of the 2% heat
    const diff = hotHumid.predictedMinutes - hot.predictedMinutes;
    expect(diff).toBeGreaterThan(0);
    // Humidity adds ~1.5% of base
    const base = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }))!;
    expect(diff).toBeCloseTo(base.predictedMinutes * 0.015, 0);
  });

  it("does not add humidity modifier when humidity <= 70%", () => {
    const hot     = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road", expectedTempF: 80 }))!;
    const okHumid = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road", expectedTempF: 80, expectedHumidityPct: 65 }))!;
    expect(hot.predictedMinutes).toEqual(okHumid.predictedMinutes);
  });

  it("caps total heat penalty at 15%", () => {
    const base    = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }))!;
    const extreme = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road", expectedTempF: 110, expectedHumidityPct: 95 }))!;
    const diff = extreme.predictedMinutes - base.predictedMinutes;
    // Max is 15% of base
    expect(diff).toBeLessThanOrEqual(base.predictedMinutes * 0.15 + 1);
  });
});

// ─── Altitude penalty ─────────────────────────────────────────────────────────

describe("predictRaceTime — altitude penalty", () => {
  it("applies no penalty at or below 5000ft", () => {
    const low  = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, raceAltitudeFt: 4999 }))!;
    const base = predictRaceTime(makeInput({ goalDistanceMiles: 13.1 }))!;
    expect(low.predictedMinutes).toEqual(base.predictedMinutes);
  });

  it("applies 2% per 1000ft above 5000ft — e.g. 6000ft → 2%", () => {
    const base = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }))!;
    const alt  = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road", raceAltitudeFt: 6000 }))!;
    const diff = alt.predictedMinutes - base.predictedMinutes;
    expect(diff).toBeCloseTo(base.predictedMinutes * 0.02, 0);
  });

  it("caps altitude penalty at 10%", () => {
    const base   = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }))!;
    const high   = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road", raceAltitudeFt: 20000 }))!;
    const diff = high.predictedMinutes - base.predictedMinutes;
    expect(diff).toBeLessThanOrEqual(base.predictedMinutes * 0.10 + 1);
  });

  it("sets altitudeFlagged caveat when race altitude > 3000ft above training altitude", () => {
    const pred = predictRaceTime(makeInput({
      goalDistanceMiles: 13.1,
      raceAltitudeFt: 10000,
      trainingAltitudeFt: 500,
    }))!;
    expect(pred.caveat).toContain("altitude");
  });

  it("does NOT set altitude caveat when gap is <= 3000ft", () => {
    const pred = predictRaceTime(makeInput({
      goalDistanceMiles: 13.1,
      raceAltitudeFt: 8000,
      trainingAltitudeFt: 5500, // gap = 2500ft
    }))!;
    // caveat may exist for other reasons, but altitude part should not
    expect(pred.caveat ?? "").not.toContain("altitude");
  });
});

// ─── Distance mismatch ────────────────────────────────────────────────────────

describe("predictRaceTime — VDOT distance mismatch", () => {
  it("widens the range when goal race > 2× source distance", () => {
    // race5K is VDOT source ~5km. Predicting 50mi = >2× → mismatch
    const halfPred   = predictRaceTime(makeInput({ goalDistanceMiles: 13.1 }))!;
    const ultraPred  = predictRaceTime(makeInput({ goalDistanceMiles: 50 }))!;
    const halfSpread = halfPred.highMinutes - halfPred.lowMinutes;
    const ultraSpread = ultraPred.highMinutes - ultraPred.lowMinutes;
    // Ultra spread should be wider as a fraction of predicted time
    const halfSpreadPct  = halfSpread  / halfPred.predictedMinutes;
    const ultraSpreadPct = ultraSpread / ultraPred.predictedMinutes;
    expect(ultraSpreadPct).toBeGreaterThan(halfSpreadPct);
  });
});

// ─── Source labels ────────────────────────────────────────────────────────────

describe("predictRaceTime — sourceLabel", () => {
  it("labels as 'Based on recent race' for workout_type=1 activity", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 13.1 }, [race5K]))!;
    expect(pred.sourceLabel).toBe("Based on recent race");
  });

  it("labels as 'Based on training data' for best_effort source", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 13.1 }, [tempoWithBestEffort]))!;
    expect(pred.sourceLabel).toBe("Based on training data");
  });

  it("labels as 'Estimated from easy pace' for storedEasyPace fallback", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, storedEasyPace: "9:30" }, []))!;
    expect(pred.sourceLabel).toBe("Estimated from easy pace");
  });

  it("labels as 'Estimated from long runs' for long run fallback", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 13.1 }, [longRun]))!;
    expect(pred.sourceLabel).toBe("Estimated from long runs");
  });
});

// ─── Caveats ──────────────────────────────────────────────────────────────────

describe("predictRaceTime — caveats", () => {
  it("trail race gets 'Trail factors may shift this significantly'", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "trail", trailSubtype: "mixed" }))!;
    expect(pred.caveat).toContain("Trail factors");
  });

  it("highly_technical terrain gets 'Course terrain adds meaningful uncertainty'", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "trail", trailSubtype: "highly_technical" }))!;
    expect(pred.caveat).toContain("uncertainty");
  });

  it("ultra with distance mismatch gets ultra caveat", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 50 }))!; // 5K source → 50mi target
    expect(pred.caveat).toContain("Ultra-specific");
  });

  it("short road race with good data has no caveat", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 13.1, terrainType: "road" }, [race5K]))!;
    expect(pred.caveat).toBeNull();
  });
});

// ─── Range label ──────────────────────────────────────────────────────────────

describe("predictRaceTime — rangeLabel", () => {
  it("always returns 'Likely finish window'", () => {
    const pred = predictRaceTime(makeInput())!;
    expect(pred.rangeLabel).toBe("Likely finish window");
  });
});

// ─── Null / edge cases ────────────────────────────────────────────────────────

describe("predictRaceTime — edge cases", () => {
  it("returns null when there are no activities and no fallback data", () => {
    const pred = predictRaceTime({ activities: [], goalDistanceMiles: 13.1 });
    expect(pred).toBeNull();
  });

  it("returns a valid prediction for a marathon", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 26.2 }));
    expect(pred).not.toBeNull();
    expect(pred!.predictedMinutes).toBeGreaterThan(120); // slower than 2:00
    expect(pred!.predictedMinutes).toBeLessThan(300);   // faster than 5:00
  });

  it("returns a valid prediction for a 5K", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 3.107 }));
    expect(pred).not.toBeNull();
    expect(pred!.predictedMinutes).toBeGreaterThan(14);
    expect(pred!.predictedMinutes).toBeLessThan(30);
  });

  it("low <= predicted <= high always holds", () => {
    const pred = predictRaceTime(makeInput({
      goalDistanceMiles: 26.2,
      terrainType: "trail",
      trailSubtype: "technical",
      elevationGainFeet: 5000,
      expectedTempF: 85,
      raceAltitudeFt: 7000,
    }))!;
    expect(pred.lowMinutes).toBeLessThanOrEqual(pred.predictedMinutes);
    expect(pred.predictedMinutes).toBeLessThanOrEqual(pred.highMinutes);
  });
});

// ─── Mountain subtype (no course record) ─────────────────────────────────────

describe("predictRaceTime — mountain subtype (VDOT fallback)", () => {
  it("mountain subtype adds ~65% penalty to base time", () => {
    const road     = predictRaceTime(makeInput({ goalDistanceMiles: 5.5, terrainType: "road" }))!;
    const mountain = predictRaceTime(makeInput({ goalDistanceMiles: 5.5, terrainType: "trail", trailSubtype: "mountain" }))!;
    // Mountain penalty is ~65% of base. Both predictedMinutes are Math.round'd, so allow ±2 min tolerance.
    const expected = road.predictedMinutes * 0.65;
    const actual   = mountain.predictedMinutes - road.predictedMinutes;
    expect(actual).toBeGreaterThanOrEqual(expected - 2);
    expect(actual).toBeLessThanOrEqual(expected + 2);
  });

  it("mountain is slower than highly_technical (65% vs 35% penalty)", () => {
    const ht       = predictRaceTime(makeInput({ goalDistanceMiles: 5.5, terrainType: "trail", trailSubtype: "highly_technical" }))!;
    const mountain = predictRaceTime(makeInput({ goalDistanceMiles: 5.5, terrainType: "trail", trailSubtype: "mountain" }))!;
    expect(mountain.predictedMinutes).toBeGreaterThan(ht.predictedMinutes);
  });

  it("caveat mentions 'no course record' for mountain without course record", () => {
    const pred = predictRaceTime(makeInput({ goalDistanceMiles: 5.5, terrainType: "trail", trailSubtype: "mountain" }))!;
    expect(pred.caveat).toContain("No course record");
  });

  it("low <= predicted <= high for mountain VDOT path", () => {
    const pred = predictRaceTime(makeInput({
      goalDistanceMiles: 5.5,
      terrainType: "trail",
      trailSubtype: "mountain",
      elevationGainFeet: 3000,
      raceAltitudeFt: 9000,
    }))!;
    expect(pred.lowMinutes).toBeLessThanOrEqual(pred.predictedMinutes);
    expect(pred.predictedMinutes).toBeLessThanOrEqual(pred.highMinutes);
  });
});

// ─── Course record projection ─────────────────────────────────────────────────

describe("predictRaceTime — course record projection", () => {
  // Cirque Snowbird-style: ~5.5mi mountain race, course record 82min
  const crInput = (vdotActivities: typeof race5K[] = [race5K]) =>
    makeInput({ goalDistanceMiles: 5.5, terrainType: "trail", trailSubtype: "mountain", courseRecordMinutes: 82 }, vdotActivities);

  it("uses course record path and labels sourceLabel as 'Based on course record'", () => {
    const pred = predictRaceTime(crInput())!;
    expect(pred.sourceLabel).toBe("Based on course record");
  });

  it("projected time is substantially slower than course record", () => {
    // VDOT ~62 (from race5K 17:30) → multiplier ~1.22 → ~100 min
    const pred = predictRaceTime(crInput())!;
    expect(pred.predictedMinutes).toBeGreaterThan(82); // always slower than CR
    expect(pred.predictedMinutes).toBeGreaterThan(90); // significantly slower
  });

  it("course record projection does NOT add separate terrain penalty factor", () => {
    const pred = predictRaceTime(crInput())!;
    // Terrain penalty is baked into the CR multiplier — no "+X% trail penalty" factor
    expect(pred.factors.every(f => !f.includes("trail penalty"))).toBe(true);
  });

  it("factors include '% back from course record' narrative", () => {
    const pred = predictRaceTime(crInput())!;
    expect(pred.factors.some(f => f.includes("% back"))).toBe(true);
    expect(pred.factors.some(f => f.includes("Course record"))).toBe(true);
  });

  it("lower VDOT gives larger multiplier (slower projected time)", () => {
    // race5K VDOT ~62 vs longRun VDOT ~low 40s (rough estimate from long run)
    const highVdotPred = predictRaceTime(crInput([race5K]))!;
    const lowVdotPred  = predictRaceTime(crInput([longRun]))!;
    expect(lowVdotPred.predictedMinutes).toBeGreaterThan(highVdotPred.predictedMinutes);
  });

  it("heat penalty still applies on top of course record projection", () => {
    const cool = predictRaceTime(crInput())!;
    const hot  = predictRaceTime({
      activities: [race5K],
      goalDistanceMiles: 5.5,
      terrainType: "trail",
      trailSubtype: "mountain",
      courseRecordMinutes: 82,
      expectedTempF: 90,
    })!;
    expect(hot.predictedMinutes).toBeGreaterThan(cool.predictedMinutes);
  });

  it("altitude penalty still applies on top of course record projection", () => {
    const lowAlt  = predictRaceTime(crInput())!;
    const highAlt = predictRaceTime({
      activities: [race5K],
      goalDistanceMiles: 5.5,
      terrainType: "trail",
      trailSubtype: "mountain",
      courseRecordMinutes: 82,
      raceAltitudeFt: 9000,
    })!;
    expect(highAlt.predictedMinutes).toBeGreaterThan(lowAlt.predictedMinutes);
  });

  it("course record path works for highly_technical subtype", () => {
    const pred = predictRaceTime(makeInput({
      goalDistanceMiles: 13.1,
      terrainType: "trail",
      trailSubtype: "highly_technical",
      courseRecordMinutes: 150,
    }))!;
    expect(pred.sourceLabel).toBe("Based on course record");
    expect(pred.predictedMinutes).toBeGreaterThan(150);
  });

  it("low <= predicted <= high for course record path", () => {
    const pred = predictRaceTime(crInput())!;
    expect(pred.lowMinutes).toBeLessThanOrEqual(pred.predictedMinutes);
    expect(pred.predictedMinutes).toBeLessThanOrEqual(pred.highMinutes);
  });

  it("does NOT use course record projection for road terrain", () => {
    // Course record provided but terrain is road — should use VDOT path
    const pred = predictRaceTime(makeInput({
      goalDistanceMiles: 13.1,
      terrainType: "road",
      courseRecordMinutes: 60,
    }))!;
    expect(pred.sourceLabel).not.toBe("Based on course record");
  });

  it("narrative references the course record time and % back", () => {
    const pred = predictRaceTime(crInput())!;
    expect(pred.narrative).toContain("Course record");
    expect(pred.narrative).toContain("% back");
  });
});
