import { describe, it, expect } from "vitest";
import { typingDurationMs } from "@/lib/linq";

describe("typingDurationMs", () => {
  it("returns minimum 1500ms for very short messages", () => {
    expect(typingDurationMs(0)).toBe(1500);
    expect(typingDurationMs(10)).toBe(1500);
    expect(typingDurationMs(100)).toBe(1500);
  });

  it("scales with message length", () => {
    const short = typingDurationMs(100);
    const medium = typingDurationMs(300);
    const long = typingDurationMs(600);
    expect(medium).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(medium);
  });

  it("caps at 8000ms for very long messages", () => {
    expect(typingDurationMs(1000)).toBe(8000);
    expect(typingDurationMs(5000)).toBe(8000);
  });

  it("returns 8000ms at the cap boundary (800+ chars)", () => {
    expect(typingDurationMs(800)).toBe(8000);
  });

  it("500 chars → 5000ms", () => {
    expect(typingDurationMs(500)).toBe(5000);
  });
});
