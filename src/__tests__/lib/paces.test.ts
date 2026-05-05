import { describe, it, expect } from "vitest";
import {
  calculateVDOTPaces,
  easyPaceRange,
  estimatePacesFromEasyPace,
} from "@/lib/paces";

describe("calculateVDOTPaces", () => {
  it("returns correctly formatted paces for a known performance", () => {
    // 5K in 20:00 (VDOT ~52.1)
    const result = calculateVDOTPaces(5, 20);
    // Easy should be slower than tempo, tempo slower than interval
    const parsePace = (p: string) => {
      const [min, sec] = p.replace("/mi", "").split(":").map(Number);
      return min * 60 + sec;
    };
    const easy = parsePace(result.easy);
    const tempo = parsePace(result.tempo);
    const interval = parsePace(result.interval);
    expect(easy).toBeGreaterThan(tempo);
    expect(tempo).toBeGreaterThan(interval);
    // 5K in 20:00 is VDOT ~49.8 per Jack Daniels formula
    expect(result.vdot).toBeGreaterThan(47);
    expect(result.vdot).toBeLessThan(53);
  });

  it("returns paces in M:SS/mi format", () => {
    const result = calculateVDOTPaces(42.195, 210); // ~3:30 marathon
    expect(result.easy).toMatch(/^\d+:\d{2}\/mi$/);
    expect(result.tempo).toMatch(/^\d+:\d{2}\/mi$/);
    expect(result.interval).toMatch(/^\d+:\d{2}\/mi$/);
  });

  it("faster race = lower (faster) pace values", () => {
    const parsePace = (p: string) => {
      const [min, sec] = p.replace("/mi", "").split(":").map(Number);
      return min * 60 + sec;
    };
    const fast = calculateVDOTPaces(5, 16); // 5K in 16:00 (elite)
    const slow = calculateVDOTPaces(5, 30); // 5K in 30:00 (beginner)
    expect(parsePace(fast.easy)).toBeLessThan(parsePace(slow.easy));
    expect(parsePace(fast.tempo)).toBeLessThan(parsePace(slow.tempo));
  });

  it("handles marathon performance", () => {
    // 4:00 marathon (VDOT ~37.8)
    const result = calculateVDOTPaces(42.195, 240);
    expect(result.vdot).toBeGreaterThan(35);
    expect(result.vdot).toBeLessThan(41);
  });

  it("never produces a :60 second rollover for any realistic VDOT", () => {
    // Sweep VDOTs 30–70 across all three intensities. A bug in paceAtVDOTPct
    // would surface as e.g. "6:60/mi" instead of "7:00/mi" for performances
    // that round just under a whole minute.
    for (let timeMin = 14; timeMin <= 35; timeMin += 0.1) {
      const result = calculateVDOTPaces(5, timeMin);
      for (const pace of [result.easy, result.tempo, result.interval]) {
        expect(pace).not.toMatch(/:60\/mi$/);
        expect(pace).toMatch(/^\d+:[0-5]\d\/mi$/);
      }
    }
  });
});

describe("easyPaceRange", () => {
  it("returns null for null input", () => {
    expect(easyPaceRange(null)).toBeNull();
  });

  it("returns imperial range with /mi suffix by default", () => {
    const result = easyPaceRange("9:00/mi");
    expect(result).toMatch(/\/mi$/);
    expect(result).toContain("–");
  });

  it("returns metric range with /km suffix when useMetric=true", () => {
    const result = easyPaceRange("9:00/mi", true);
    expect(result).toMatch(/\/km$/);
  });

  it("upper bound is 30 seconds faster than lower (rounded)", () => {
    const result = easyPaceRange("8:00/mi");
    // 8:00 rounds to 8:00 → range should be 8:00–8:30
    expect(result).toBe("8:00–8:30/mi");
  });

  it("rounds to nearest 5 seconds", () => {
    // 9:03 → rounds to 9:05
    const result = easyPaceRange("9:03/mi");
    expect(result).toMatch(/^9:05/);
  });

  it("returns the pace as-is if no parseable time", () => {
    const result = easyPaceRange("fast");
    expect(result).toBe("fast");
  });
});

describe("estimatePacesFromEasyPace", () => {
  it("returns null for null input", () => {
    expect(estimatePacesFromEasyPace(null)).toEqual({
      easy: null,
      tempo: null,
      interval: null,
    });
  });

  it("derives tempo 90s faster and interval 150s faster", () => {
    const result = estimatePacesFromEasyPace("9:00/mi");
    // 9:00 = 540s → tempo = 540-90 = 450s = 7:30, interval = 540-150 = 390s = 6:30
    expect(result.easy).toBe("9:00/mi");
    expect(result.tempo).toBe("7:30/mi");
    expect(result.interval).toBe("6:30/mi");
  });

  it("returns null tempo if easy is too slow (≤90s)", () => {
    // A 1:30 pace would be impossible, but test edge: 1:29 → tempo would be negative
    // Use a very slow pace: easy pace ≤ 1:30 → no tempo
    // Actually the condition is easySec > 90 for tempo
    // 1:31 = 91s → tempo = 91-90 = 1s = 0:01 (too fast to be real but non-null)
    // 1:30 = 90s → tempo: 90 > 90 is false → null
    const result = estimatePacesFromEasyPace("1:30/mi");
    expect(result.tempo).toBeNull();
    expect(result.interval).toBeNull();
  });

  it("returns formatted /mi pace strings", () => {
    const result = estimatePacesFromEasyPace("8:30/mi");
    expect(result.easy).toMatch(/\/mi$/);
    expect(result.tempo).toMatch(/\/mi$/);
    expect(result.interval).toMatch(/\/mi$/);
  });
});
