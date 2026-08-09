import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/lib/linq", () => ({ sendSMS: vi.fn().mockResolvedValue({ chatId: "chat-1" }) }));
vi.mock("@/lib/anthropic", () => ({
  anthropic: { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "[]" }] }) } },
}));

import { syncWeekFromArc } from "@/lib/training-plan";
import { supabase } from "@/lib/supabase";

/** Chainable Supabase mock — every builder method returns itself; awaiting resolves `response`. */
function chain(response: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "neq", "is", "not", "gte", "lte", "in", "or", "order", "limit"]) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.single = vi.fn().mockResolvedValue(response);
  c.maybeSingle = vi.fn().mockResolvedValue(response);
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject);
  return c;
}

type StateRow = { injury_hold_since: string | null; return_to_run_phase: number | null };
type ProfileRow = Record<string, unknown>;

const ARC_WEEK = {
  week_number: 3,
  mileage_target: 30,
  long_run_target: 10,
  key_workout: "Tempo 5mi (1mi WU + 3mi @ 7:45/mi + 1mi CD)",
  key_workout_2: "Intervals 4mi (1mi WU + 2mi @ 6:50/mi + 1mi CD)",
};

/** Wires the three tables syncWeekFromArc touches; returns the training_state update payload. */
function setup(opts: { state: StateRow; profile?: ProfileRow }) {
  const stateChain = chain({ data: opts.state, error: null });
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === "training_plans") {
      return chain({ data: { weeks: [ARC_WEEK], plan_source: "dean" }, error: null });
    }
    if (table === "training_profiles") {
      return chain({
        data: {
          training_days: ["monday", "wednesday", "thursday", "saturday"],
          injury_body_part: null,
          preferred_units: "imperial",
          crosstraining_tools: ["bike", "elliptical"],
          crosstraining_days: null,
          active_injury: false,
          ...opts.profile,
        },
        error: null,
      });
    }
    return stateChain;
  });
  return stateChain;
}

function updatePayload(stateChain: Record<string, unknown>): Record<string, unknown> {
  const calls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

type Session = { day: string; date: string; label: string; type: string };

describe("syncWeekFromArc", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T12:00:00Z")); // Wednesday
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("persists a normal running week for a healthy athlete", async () => {
    const stateChain = setup({ state: { injury_hold_since: null, return_to_run_phase: null } });
    await syncWeekFromArc("user-1", 3, "UTC");

    const payload = updatePayload(stateChain);
    const sessions = payload.weekly_plan_sessions as Session[];
    expect(sessions.some(s => s.type === "run")).toBe(true);
    expect(payload.weekly_mileage_target).toBe(30);
    expect(payload.weekly_long_run_miles).toBe(10);
  });

  it("persists a cross-training week — not a running week — for an athlete on an injury hold", async () => {
    // The bug this closes: syncWeekFromArc called computeArcWeekSkeleton unconditionally, so a
    // held athlete had a full running week stored and read back by the reminders and dashboard.
    const stateChain = setup({
      state: { injury_hold_since: "2026-07-28", return_to_run_phase: null },
      profile: { active_injury: true, injury_body_part: "shin" },
    });
    await syncWeekFromArc("user-1", 3, "UTC");

    const payload = updatePayload(stateChain);
    const sessions = payload.weekly_plan_sessions as Session[];
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every(s => s.type === "cross_train" || s.type === "strength")).toBe(true);
    expect(sessions.some(s => s.type === "run")).toBe(false);
    // Running numbers must not be quoted against a week with no running in it.
    expect(payload.weekly_mileage_target).toBe(0);
    expect(payload.weekly_long_run_miles).toBeNull();
    expect(payload.weekly_quality_session).toBeNull();
  });

  it("writes no sessions at all in return-to-run phase 1", async () => {
    const stateChain = setup({
      state: { injury_hold_since: null, return_to_run_phase: 1 },
      profile: { active_injury: true },
    });
    await syncWeekFromArc("user-1", 3, "UTC");

    const payload = updatePayload(stateChain);
    // Leave whatever the RTR flow put there rather than overwriting it with a running week.
    expect(payload).not.toHaveProperty("weekly_plan_sessions");
    expect(payload.weekly_strength_routine_key).toBeDefined();
  });

  it("drops the second quality session for an athlete running through an injury", async () => {
    const stateChain = setup({
      state: { injury_hold_since: null, return_to_run_phase: null },
      profile: { active_injury: true, injury_body_part: "shin" },
    });
    await syncWeekFromArc("user-1", 3, "UTC");

    const sessions = updatePayload(stateChain).weekly_plan_sessions as Session[];
    const quality = sessions.filter(s => s.label.startsWith("Tempo") || s.label.startsWith("Intervals"));
    expect(quality).toHaveLength(1);
  });

  it("keeps cross-training off a modality the injury rules say to avoid", async () => {
    const stateChain = setup({
      state: { injury_hold_since: null, return_to_run_phase: null },
      profile: { active_injury: true, injury_body_part: "shin", crosstraining_tools: ["rowing machine", "bike"] },
    });
    await syncWeekFromArc("user-1", 3, "UTC");

    const sessions = updatePayload(stateChain).weekly_plan_sessions as Session[];
    const crossTrain = sessions.filter(s => s.type === "cross_train").map(s => s.label);
    expect(crossTrain.join(" ").toLowerCase()).not.toContain("row");
  });

  it("persists the rehab days so the reminders and dashboard see them too", async () => {
    const stateChain = setup({
      state: { injury_hold_since: null, return_to_run_phase: null },
      profile: { active_injury: true, injury_body_part: "shin", injury_severity: "moderate" },
    });
    await syncWeekFromArc("user-1", 3, "UTC");

    const sessions = updatePayload(stateChain).weekly_plan_sessions as Array<Session & { rehab_routine_key?: string }>;
    const rehabDays = sessions.filter(s => s.rehab_routine_key === "shin");
    expect(rehabDays.length).toBeGreaterThanOrEqual(5);
    // The strength day names the routine rather than the old bare "Strength + mobility".
    expect(sessions.some(s => s.type === "strength" && s.label.includes("Shin splints"))).toBe(true);
  });

  it("leaves a healthy athlete on a single strength day", async () => {
    const stateChain = setup({ state: { injury_hold_since: null, return_to_run_phase: null } });
    await syncWeekFromArc("user-1", 3, "UTC");

    const sessions = updatePayload(stateChain).weekly_plan_sessions as Array<Session & { rehab_routine_key?: string }>;
    expect(sessions.filter(s => s.rehab_routine_key).length).toBeLessThanOrEqual(1);
  });
});
