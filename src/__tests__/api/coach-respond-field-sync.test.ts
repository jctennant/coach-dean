/**
 * Field-sync tests for persistProfileUpdates.
 *
 * These tests verify that when a user sends a message that changes their goal,
 * race date, or other profile fields, ALL relevant DB tables are updated
 * consistently — not just training_profiles, but also the races table.
 *
 * The key challenge: persistProfileUpdates is a private function called inside
 * the POST handler after the main Claude call. To test it we:
 *   1. Mock the first Anthropic call (extractProfileData/Haiku) to return a
 *      specific JSON extraction.
 *   2. Mock the second call (main coach/Sonnet) to return coaching text.
 *   3. Mock all subsequent calls (maybeUpdateTrainingPlanWeeks etc.) to return
 *      a safe no-op JSON so they don't interfere.
 *   4. Capture profileChain and racesChain update() calls after flush().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRequest } from "../helpers/supabase-mock";

// ---------- Capture after() callbacks ----------
const afterQueue: Array<() => Promise<void>> = [];
async function flush() {
  // Some code paths call after() from inside an already-running after() callback
  // (e.g. the [CADENCE:] tag handler nested inside the main user_message after()).
  // Drain the queue in waves until nothing new gets pushed, not just one pass.
  while (afterQueue.length > 0) {
    const cbs = afterQueue.splice(0);
    for (const fn of cbs) await fn();
  }
}

// ---------- module mocks ----------
vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));

vi.mock("@/lib/anthropic", () => ({
  anthropic: {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Easy run today!" }],
      }),
    },
  },
}));

vi.mock("@/lib/linq", () => ({
  sendSMS: vi.fn().mockResolvedValue({ chatId: null }),
  startTyping: vi.fn().mockResolvedValue(undefined),
  typingDurationMs: vi.fn().mockReturnValue(0),
}));

vi.mock("@/lib/track", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weather", () => ({
  fetchWeekWeather: vi.fn().mockResolvedValue(null),
  buildWeatherBlock: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/training-plan", () => ({
  generateAndSaveFullPlan: vi.fn().mockResolvedValue("new-token-abc"),
  computePhaseForPlan: vi.fn().mockReturnValue("base"),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({ data, init }),
  },
  after: (fn: () => Promise<void>) => {
    afterQueue.push(fn);
  },
}));

// ---------- imports (after mocks) ----------
import { POST } from "@/app/api/coach/respond/route";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

// ---------- helpers ----------

function makeChain(response: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "update", "upsert", "delete",
    "eq", "neq", "is", "not", "gte", "lte", "in", "or", "order", "limit",
  ];
  for (const m of methods) chain[m] = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(response);
  chain.maybeSingle = vi.fn().mockResolvedValue(response);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject);
  return chain;
}

function setupSupabase(opts: {
  user?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  state?: Record<string, unknown>;
  races?: Array<Record<string, unknown>>;
  conversations?: Array<Record<string, unknown>>;
}) {
  const profileChain = makeChain({ data: opts.profile ?? null, error: null });
  const racesChain = makeChain({ data: opts.races ?? null, error: null });
  const stateChain = makeChain({ data: opts.state ?? null, error: null });

  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === "users") return makeChain({ data: opts.user ?? null, error: null });
    if (table === "training_profiles") return profileChain;
    if (table === "training_state") return stateChain;
    if (table === "races") return racesChain;
    if (table === "conversations") return makeChain({ data: opts.conversations ?? [], error: null });
    return makeChain({ data: null, error: null });
  });

  return { profileChain, racesChain, stateChain };
}

function baseUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "user-001",
    phone_number: "+12025550001",
    strava_athlete_id: null,
    onboarding_step: null,
    linq_chat_id: "chat-001",
    timezone: "America/New_York",
    messaging_opted_out: false,
    onboarding_data: { weekly_miles: 20 },
    dashboard_token: "existing-token",
    ...overrides,
  };
}

function baseProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: "10k",
    race_date: "2026-06-15",
    goal_distance_miles: 6.214,
    goal_time_minutes: null,
    injury_notes: null,
    preferred_units: "imperial",
    current_easy_pace: "9:30/mi",
    current_tempo_pace: null,
    current_interval_pace: null,
    current_vdot: null,
    training_days: ["monday", "wednesday", "saturday"],
    ...overrides,
  };
}

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    current_week: 3,
    current_phase: "base",
    weekly_mileage_target: 20,
    weekly_plan_sessions: null,
    taper_peak_miles: null,
    ...overrides,
  };
}

function baseConversations(userText: string): Array<Record<string, unknown>> {
  // Returned newest-first (matching DB ORDER BY created_at DESC).
  return [
    { role: "user", content: userText, message_type: "user_message", created_at: new Date().toISOString() },
    { role: "assistant", content: "How can I help?", message_type: "user_message", created_at: new Date(Date.now() - 60000).toISOString() },
  ];
}

/**
 * Mock the Anthropic call sequence for a user_message trigger:
 *   1st call — extractProfileData (Haiku): returns the given extraction JSON
 *   2nd call — main coach response (Sonnet): returns coaching text
 *   3rd+ calls — maybeUpdateTrainingPlanWeeks etc.: return safe no-op JSON
 */
