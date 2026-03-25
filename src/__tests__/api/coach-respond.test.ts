import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRequest } from "../helpers/supabase-mock";

// ---------- Capture after() callbacks so tests can await background work ----------
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

function daysFromNow(n: number): string {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a chainable Supabase mock where every method returns the same chain.
 * .single() and .maybeSingle() resolve with `response`.
 * Awaiting the chain directly (queries without .single(), e.g. .limit()) resolves
 * to the chain itself — .data will be undefined, safely handled by the route via
 * optional chaining (e.g. `conversationsResult.data?.reverse() || []`).
 */
function makeChain(response: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "update", "upsert", "delete",
    "eq", "neq", "is", "not", "gte", "lte", "in", "or", "order", "limit",
  ];
  for (const m of methods) chain[m] = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(response);
  chain.maybeSingle = vi.fn().mockResolvedValue(response);
  // Allow awaiting the chain directly (queries that end with .limit() rather than .single())
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject);
  return chain;
}

function setupSupabase(opts: {
  user?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  state?: Record<string, unknown>;
  races?: Array<Record<string, unknown>>;
}) {
  // Reuse the same chain for training_state so we can inspect all update() calls.
  const stateChain = makeChain({ data: opts.state ?? null, error: null });

  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === "users") return makeChain({ data: opts.user ?? null, error: null });
    if (table === "training_profiles") return makeChain({ data: opts.profile ?? null, error: null });
    if (table === "training_state") return stateChain;
    if (table === "races") return makeChain({ data: opts.races ?? null, error: null });
    // conversations, activities, training_plans etc. — return empty/null data
    return makeChain({ data: null, error: null });
  });

  return { stateChain };
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
    onboarding_data: { weekly_miles: 30 },
    ...overrides,
  };
}

function baseProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: "half_marathon",
    race_date: null,
    injury_notes: null,
    preferred_units: "imperial",
    current_easy_pace: null,
    current_tempo_pace: null,
    current_interval_pace: null,
    current_vdot: null,
    ...overrides,
  };
}

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    current_week: 8,
    current_phase: "peak",
    weekly_mileage_target: 30,
    weekly_plan_sessions: null,
    taper_peak_miles: null,
    plan_adjustments: null,
    last_activity_summary: null,
    last_activity_date: null,
    ...overrides,
  };
}

// ---------- tests ----------

describe("coach/respond — taper_peak_miles persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("writes taper_peak_miles on first entry into taper window (≤21 days)", async () => {
    const { stateChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ race_date: daysFromNow(10) }),
      state: baseState({ taper_peak_miles: null }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const taperWrite = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => payload?.taper_peak_miles != null
    );
    expect(taperWrite).toBeDefined();
    // onboarding_data.weekly_miles = 30 → avgWeeklyMileage = 30
    expect(taperWrite?.[0].taper_peak_miles).toBe(30);
  });

  it("does NOT write taper_peak_miles when already stored", async () => {
    const { stateChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ race_date: daysFromNow(10) }),
      state: baseState({ taper_peak_miles: 28 }),  // already locked in
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const taperWrite = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => payload?.taper_peak_miles != null
    );
    expect(taperWrite).toBeUndefined();
  });

  it("does NOT write taper_peak_miles when race is more than 21 days away", async () => {
    const { stateChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile({ race_date: daysFromNow(30) }),
      state: baseState({ taper_peak_miles: null }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const taperWrite = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => payload?.taper_peak_miles != null
    );
    expect(taperWrite).toBeUndefined();
  });

  it("does NOT write taper_peak_miles when no mileage data is available", async () => {
    const { stateChain } = setupSupabase({
      user: baseUser({ onboarding_data: {} }),  // no weekly_miles baseline
      profile: baseProfile({ race_date: daysFromNow(10) }),
      state: baseState({ taper_peak_miles: null }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const taperWrite = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => payload?.taper_peak_miles != null
    );
    expect(taperWrite).toBeUndefined();
  });
});

describe("coach/respond — B/C race context in system prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  function captureSystemPrompt(): string {
    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    return (calls[0]?.[0]?.system as string) ?? "";
  }

  it("injects B race mini-taper note when B race is ≤14 days away", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      races: [{
        race_date: daysFromNow(10),
        race_name: "Spring Half",
        goal: "half_marathon",
        priority: "B",
      }],
    });

    const req = mockRequest({ userId: "user-001", trigger: "morning_reminder" });
    await POST(req);
    await flush();

    const prompt = captureSystemPrompt();
    expect(prompt).toContain("B RACE");
    expect(prompt).toContain("Spring Half");
    expect(prompt).toContain("10-15%");
  });

  it("lists B race without taper guidance when more than 14 days away", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      races: [{
        race_date: daysFromNow(30),
        race_name: "Spring Half",
        goal: "half_marathon",
        priority: "B",
      }],
    });

    const req = mockRequest({ userId: "user-001", trigger: "morning_reminder" });
    await POST(req);
    await flush();

    const prompt = captureSystemPrompt();
    expect(prompt).toContain("Upcoming B race");
    expect(prompt).toContain("Spring Half");
    expect(prompt).not.toContain("10-15%");
  });

  it("injects C race workout note when C race is ≤7 days away", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      races: [{
        race_date: daysFromNow(4),
        race_name: "Local 5K",
        goal: "5k",
        priority: "C",
      }],
    });

    const req = mockRequest({ userId: "user-001", trigger: "morning_reminder" });
    await POST(req);
    await flush();

    const prompt = captureSystemPrompt();
    expect(prompt).toContain("C RACE");
    expect(prompt).toContain("Local 5K");
    expect(prompt).toContain("quality workout");
  });

  it("does not inject B/C race content when no secondary races exist", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      races: [],
    });

    const req = mockRequest({ userId: "user-001", trigger: "morning_reminder" });
    await POST(req);
    await flush();

    const prompt = captureSystemPrompt();
    expect(prompt).not.toContain("B RACE");
    expect(prompt).not.toContain("C RACE");
    expect(prompt).not.toContain("Upcoming B race");
  });
});
