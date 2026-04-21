/**
 * generateAndSaveFullPlan tests.
 *
 * Verifies that the plan arc saved to training_plans is consistent with:
 *  1. The race date (total_weeks derived correctly)
 *  2. The prescribedWeek1Miles option (training_state stays in sync with what
 *     Dean actually told the athlete over text — this prevents the dashboard
 *     showing a different mileage target than Dean's first message)
 *  3. The skipLinkSms flag suppresses the dashboard link SMS
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------- module mocks (must precede imports) ----------

vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));

vi.mock("@/lib/linq", () => ({
  sendSMS: vi.fn().mockResolvedValue({ chatId: "chat-123" }),
}));

vi.mock("@/lib/anthropic", () => ({
  anthropic: {
    messages: {
      // Return an empty enrichment array so the arc build completes cleanly.
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "[]" }],
      }),
    },
  },
}));

// ---------- imports ----------
import { generateAndSaveFullPlan } from "@/lib/training-plan";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";

// ---------- helpers ----------

/**
 * Build a thenable/chainable Supabase mock for a single table.
 * All query-builder methods (select, insert, update, eq, …) return the same
 * object so the chain can be freely traversed.  Awaiting the chain resolves
 * with `response` via the `then` shim.
 */
function chain(response: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "update", "upsert", "delete",
    "eq", "neq", "is", "not", "gte", "lte", "in", "or", "order", "limit",
  ];
  for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
  c["single"] = vi.fn().mockResolvedValue(response);
  c["maybeSingle"] = vi.fn().mockResolvedValue(response);
  c["then"] = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(response).then(resolve, reject);
  return c;
}

// Fixed point-in-time used by all tests so week calculations are deterministic.
// 2026-03-27T00:00:00Z  →  "today" for these tests.
const FIXED_NOW = new Date("2026-03-27T00:00:00Z");

// 2026-07-31T12:00:00Z is 126.5 days from FIXED_NOW → 18.07 weeks → Math.ceil = 19.
const RACE_18W = "2026-07-31";

// 2026-06-19T12:00:00Z is 84.5 days from FIXED_NOW → 12.07 weeks → Math.ceil = 13.
const RACE_12W = "2026-06-19";

// ---------- default profile used across tests ----------

function baseProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: "trail_race",
    days_per_week: 4,
    current_easy_pace: "9:30",
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// total_weeks calculation
// -----------------------------------------------------------------------

describe("generateAndSaveFullPlan — total_weeks from race date", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("stores total_weeks = 18 when race is 18 weeks away", async () => {
    let insertedPlan: unknown;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_plans") {
        (c.insert as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) => {
          insertedPlan = args;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      { skipLinkSms: true },
    );

    expect((insertedPlan as Record<string, unknown>).total_weeks).toBe(19);
  });

  it("stores total_weeks = 13 when race is ~12 weeks away", async () => {
    let insertedPlan: unknown;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_plans") {
        (c.insert as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) => {
          insertedPlan = args;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_12W }),
      25,
      { skipLinkSms: true },
    );

    expect((insertedPlan as Record<string, unknown>).total_weeks).toBe(13);
  });

  it("defaults to total_weeks = 12 when no race date is set", async () => {
    let insertedPlan: unknown;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_plans") {
        (c.insert as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) => {
          insertedPlan = args;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile(),  // no race_date
      25,
      { skipLinkSms: true },
    );

    expect((insertedPlan as Record<string, unknown>).total_weeks).toBe(12);
  });

  it("saves exactly total_weeks plan entries in the weeks array", async () => {
    let insertedPlan: unknown;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_plans") {
        (c.insert as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) => {
          insertedPlan = args;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      { skipLinkSms: true },
    );

    const plan = insertedPlan as Record<string, unknown>;
    const weeks = plan.weeks as unknown[];
    expect(weeks).toHaveLength(19);
  });
});

// -----------------------------------------------------------------------
// prescribedWeek1Miles → training_state sync
// -----------------------------------------------------------------------