function mockExtractionThenCoach(extraction: Record<string, unknown>, coachText = "Got it, updating your plan!") {
  // user_message makes 3 Claude calls: extraction (Haiku), intent classifier (Haiku), then coach (Sonnet)
  (anthropic.messages.create as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify(extraction) }] })
    .mockResolvedValueOnce({ content: [{ type: "text", text: '{"intent":"general","body_part":null,"confidence":"low"}' }] })
    .mockResolvedValueOnce({ content: [{ type: "text", text: coachText }] })
    .mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
}

// ---------- tests ----------

describe("persistProfileUpdates — goal race type change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("updates training_profiles.goal and goal_distance_miles when goal changes to 5k", async () => {
    mockExtractionThenCoach({ goal_race_type: "5k" });
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ goal: "10k", goal_distance_miles: 6.214 }),
      state: baseState(),
      conversations: baseConversations("I want to switch to training for a 5K"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const goalUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.goal != null);
    expect(goalUpdate).toBeDefined();
    expect(goalUpdate?.[0]).toMatchObject({ goal: "5k", goal_distance_miles: 3.107 });
  });

  it("updates races.goal and goal_distance_miles for the A race when goal changes", async () => {
    mockExtractionThenCoach({ goal_race_type: "5k" });
    const { racesChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ goal: "10k", goal_distance_miles: 6.214 }),
      state: baseState(),
      races: [{ id: "race-1", priority: "A", goal: "10k", goal_distance_miles: 6.214, race_date: "2026-06-15" }],
      conversations: baseConversations("Switching to a 5K"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (racesChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const goalUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.goal != null);
    expect(goalUpdate).toBeDefined();
    expect(goalUpdate?.[0]).toMatchObject({ goal: "5k", goal_distance_miles: 3.107 });
  });

  it("keeps training_profiles and races in sync — both show the same goal after change", async () => {
    mockExtractionThenCoach({ goal_race_type: "half_marathon" });
    const { profileChain, racesChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ goal: "10k", goal_distance_miles: 6.214 }),
      state: baseState(),
      races: [{ id: "race-1", priority: "A", goal: "10k", goal_distance_miles: 6.214, race_date: "2026-06-15" }],
      conversations: baseConversations("Actually I signed up for a half marathon"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const profileGoal = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls
      .find(([p]: [Record<string, unknown>]) => p?.goal != null)?.[0];
    const raceGoal = (racesChain.update as ReturnType<typeof vi.fn>).mock.calls
      .find(([p]: [Record<string, unknown>]) => p?.goal != null)?.[0];

    expect(profileGoal?.goal).toBe("half_marathon");
    expect(profileGoal?.goal_distance_miles).toBe(13.109);
    expect(raceGoal?.goal).toBe("half_marathon");
    expect(raceGoal?.goal_distance_miles).toBe(13.109);
  });
});

describe("persistProfileUpdates — race date change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("updates training_profiles.race_date when race date changes", async () => {
    mockExtractionThenCoach({ race_date: "2026-08-01" });
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ race_date: "2026-06-15" }),
      state: baseState(),
      conversations: baseConversations("I moved my race to August 1st"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const dateUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.race_date != null);
    expect(dateUpdate?.[0]).toMatchObject({ race_date: "2026-08-01" });
  });

  it("updates races.race_date for the A race when race date changes", async () => {
    mockExtractionThenCoach({ race_date: "2026-08-01" });
    const { racesChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ race_date: "2026-06-15" }),
      state: baseState(),
      races: [{ id: "race-1", priority: "A", goal: "10k", race_date: "2026-06-15" }],
      conversations: baseConversations("I moved my race to August 1st"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (racesChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const dateUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.race_date != null);
    expect(dateUpdate?.[0]).toMatchObject({ race_date: "2026-08-01" });
  });
});

