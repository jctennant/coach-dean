import { describe, it, expect } from "vitest";
import {
  SHAPE_BUDGETS,
  SHAPE_NAMES,
  isMessageShape,
  resolveShape,
  checkShape,
  buildShapeCorrection,
  inferAthleteStyle,
} from "@/lib/message-shape";

describe("shape budgets", () => {
  it("exposes shapes ordered smallest to largest", () => {
    expect(SHAPE_NAMES).toEqual(["ack", "brief", "full"]);
    expect(SHAPE_BUDGETS.ack).toBeLessThan(SHAPE_BUDGETS.brief);
    expect(SHAPE_BUDGETS.brief).toBeLessThan(SHAPE_BUDGETS.full);
  });

  it("recognizes only known shape names", () => {
    expect(isMessageShape("brief")).toBe(true);
    expect(isMessageShape("BRIEF")).toBe(false);
    expect(isMessageShape("tiny")).toBe(false);
    expect(isMessageShape(undefined)).toBe(false);
  });
});

describe("resolveShape", () => {
  it("passes through a declared shape", () => {
    expect(resolveShape("ack")).toEqual({ shape: "ack", declared: true });
  });

  it("falls back to the LOOSEST shape when absent or invalid", () => {
    // Guessing tight on a missing field would truncate injury guidance, so an
    // undeclared shape must not become an enforced constraint.
    for (const bad of [undefined, null, "", "tiny", 3]) {
      expect(resolveShape(bad)).toEqual({ shape: "full", declared: false });
    }
  });
});

describe("checkShape", () => {
  it("passes a message within budget", () => {
    expect(checkShape("Nice work today.", "ack")).toBeNull();
  });

  it("passes a message inside the 10% grace band", () => {
    const justOver = "x".repeat(SHAPE_BUDGETS.ack + 5);
    expect(checkShape(justOver, "ack")).toBeNull();
  });

  it("flags a message past the grace band", () => {
    const over = "x".repeat(Math.ceil(SHAPE_BUDGETS.ack * 1.1) + 1);
    expect(checkShape(over, "ack")).toEqual({
      shape: "ack",
      budget: SHAPE_BUDGETS.ack,
      actual: over.length,
    });
  });

  it("measures the trimmed length", () => {
    const padded = `  ${"x".repeat(SHAPE_BUDGETS.ack)}  \n`;
    expect(checkShape(padded, "ack")).toBeNull();
  });

  it("judges each shape against its own budget", () => {
    const mid = "x".repeat(SHAPE_BUDGETS.brief);
    expect(checkShape(mid, "ack")).not.toBeNull();
    expect(checkShape(mid, "brief")).toBeNull();
    expect(checkShape(mid, "full")).toBeNull();
  });
});

describe("buildShapeCorrection", () => {
  it("names the overrun and protects safety content", () => {
    const text = buildShapeCorrection({ shape: "brief", budget: 320, actual: 700 });
    expect(text).toContain("brief");
    expect(text).toContain("320");
    expect(text).toContain("700");
    // A bare "make it shorter" is how an injury gate question gets dropped.
    expect(text.toLowerCase()).toContain("injury");
  });
});

describe("inferAthleteStyle", () => {
  it("returns null without enough signal", () => {
    expect(inferAthleteStyle([])).toBeNull();
    expect(inferAthleteStyle(["yep", "ok"])).toBeNull();
    expect(inferAthleteStyle(["   ", "", "  "])).toBeNull();
  });

  it("detects a terse texter and tells Dean to match it", () => {
    const block = inferAthleteStyle(["yep", "ok cool", "done"]);
    expect(block).toContain("Very terse");
    expect(block).toContain("one short line back");
  });

  it("detects a long-form texter", () => {
    const long = "I went out this morning and the whole thing felt genuinely harder than I expected from the very first mile onward";
    const block = inferAthleteStyle([long, long, long]);
    expect(block).toContain("longer, detailed messages");
  });

  it("mirrors emoji usage in both directions", () => {
    expect(inferAthleteStyle(["nice 🔥", "ok", "done"])).toContain("occasional one back");
    expect(inferAthleteStyle(["nice", "ok", "done"])).toContain("Don't use any");
  });

  it("only considers the most recent messages", () => {
    const oldLong = Array(10).fill("a really long message about how the run went this morning in detail");
    const block = inferAthleteStyle([...oldLong, "yep", "ok", "sure", "done", "cool", "yes", "no", "k"]);
    expect(block).toContain("Very terse");
  });
});