describe("generateAndSaveFullPlan — prescribedWeek1Miles syncs to training_state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("updates training_state.weekly_mileage_target when prescribedWeek1Miles is provided", async () => {
    const stateUpdateArgs: unknown[] = [];

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_state") {
        (c.upsert as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) => {
          stateUpdateArgs.push(args);
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      { skipLinkSms: true, prescribedWeek1Miles: 35 },
    );

    expect(stateUpdateArgs).toHaveLength(1);
    expect(stateUpdateArgs[0]).toEqual(
      expect.objectContaining({ weekly_mileage_target: 35 }),
    );
  });

  it("always resets current_week to 1 in training_state even when prescribedWeek1Miles is omitted", async () => {
    let capturedUpdate: Record<string, unknown> | null = null;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_state") {
        (c.upsert as ReturnType<typeof vi.fn>).mockImplementation((payload: Record<string, unknown>) => {
          capturedUpdate = payload;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      { skipLinkSms: true },
    );

    expect(capturedUpdate).not.toBeNull();
    expect(capturedUpdate).toMatchObject({ current_week: 1 });
    // weekly_mileage_target is now always synced from the computed arc week 1 (baseMileage=30)
    // so the dashboard stays consistent with the plan even when no prescribedWeek1Miles is given.
    expect(capturedUpdate).toMatchObject({ weekly_mileage_target: 30 });
  });

  it("does NOT touch current_week, weekly_mileage_target, or weekly_plan_sessions when resetToWeek1 is false", async () => {
    // Mid-plan rebuilds (add hill repeats, change workout types, update paces) must not
    // overwrite the current week's target or session list — the athlete is already in
    // progress for the week and those values are authoritative.
    let capturedUpdate: Record<string, unknown> | null = null;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_state") {
        (c.upsert as ReturnType<typeof vi.fn>).mockImplementation((payload: Record<string, unknown>) => {
          capturedUpdate = payload;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      { skipLinkSms: true, prescribedWeek1Miles: 20, resetToWeek1: false },
    );

    // Mid-plan rebuild (neither resetToWeek1 nor week1Reset) must not write to training_state.
    expect(capturedUpdate).toBeNull();
  });

  it("updates weekly_mileage_target and clears future sessions (keeps preserved) when week1Reset is true", async () => {
    // Week-1 mid-plan rebuild: athlete is in week 1 and wants changes. We should update
    // the mileage target and replace sessions (clearing future ones, preserving past ones)
    // so the dashboard reflects the new plan immediately.
    let capturedUpdate: Record<string, unknown> | null = null;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_state") {
        (c.upsert as ReturnType<typeof vi.fn>).mockImplementation((payload: Record<string, unknown>) => {
          capturedUpdate = payload;
          return c;
        });
      }
      return c;
    });

    const pastSession = { day: "Mon", date: "3/16", label: "Easy 5mi" };

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      {
        skipLinkSms: true,
        prescribedWeek1Miles: 35,
        resetToWeek1: false,
        week1Reset: true,
        preservedSessions: [pastSession],
      },
    );

    // current_week must NOT be reset — athlete stays on week 1
    expect(capturedUpdate).not.toHaveProperty("current_week");
    // Mileage target updated to the new plan's week 1 value
    expect(capturedUpdate).toMatchObject({ weekly_mileage_target: 35 });
    // Past sessions preserved; future sessions cleared
    expect(capturedUpdate).toMatchObject({ weekly_plan_sessions: [pastSession] });
  });

  it("scopes the training_state update to the correct user_id", async () => {
    let capturedPayload: Record<string, unknown> | null = null;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_state") {
        (c.upsert as ReturnType<typeof vi.fn>).mockImplementation((payload: Record<string, unknown>) => {
          capturedPayload = payload;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-abc",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      { skipLinkSms: true, prescribedWeek1Miles: 35 },
    );

    expect(capturedPayload).toMatchObject({ user_id: "user-abc" });
  });
});

// -----------------------------------------------------------------------
// skipLinkSms flag
// -----------------------------------------------------------------------

describe("generateAndSaveFullPlan — skipLinkSms flag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue(chain({ data: null, error: null }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("suppresses the dashboard link SMS when skipLinkSms is true", async () => {
    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      { skipLinkSms: true },
    );

    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("sends the dashboard link SMS when skipLinkSms is false (default)", async () => {
    // Provide NEXT_PUBLIC_APP_URL so the URL is deterministic.
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      // skipLinkSms defaults to false
    );

    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      expect.stringContaining("coachdean.ai/dashboard"),
    );
  });
});