describe("persistProfileUpdates — goal time change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("updates training_profiles.goal_time_minutes when a new finish time is given", async () => {
    mockExtractionThenCoach({ goal_time_minutes: 55 });
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: baseConversations("I want to run sub-55 minutes"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const timeUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.goal_time_minutes != null);
    expect(timeUpdate?.[0]).toMatchObject({ goal_time_minutes: 55 });
  });

  it("syncs goal_time_minutes to the A race row in the races table", async () => {
    mockExtractionThenCoach({ goal_time_minutes: 115 });
    const { racesChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: baseConversations("I want to run sub-1:55"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (racesChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const timeUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.goal_time_minutes != null);
    expect(timeUpdate?.[0]).toMatchObject({ goal_time_minutes: 115 });
  });
});

describe("persistProfileUpdates — standing schedule change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("lowercases updated_training_days before saving to training_profiles", async () => {
    mockExtractionThenCoach({ updated_training_days: ["Tuesday", "Thursday", "Sunday"] });
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: baseConversations("Change my schedule to Tuesday, Thursday, Sunday from now on"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const daysUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.training_days != null);
    expect(daysUpdate).toBeDefined();
    expect(daysUpdate?.[0].training_days).toEqual(["tuesday", "thursday", "sunday"]);
  });

  it("clears any active week override when the standing schedule changes", async () => {
    mockExtractionThenCoach({ updated_training_days: ["Monday", "Wednesday", "Friday"] });
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ this_week_override_days: ["tuesday", "thursday"], this_week_override_expires: "2026-04-06" }),
      state: baseState(),
      conversations: baseConversations("Change my schedule to Mon/Wed/Fri going forward"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const daysUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.training_days != null);
    expect(daysUpdate?.[0]).toMatchObject({
      training_days: ["monday", "wednesday", "friday"],
      this_week_override_days: null,
      this_week_override_expires: null,
    });
  });
});

describe("tag-based this-week schedule override ([WEEK_OVERRIDE:] tag)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("saves this_week_override_days as lowercase with a Sunday expiry when Dean emits [WEEK_OVERRIDE:] tag", async () => {
    // Override now driven by [WEEK_OVERRIDE:] tag in Dean's response, not Haiku extraction
    mockExtractionThenCoach({}, "Done — running Tue/Wed/Fri this week only. [WEEK_OVERRIDE: Tuesday,Wednesday,Friday]");
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: baseConversations("I want to run Tue/Wed/Fri this week instead"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const overrideUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.this_week_override_days != null);
    expect(overrideUpdate).toBeDefined();
    expect(overrideUpdate?.[0].this_week_override_days).toEqual(["tuesday", "wednesday", "friday"]);
    // Expiry must be a valid date string (YYYY-MM-DD) and a Sunday
    const expires = overrideUpdate?.[0].this_week_override_expires as string;
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const expiresDate = new Date(expires + "T12:00:00Z");
    expect(expiresDate.getUTCDay()).toBe(0); // 0 = Sunday
  });

  it("does not overwrite training_days when saving a week override via [WEEK_OVERRIDE:] tag", async () => {
    mockExtractionThenCoach({}, "Sure — just Monday and Saturday this week. [WEEK_OVERRIDE: Monday,Saturday]");
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ training_days: ["tuesday", "thursday", "sunday"] }),
      state: baseState(),
      conversations: baseConversations("Just this week I can only do Monday and Saturday"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const anyUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.training_days != null);
    // training_days must NOT be touched by a week override
    expect(anyUpdate).toBeUndefined();
  });
});

describe("tag-based proactive cadence change ([CADENCE:] tag)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("saves proactive_cadence when Dean emits [CADENCE: morning_reminders]", async () => {
    mockExtractionThenCoach({}, "Got it — I'll text you each morning on your training days. [CADENCE: morning_reminders]");
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: baseConversations("can you text me every morning with the plan?"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const cadenceUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.proactive_cadence != null);
    expect(cadenceUpdate).toBeDefined();
    expect(cadenceUpdate?.[0].proactive_cadence).toBe("morning_reminders");
  });

  it("does not touch proactive_cadence when no [CADENCE:] tag is present", async () => {
    mockExtractionThenCoach({}, "Nice work on today's run!");
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: baseConversations("just finished my run"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const cadenceUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.proactive_cadence != null);
    expect(cadenceUpdate).toBeUndefined();
  });
});

