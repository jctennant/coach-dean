import { describe, it, expect, vi, beforeEach } from "vitest";
import { correctWeekToDateTotal } from "@/lib/week-to-date-correction";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("correctWeekToDateTotal", () => {
  it("rewrites a wrong week-to-date total", () => {
    const out = correctWeekToDateTotal("You've already logged 6.5 mi this week.", 20.31, false);
    expect(out).toBe("You've already logged 20.3 mi this week.");
  });

  it("leaves a correct total alone, within display rounding slack", () => {
    expect(correctWeekToDateTotal("You're at 20.3 mi this week.", 20.31, false))
      .toBe("You're at 20.3 mi this week.");
    expect(correctWeekToDateTotal("You're at 20 miles this week.", 20.31, false))
      .toBe("You're at 20 miles this week.");
  });

  it("skips projection phrasings — correctProjectedTotal owns those", () => {
    const msg = "That puts you on track for 30 mi this week.";
    expect(correctWeekToDateTotal(msg, 20.31, false)).toBe(msg);
  });

  it("does nothing when there's no system value", () => {
    const msg = "You've logged 6.5 mi this week.";
    expect(correctWeekToDateTotal(msg, null, false)).toBe(msg);
  });

  it("converts to km for metric athletes", () => {
    const out = correctWeekToDateTotal("You've logged 10 km this week.", 20.31, true);
    expect(out).toBe("You've logged 32.7 km this week.");
  });

  describe("requireCompletedContext (plan triggers)", () => {
    const opts = { requireCompletedContext: true };

    it("still corrects a claim marked as already run", () => {
      expect(correctWeekToDateTotal("You've already logged 6.5 mi this week.", 20.31, false, opts))
        .toBe("You've already logged 20.3 mi this week.");
      expect(correctWeekToDateTotal("You're at 6.5 mi this week so far.", 20.31, false, opts))
        .toBe("You're at 20.3 mi this week so far.");
      expect(correctWeekToDateTotal("That's 6.5 mi this week so far.", 20.31, false, opts))
        .toBe("That's 6.5 mi this week so far.");
    });

    it("leaves a planned weekly target alone", () => {
      const planned = "I'd aim for 16 mi this week, with a long run Saturday.";
      expect(correctWeekToDateTotal(planned, 20.31, false, opts)).toBe(planned);
      const target = "Next week: 16 mi this week is the target.";
      expect(correctWeekToDateTotal(target, 20.31, false, opts)).toBe(target);
    });

    it("corrects only the completed claim when a message has both", () => {
      const msg = "You've logged 6.5 mi this week. I'd aim for 16 mi this week total.";
      expect(correctWeekToDateTotal(msg, 20.31, false, opts))
        .toBe("You've logged 20.3 mi this week. I'd aim for 16 mi this week total.");
    });
  });
});
