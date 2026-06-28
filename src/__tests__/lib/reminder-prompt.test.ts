import { describe, it, expect } from "vitest";
import { buildReminderDynamic, ReminderContext } from "@/lib/reminder-prompt";

function baseCtx(overrides: Partial<ReminderContext> = {}): ReminderContext {
  return {
    trigger: "nightly_reminder",
    athleteName: "Alex",
    goal: "marathon",
    raceDate: "2026-10-15",
    raceName: "Chicago Marathon",
    daysUntilRace: 109,
    secondaryRaces: [],
    todayStr: "Sunday, June 28",
    timezone: "America/Chicago",
    weekNumber: 8,
    totalWeeks: 18,
    phase: "base",
    weeklyMileageTarget: 40,
    weekMileageSoFar: 22,
    plannedSessions: [
      { day: "Monday", date: "Jun 30", label: "Rest" },
      { day: "Tuesday", date: "Jul 1", label: "Easy 6mi" },
    ],
    injuryNotes: null,
    injuryHoldActive: false,
    recentMessages: [],
    preferredUnits: "miles",
    ...overrides,
  };
}

describe("buildReminderDynamic", () => {
  it("includes athlete name and goal", () => {
    const result = buildReminderDynamic(baseCtx());
    expect(result).toContain("Alex");
    expect(result).toContain("marathon");
  });

  it("includes today's date and timezone", () => {
    const result = buildReminderDynamic(baseCtx());
    expect(result).toContain("Sunday, June 28");
    expect(result).toContain("America/Chicago");
  });

  it("includes race countdown when raceDate is set", () => {
    const result = buildReminderDynamic(baseCtx());
    expect(result).toContain("Chicago Marathon");
    expect(result).toContain("109 days away");
  });

  it("omits race countdown when raceDate is null", () => {
    const result = buildReminderDynamic(baseCtx({ raceDate: null, raceName: null, daysUntilRace: null }));
    expect(result).not.toContain("days away");
  });

  it("includes week number and mileage target", () => {
    const result = buildReminderDynamic(baseCtx());
    expect(result).toContain("Week 8");
    expect(result).toContain("40");
    expect(result).toContain("22");
  });

  it("includes planned sessions", () => {
    const result = buildReminderDynamic(baseCtx());
    expect(result).toContain("Easy 6mi");
    expect(result).toContain("Tuesday");
  });

  it("does NOT include training philosophy or VDOT content", () => {
    const result = buildReminderDynamic(baseCtx());
    expect(result).not.toContain("TRAINING PHILOSOPHY");
    expect(result).not.toContain("aerobic efficiency");
    expect(result).not.toContain("VDOT");
  });

  it("includes output contract", () => {
    const result = buildReminderDynamic(baseCtx());
    expect(result).toContain("OUTPUT CONTRACT");
    expect(result).toContain("NO SIGN-OFFS");
  });

  it("handles km units by showing km label in target block", () => {
    const result = buildReminderDynamic(baseCtx({ preferredUnits: "km" }));
    expect(result).toContain("km");
  });

  describe("injury handling", () => {
    it("shows injury hold active message and omits plan block", () => {
      const result = buildReminderDynamic(baseCtx({ injuryHoldActive: true }));
      expect(result).toContain("INJURY HOLD ACTIVE");
      expect(result).not.toContain("Week 8");
    });

    it("shows injury notes without hold", () => {
      const result = buildReminderDynamic(baseCtx({ injuryNotes: "Left knee — IT band" }));
      expect(result).toContain("Left knee — IT band");
    });
  });

  describe("secondary races", () => {
    it("injects B RACE mini-taper note when ≤14 days away", () => {
      const ctx = baseCtx({
        secondaryRaces: [{
          race_name: "Spring Half",
          race_date: "2026-07-08",
          priority: "B",
          daysUntilRace: 10,
        }],
      });
      const result = buildReminderDynamic(ctx);
      expect(result).toContain("B RACE");
      expect(result).toContain("Spring Half");
      expect(result).toContain("10-15%");
    });

    it("lists B race without taper guidance when >14 days away", () => {
      const ctx = baseCtx({
        secondaryRaces: [{
          race_name: "Spring Half",
          race_date: "2026-07-28",
          priority: "B",
          daysUntilRace: 30,
        }],
      });
      const result = buildReminderDynamic(ctx);
      expect(result).toContain("Upcoming B race");
      expect(result).toContain("Spring Half");
      expect(result).not.toContain("10-15%");
    });

    it("injects C RACE note when ≤7 days away", () => {
      const ctx = baseCtx({
        secondaryRaces: [{
          race_name: "Local 5K",
          race_date: "2026-07-02",
          priority: "C",
          daysUntilRace: 4,
        }],
      });
      const result = buildReminderDynamic(ctx);
      expect(result).toContain("C RACE");
      expect(result).toContain("Local 5K");
      expect(result).toContain("quality workout");
    });

    it("does not include B/C content when secondaryRaces is empty", () => {
      const result = buildReminderDynamic(baseCtx({ secondaryRaces: [] }));
      expect(result).not.toContain("B RACE");
      expect(result).not.toContain("C RACE");
      expect(result).not.toContain("Upcoming B race");
    });
  });
});
