import { describe, it, expect } from "vitest";
import { computePaceContext } from "@/lib/coach-pace-context";

function base(overrides: Partial<Parameters<typeof computePaceContext>[0]> = {}) {
  return computePaceContext({
    easyPaceRaw: null,
    tempoPaceRaw: null,
    intervalPaceRaw: null,
    useMetric: false,
    ...overrides,
  });
}

describe("computePaceContext — no data", () => {
  it("returns TBD/null everywhere when there's no stored easy pace", () => {
    const ctx = base();
    expect(ctx.tempoPace).toBe("TBD");
    expect(ctx.intervalPace).toBe("TBD");
    expect(ctx.easyGuard).toBeNull();
    expect(ctx.tempoPaceGuard).toBeNull();
    expect(ctx.easyRange).toBeNull();
    expect(ctx.pacesAreSane).toBe(true);
  });
});

describe("computePaceContext — estimated from easy pace only", () => {
  it("derives tempo/interval estimates and marks them '(estimated)'", () => {
    const ctx = base({ easyPaceRaw: "8:00" });
    expect(ctx.tempoPace).toBe("6:30/mi (estimated)");
    expect(ctx.intervalPace).toBe("5:30/mi (estimated)");
    expect(ctx.easyGuard).toBe("8:00");
    expect(ctx.tempoPaceGuard).toBe("6:30/mi"); // no "(estimated)" suffix on the guard value
    expect(ctx.easyRange).toBe("8:00–8:30/mi");
    expect(ctx.pacesAreSane).toBe(true);
  });
});

describe("computePaceContext — stored paces", () => {
  it("uses stored tempo/interval verbatim, no '(estimated)' suffix", () => {
    const ctx = base({ easyPaceRaw: "8:00", tempoPaceRaw: "7:00", intervalPaceRaw: "6:30" });
    expect(ctx.tempoPace).toBe("7:00");
    expect(ctx.intervalPace).toBe("6:30");
    expect(ctx.tempoPaceGuard).toBe("7:00");
  });

  it("converts to /km when useMetric is true", () => {
    const ctx = base({ easyPaceRaw: "8:00", tempoPaceRaw: "7:00", intervalPaceRaw: "6:30", useMetric: true });
    expect(ctx.tempoPace).toBe("4:21/km");
    expect(ctx.intervalPace).toBe("4:02/km");
    expect(ctx.easyGuard).toBe("4:58/km");
    expect(ctx.easyRange).toBe("5:00–5:30/km");
  });
});

describe("computePaceContext — corrupted pace detection", () => {
  it("flags tempo slower than easy pace as INVALID and suppresses the guard", () => {
    const ctx = base({ easyPaceRaw: "8:00", tempoPaceRaw: "9:00", intervalPaceRaw: "6:30" });
    expect(ctx.pacesAreSane).toBe(false);
    expect(ctx.tempoPace).toContain("INVALID");
    expect(ctx.intervalPace).toContain("INVALID");
    expect(ctx.tempoPaceGuard).toBeNull();
    // easyGuard/easyRange are unaffected — they don't depend on the tempo sanity check
    expect(ctx.easyGuard).toBe("8:00");
    expect(ctx.easyRange).toBe("8:00–8:30/mi");
  });

  it("flags tempo slower than the 13:00/mi absolute floor even with no easy pace on file", () => {
    const ctx = base({ easyPaceRaw: null, tempoPaceRaw: "14:00" });
    expect(ctx.pacesAreSane).toBe(false);
  });

  it("boundary: exactly 30s faster than easy is still flagged (strictly more than 30s required)", () => {
    const ctx = base({ easyPaceRaw: "8:00", tempoPaceRaw: "7:30" });
    expect(ctx.pacesAreSane).toBe(false);
  });

  it("31s faster than easy passes the sanity check", () => {
    const ctx = base({ easyPaceRaw: "8:00", tempoPaceRaw: "7:29" });
    expect(ctx.pacesAreSane).toBe(true);
  });
});
