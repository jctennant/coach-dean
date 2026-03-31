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
  const cbs = afterQueue.splice(0);
  for (const fn of cbs) await fn();
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
  (anthropic.messages.create as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify(extraction) }] })
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
