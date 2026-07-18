import { describe, it, expect } from "vitest";
import { computeReturnToRunRamp } from "@/lib/injury-return";

describe("computeReturnToRunRamp", () => {
  it("returns null when there is no active hold", () => {
    expect(computeReturnToRunRamp(null, 40)).toBeNull();
  });

  it("uses 70% ramp for less than 2 weeks injured", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const holdSince = "2026-07-12"; // 6 days out → 1 week
    const ramp = computeReturnToRunRamp(holdSince, 40, now);
    expect(ramp?.weeksInjured).toBe(1);
    expect(ramp?.rampFactor).toBeCloseTo(0.70);
    expect(ramp?.returnBaseMiles).toBeCloseTo(28); // 40 * 0.70
  });

  it("uses 60% ramp for 2 weeks injured", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const holdSince = "2026-07-05"; // 13 days out → 2 weeks
    const ramp = computeReturnToRunRamp(holdSince, 40, now);
    expect(ramp?.weeksInjured).toBe(2);
    expect(ramp?.rampFactor).toBeCloseTo(0.60);
    expect(ramp?.returnBaseMiles).toBeCloseTo(24); // 40 * 0.60
  });

  it("uses 50% ramp for 3+ weeks injured", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const holdSince = "2026-06-20"; // 28 days out → 4 weeks
    const ramp = computeReturnToRunRamp(holdSince, 40, now);
    expect(ramp?.weeksInjured).toBe(4);
    expect(ramp?.rampFactor).toBeCloseTo(0.50);
    expect(ramp?.returnBaseMiles).toBeCloseTo(20); // 40 * 0.50
  });

  it("rounds returnBaseMiles to the nearest 0.5", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const holdSince = "2026-07-12";
    const ramp = computeReturnToRunRamp(holdSince, 33, now);
    // 33 * 0.70 = 23.1 → rounds to 23
    expect(ramp?.returnBaseMiles).toBe(23);
  });

  it("returns null returnBaseMiles when no pre-injury target is on file", () => {
    const ramp = computeReturnToRunRamp("2026-07-12", null, new Date("2026-07-18T00:00:00Z"));
    expect(ramp?.returnBaseMiles).toBeNull();
    expect(ramp?.weeksInjured).toBe(1);
  });

  it("returns null returnBaseMiles for a zero or negative pre-injury target", () => {
    const ramp = computeReturnToRunRamp("2026-07-12", 0, new Date("2026-07-18T00:00:00Z"));
    expect(ramp?.returnBaseMiles).toBeNull();
  });
});
