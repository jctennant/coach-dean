import { describe, it, expect } from "vitest";
import { buildInitialPlanSchedule, type SchedulePlanWeek } from "@/lib/initial-plan-schedule";

// Sat Aug 8 2026, 18:00 UTC = 12:00 MDT. Week of Mon Aug 3; next week Mon Aug 10–Sun Aug 16.
const SAT = Date.UTC(2026, 7, 8, 18, 0, 0);
// Tue Aug 4 2026, 18:00 UTC — 6 days left in the current week.
const TUE = Date.UTC(2026, 7, 4, 18, 0, 0);

const weeks: SchedulePlanWeek[] = [
  { week_number: 1, mileage_target: 20, long_run_target: 7, key_workout: "Fartlek 5mi (varied 2-3 min pickups)" },
  { week_number: 2, mileage_target: 16, long_run_target: 8, key_workout: "Fartlek 6mi (varied 2-3 min pickups)" },
];

const base = {
  weeks,
  currentWeekNumber: 1,
  trainingDays: ["monday", "wednesday", "thursday", "saturday"],
  strengthDay: "Tue",
  crosstrainingTools: ["bike", "elliptical"],
  timezone: "America/Denver",
  isMetric: false,
  weekMileageSoFar: 0,
  avgWeeklyMileage: 25,
};

describe("buildInitialPlanSchedule", () => {
  it("shows next week when the current week's mileage budget is already met", () => {
    const out = buildInitialPlanSchedule({ ...base, nowMs: SAT, weekMileageSoFar: 20.3, avgWeeklyMileage: 8 });
    expect(out).toContain("Next week (Aug 10–16):");
    expect(out).toContain("Mon 8/10");
    expect(out).toContain("Sat 8/15");
    // Week 2's long run, not week 1's.
    expect(out).toContain("Long run 8mi");
  });

  it("shows next week when too few days remain in the current week", () => {
    const out = buildInitialPlanSchedule({ ...base, nowMs: SAT, weekMileageSoFar: 0 });
    expect(out).toContain("Next week (Aug 10–16):");
  });

  it("shows the rest of the current week when enough of it is left", () => {
    const out = buildInitialPlanSchedule({ ...base, nowMs: TUE, weekMileageSoFar: 4, avgWeeklyMileage: 25 });
    expect(out).toContain("Rest of this week:");
    // Tuesday onward only — Monday's session is in the past.
    expect(out).not.toContain("Mon 8/3");
    expect(out).toContain("Wed 8/5");
    expect(out).toContain("Sat 8/8");
  });

  it("lists one line per session with day, date and label", () => {
    const out = buildInitialPlanSchedule({ ...base, nowMs: SAT, weekMileageSoFar: 20.3, avgWeeklyMileage: 8 })!;
    const lines = out.split("\n").slice(1);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+\/\d+ — .+/);
  });

  it("renders distances in km for metric athletes", () => {
    const out = buildInitialPlanSchedule({ ...base, nowMs: SAT, isMetric: true, weekMileageSoFar: 20.3, avgWeeklyMileage: 8 })!;
    expect(out).toContain("Long run 12.9km");
    // key_workout text keeps whatever units it was generated in — see arcWeekSlotLabel.
    expect(out).toContain("Fartlek 6mi");
  });

  it("returns null when the athlete has no training days set", () => {
    expect(buildInitialPlanSchedule({ ...base, nowMs: SAT, trainingDays: [] })).toBeNull();
  });

  it("returns null when the wanted week isn't in the plan", () => {
    expect(buildInitialPlanSchedule({ ...base, nowMs: SAT, weeks: [weeks[0]], weekMileageSoFar: 20.3, avgWeeklyMileage: 8 }))
      .toBeNull();
    expect(buildInitialPlanSchedule({ ...base, nowMs: SAT, weeks: [] })).toBeNull();
  });

  it("does not treat a small week-to-date total as the budget being met", () => {
    const out = buildInitialPlanSchedule({ ...base, nowMs: TUE, weekMileageSoFar: 4, avgWeeklyMileage: 25 });
    expect(out).toContain("Rest of this week:");
  });
});
