import { describe, it, expect } from "vitest";
import { parseSessionMiles } from "@/lib/session-mileage";

describe("parseSessionMiles", () => {
  it("parses a bare mileage figure", () => {
    expect(parseSessionMiles("Easy 5mi")).toBe(5);
  });

  it("prefers an explicit '≈X mi total' marker over the first bare figure", () => {
    expect(parseSessionMiles("Easy 5mi + strides ≈6mi total")).toBe(6);
  });

  it("prefers a parenthesized '(X mi total)' marker over the first bare figure", () => {
    expect(parseSessionMiles("Warm-up 1mi, 6x800m, cooldown 1mi (7mi total)")).toBe(7);
  });

  it("handles a '~X mi' marker", () => {
    expect(parseSessionMiles("Long run ~12mi")).toBe(12);
  });

  it("handles decimal mileage", () => {
    expect(parseSessionMiles("Tempo 6.5mi")).toBe(6.5);
  });

  it("falls back to km, converted to miles, when there's no mi marker", () => {
    expect(parseSessionMiles("Easy 8km")).toBeCloseTo(4.97, 2);
  });

  it("prefers an explicit '≈X km total' marker over the first bare km figure", () => {
    expect(parseSessionMiles("Easy 8km + strides ≈10km total")).toBeCloseTo(6.21, 2);
  });

  it("returns 0 for a session with no distance marker at all (e.g. rest, strength)", () => {
    expect(parseSessionMiles("Rest")).toBe(0);
    expect(parseSessionMiles("Strength — full body")).toBe(0);
  });

  it("does not misread '35 min' as 35 miles — the (?!n) guard", () => {
    expect(parseSessionMiles("Strength circuit, 35 min")).toBe(0);
  });

  it("does not misread 'min' inside an explicit-total marker as mileage", () => {
    expect(parseSessionMiles("Mobility work (35 min total)")).toBe(0);
  });
});