describe("deterministic cadence short-circuit — asks which days when training_days is unset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  function mockHighConfidenceCadence(cadence: string) {
    (anthropic.messages.create as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "{}" }] }) // extraction
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ intent: "cadence_request", confidence: "high", cadence }) }],
      }); // intent classifier
  }

  it("asks which days when opting into morning_reminders with no training_days on file", async () => {
    mockHighConfidenceCadence("morning_reminders");
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ training_days: [] }),
      state: baseState(),
      conversations: baseConversations("can you text me every morning with the plan?"),
    });

    const res = await POST(mockRequest({ userId: "user-001", trigger: "user_message", dry_run: true })) as { data: { message: string } };

    expect(res.data.message).toMatch(/which days/i);
    // dry_run skips DB writes, so proactive_cadence isn't persisted here — this test only
    // verifies the confirmation text asks about days. Persistence is covered by the
    // [CADENCE:] tag-path tests above and by re-running without dry_run below.
    expect(profileChain.update).not.toHaveBeenCalled();
  });

  it("gives the normal confirmation when training_days is already on file", async () => {
    mockHighConfidenceCadence("morning_reminders");
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ training_days: ["monday", "wednesday", "saturday"] }),
      state: baseState(),
      conversations: baseConversations("can you text me every morning with the plan?"),
    });

    const res = await POST(mockRequest({ userId: "user-001", trigger: "user_message", dry_run: true })) as { data: { message: string } };

    expect(res.data.message).not.toMatch(/which days/i);
    expect(res.data.message).toMatch(/training days/i);
  });

  it("persists proactive_cadence for real (non-dry-run) requests", async () => {
    mockHighConfidenceCadence("morning_reminders");
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ training_days: [] }),
      state: baseState(),
      conversations: baseConversations("can you text me every morning with the plan?"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const updateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const cadenceUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.proactive_cadence != null);
    expect(cadenceUpdate?.[0].proactive_cadence).toBe("morning_reminders");
  });
});