// -----------------------------------------------------------------------
// Plan/text alignment: week 1 mileage in plan vs training_state
//
// When an athlete completes onboarding, Dean sends their Week 1 plan over
// text ("start with ~35 miles this week") and then calls generateAndSaveFullPlan
// with prescribedWeek1Miles = 35.  The plan arc uses 35 as baseMileage so the
// plan curve starts from there; training_state.weekly_mileage_target is also
// set to 35 so the dashboard "This Week" card shows the same number Dean spoke
// about over text.
// -----------------------------------------------------------------------

describe("generateAndSaveFullPlan — plan / text alignment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("training_state target and plan arc week 1 both equal prescribedWeek1Miles", async () => {
    // The plan arc builds week 1 upward from baseMileage (e.g. 35 * 1.07 ≈ 37.5),
    // but training_state.weekly_mileage_target must match what Dean sent (35) so the
    // dashboard is consistent with the athlete's first text conversation.
    const stateUpdateArgs: unknown[] = [];
    let insertedPlan: unknown;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_plans") {
        (c.insert as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) => {
          insertedPlan = args;
          return c;
        });
      }
      if (table === "training_state") {
        (c.upsert as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) => {
          stateUpdateArgs.push(args);
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      { skipLinkSms: true, prescribedWeek1Miles: 35 },
    );

    // The training_state target is exactly what Dean said over text.
    expect(stateUpdateArgs[0]).toEqual(
      expect.objectContaining({ weekly_mileage_target: 35 }),
    );

    // Plan arc week 1 is exactly prescribedWeek1Miles — no buildFactor applied to week 1
    // so the arc and training_state start from the same baseline.
    const plan = insertedPlan as Record<string, unknown>;
    const weeks = plan.weeks as Array<{ week_number: number; mileage_target: number }>;
    const week1 = weeks.find(w => w.week_number === 1)!;
    expect(week1.mileage_target).toBe(35); // week 1 = base, buildFactor starts from week 2
  });

  it("race_date stored in training_plans matches the profile race_date", async () => {
    let insertedPlan: unknown;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_plans") {
        (c.insert as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) => {
          insertedPlan = args;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ race_date: RACE_18W }),
      30,
      { skipLinkSms: true },
    );

    expect((insertedPlan as Record<string, unknown>).race_date).toBe(RACE_18W);
  });
});

// -----------------------------------------------------------------------
// Beginner mileage cap — stale Strava history
//
// A user who self-identifies as a beginner may have old Strava activity from
// a previous fitness phase. Without the cap, their plan arc would be anchored
// to the historical average (e.g. 16mi) instead of the 8mi beginner default.
// -----------------------------------------------------------------------

describe("generateAndSaveFullPlan — beginner mileage cap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("caps week 1 target at 8mi for explicit beginner with high Strava avg", async () => {
    let capturedUpdate: Record<string, unknown> | null = null;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_state") {
        (c.upsert as ReturnType<typeof vi.fn>).mockImplementation((payload: Record<string, unknown>) => {
          capturedUpdate = payload;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ fitness_level: "beginner" }),
      16,  // avgWeeklyMileage — stale Strava history; should be ignored for beginners
      { skipLinkSms: true },
    );

    // Plan arc must start at the beginner default (8mi), not the Strava average (16mi)
    expect(capturedUpdate).toMatchObject({ weekly_mileage_target: 8 });
  });

  it("does NOT cap baseMileage when fitness_level is null (legacy profile without explicit level)", async () => {
    let capturedUpdate: Record<string, unknown> | null = null;

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = chain({ data: null, error: null });
      if (table === "training_state") {
        (c.upsert as ReturnType<typeof vi.fn>).mockImplementation((payload: Record<string, unknown>) => {
          capturedUpdate = payload;
          return c;
        });
      }
      return c;
    });

    await generateAndSaveFullPlan(
      "user-1",
      "+12025551234",
      baseProfile({ fitness_level: null }),
      16,
      { skipLinkSms: true },
    );

    // Legacy profiles (no explicit fitness_level) use the Strava avg as-is
    expect(capturedUpdate).toMatchObject({ weekly_mileage_target: 16 });
  });
});