describe("persistProfileUpdates — new B/C race extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    // Reset fetch mock between tests
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("inserts a new B race into the races table with its own goal type when extracted", async () => {
    mockExtractionThenCoach({
      new_b_races: [{ date: "2026-08-15", name: "Summer Trail 10K", priority: "B", goal_race_type: "10k", goal_distance_miles: 6.214 }],
    });
    const { racesChain } = setupSupabase({
      user: baseUser(),
      // A race is a marathon — B race goal should be "10k", not "marathon"
      profile: baseProfile({ goal: "marathon", race_date: "2026-10-01" }),
      state: baseState(),
      races: [{ id: "race-1", priority: "A", race_date: "2026-10-01" }],
      conversations: baseConversations("I also signed up for a summer 10K on August 15th as a tune-up"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const insertCalls = (racesChain.insert as ReturnType<typeof vi.fn>).mock.calls;
    const raceInsert = insertCalls.find(([rows]: [unknown]) =>
      Array.isArray(rows) && rows.some((r: Record<string, unknown>) => r.race_date === "2026-08-15")
    );
    expect(raceInsert).toBeDefined();
    expect(raceInsert?.[0][0]).toMatchObject({
      race_date: "2026-08-15",
      race_name: "Summer Trail 10K",
      priority: "B",
      goal: "10k",          // B race's own type, not the A-race "marathon"
      goal_distance_miles: 6.214,
    });
  });

  it("falls back to A-race goal type when B race goal_race_type is null", async () => {
    mockExtractionThenCoach({
      new_b_races: [{ date: "2026-08-15", name: "Local Race", priority: "C", goal_race_type: null, goal_distance_miles: null }],
    });
    const { racesChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ goal: "marathon", race_date: "2026-10-01" }),
      state: baseState(),
      races: [{ id: "race-1", priority: "A", race_date: "2026-10-01" }],
      conversations: baseConversations("There's a fun local race on August 15th I want to do"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const insertCalls = (racesChain.insert as ReturnType<typeof vi.fn>).mock.calls;
    const raceInsert = insertCalls.find(([rows]: [unknown]) =>
      Array.isArray(rows) && rows.some((r: Record<string, unknown>) => r.race_date === "2026-08-15")
    );
    expect(raceInsert?.[0][0]).toMatchObject({ goal: "marathon" }); // fallback to A-race goal
  });

  it("does not insert a B race that already exists in the races table", async () => {
    mockExtractionThenCoach({
      new_b_races: [{ date: "2026-08-15", name: "Summer Trail 10K", priority: "B", goal_race_type: "10k", goal_distance_miles: 6.214 }],
    });
    const { racesChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ goal: "10k", race_date: "2026-10-01" }),
      state: baseState(),
      // Race already in DB — dedup should prevent a second insert
      races: [
        { id: "race-1", priority: "A", race_date: "2026-10-01" },
        { id: "race-2", priority: "B", race_date: "2026-08-15" },
      ],
      conversations: baseConversations("Reminder — I have that 10K on August 15th too"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const insertCalls = (racesChain.insert as ReturnType<typeof vi.fn>).mock.calls;
    const raceInsert = insertCalls.find(([rows]: [unknown]) =>
      Array.isArray(rows) && rows.some((r: Record<string, unknown>) => r.race_date === "2026-08-15")
    );
    expect(raceInsert).toBeUndefined();
  });

  it("triggers a silent rebuild_plan after inserting a new B race", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    mockExtractionThenCoach({
      new_b_races: [{ date: "2026-08-15", name: "Summer 10K", priority: "B", goal_race_type: "10k", goal_distance_miles: 6.214 }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ goal: "10k", race_date: "2026-10-01" }),
      state: baseState(),
      races: [{ id: "race-1", priority: "A", race_date: "2026-10-01" }],
      conversations: baseConversations("I signed up for a 10K on August 15th"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const rebuildCall = fetchMock.mock.calls.find(([, opts]: [string, RequestInit]) => {
      const body = JSON.parse(opts?.body as string ?? "{}");
      return body.trigger === "rebuild_plan" && body.silent === true;
    });
    expect(rebuildCall).toBeDefined();
  });

  it("does not trigger a rebuild when the B race date is in the past", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    mockExtractionThenCoach({
      new_b_races: [{ date: "2020-01-01", name: "Old Race", priority: "B", goal_race_type: null, goal_distance_miles: null }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ goal: "10k", race_date: "2026-10-01" }),
      state: baseState(),
      races: [{ id: "race-1", priority: "A", race_date: "2026-10-01" }],
      conversations: baseConversations("I did a race back in 2020"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const rebuildCall = fetchMock.mock.calls.find(([, opts]: [string, RequestInit]) => {
      const body = JSON.parse(opts?.body as string ?? "{}");
      return body.trigger === "rebuild_plan";
    });
    expect(rebuildCall).toBeUndefined();
  });
});

describe("persistProfileUpdates — no spurious writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("does not update races.goal when only goal_time_minutes changes", async () => {
    mockExtractionThenCoach({ goal_time_minutes: 55 });
    const { racesChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: baseConversations("New goal: sub-55"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const goalUpdate = (racesChain.update as ReturnType<typeof vi.fn>).mock.calls
      .find(([p]: [Record<string, unknown>]) => p?.goal != null);
    expect(goalUpdate).toBeUndefined();
  });
});

describe("persistProfileUpdates — cross-training day preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("lowercases updated_crosstraining_days before saving to training_profiles", async () => {
    mockExtractionThenCoach({ updated_crosstraining_days: ["Tuesday", "Thursday"] });
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: baseConversations("I usually bike on Tuesdays and Thursdays"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const update = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls
      .find(([p]: [Record<string, unknown>]) => p?.crosstraining_days != null);
    expect(update).toBeDefined();
    expect(update?.[0].crosstraining_days).toEqual(["tuesday", "thursday"]);
  });

  it("does not touch crosstraining_days when nothing was extracted", async () => {
    mockExtractionThenCoach({ goal_time_minutes: 55 });
    const { profileChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: baseConversations("New goal: sub-55"),
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const update = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls
      .find(([p]: [Record<string, unknown>]) => Object.prototype.hasOwnProperty.call(p, "crosstraining_days"));
    expect(update).toBeUndefined();
  });
});
