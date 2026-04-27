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

vi.mock("@/lib/training-plan", () => ({
  generateAndSaveFullPlan: vi.fn().mockResolvedValue("new-token-abc"),
  computePhaseForPlan: vi.fn().mockReturnValue("base"),
  computeRacePreparedness: vi.fn().mockReturnValue({ flag: null }),
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
    "eq", "neq", "is", "not", "gt", "gte", "lt", "lte", "in", "or", "order", "limit",
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
  // Conversations supplied newest-first, matching DB ORDER BY created_at DESC.
  // The route calls .reverse() on this data internally, making it oldest-first.
  conversations?: Array<Record<string, unknown>>;
}) {
  // Reuse the same chain for training_state so we can inspect all update() calls.
  const stateChain = makeChain({ data: opts.state ?? null, error: null });

  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === "users") return makeChain({ data: opts.user ?? null, error: null });
    if (table === "training_profiles") return makeChain({ data: opts.profile ?? null, error: null });
    if (table === "training_state") return stateChain;
    if (table === "races") return makeChain({ data: opts.races ?? null, error: null });
    if (table === "conversations") return makeChain({ data: opts.conversations ?? null, error: null });
    // activities, training_plans etc. — return empty/null data
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

describe("coach/respond — 'dashboard' keyword early-exit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  });

  it("sends dashboard link directly when token exists, skipping Claude", async () => {
    // Simulate Ian's situation: conversation history with older messages PLUS "My plan"
    // as the latest message. Conversations are supplied newest-first (as the DB returns
    // them) — the route internally calls .reverse() to make them oldest-first, so our
    // fix must re-reverse to find the newest user message.
    setupSupabase({
      user: baseUser({ dashboard_token: "tok-ian-abc" }),
      profile: baseProfile(),
      state: baseState(),
      conversations: [
        // newest-first (DB order)
        { role: "user",      content: "dashboard",                                       created_at: "2026-03-30T10:50:00Z" },
        { role: "assistant", content: "Your training plan isn't ready yet",              created_at: "2026-03-30T10:06:00Z" },
        { role: "user",      content: "dashboard",                                       created_at: "2026-03-30T10:06:00Z" },
        { role: "user",      content: "Can you send my full training plan for Philly?",  created_at: "2026-03-30T09:12:00Z" },
      ],
    });

    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    // Link sent directly — no Claude call
    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(sendSMS).toHaveBeenCalledWith(
      "+12025550001",
      expect.stringContaining("http://localhost:3000/dashboard?token=tok-ian-abc")
    );
  });

  it("generates a new token and sends link when dashboard_token is null", async () => {
    const { generateAndSaveFullPlan } = await import("@/lib/training-plan");
    (generateAndSaveFullPlan as ReturnType<typeof vi.fn>).mockResolvedValue("freshtoken");

    setupSupabase({
      user: baseUser({ dashboard_token: null }),
      profile: baseProfile(),
      state: baseState(),
      conversations: [
        { role: "user", content: "dashboard", created_at: "2026-03-30T10:50:00Z" },
        { role: "user", content: "I want to run Philadelphia", created_at: "2026-03-03T04:26:00Z" },
      ],
    });

    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(generateAndSaveFullPlan).toHaveBeenCalled();
    expect(sendSMS).toHaveBeenCalledWith(
      "+12025550001",
      expect.stringContaining("freshtoken")
    );
  });

  it("does NOT early-exit when latest message is not 'dashboard'", async () => {
    setupSupabase({
      user: baseUser({ dashboard_token: "tok-abc" }),
      profile: baseProfile(),
      state: baseState(),
      conversations: [
        { role: "user", content: "How's my tempo pace looking?", created_at: "2026-03-30T10:50:00Z" },
        { role: "user", content: "dashboard",                    created_at: "2026-03-30T09:00:00Z" },
      ],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    // Normal Claude path taken
    expect(anthropic.messages.create).toHaveBeenCalled();
  });

  it("early-exits with dashboard link for 'DASHBOARD' case variants", async () => {
    const variants = ["Dashboard", "DASHBOARD", " dashboard "];

    const { sendSMS } = await import("@/lib/linq");

    for (const content of variants) {
      vi.clearAllMocks();
      setupSupabase({
        user: baseUser({ dashboard_token: "tok-plan-123" }),
        profile: baseProfile(),
        state: baseState(),
        conversations: [
          { role: "user", content, created_at: "2026-03-30T10:50:00Z" },
        ],
      });

      const req = mockRequest({ userId: "user-001", trigger: "user_message" });
      await POST(req);
      await flush();

      expect(anthropic.messages.create).not.toHaveBeenCalled();
      expect(sendSMS).toHaveBeenCalledWith(
        "+12025550001",
        expect.stringContaining("tok-plan-123")
      );
    }
  });
});

describe("coach/respond — prompt content guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("includes day-agnostic SESSION REFERENCES guard in user_message system prompt", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_long_run_miles: 9,
        weekly_quality_session: "Tempo 5mi (1mi WU + 3mi @ 7:50/mi + 1mi CD)",
      }),
      conversations: [
        { role: "user", content: "What's on tap today?", created_at: "2026-04-01T20:00:00Z" },
      ],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    // user_message makes 2 Claude calls: extraction (call 0, Haiku) then coaching (call 1, Sonnet).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const coachingUserMsg = calls[1][0].messages[0].content as string;

    // The SESSION REFERENCES guard must be passed so Dean doesn't prescribe
    // specific workouts to specific days — plans are now day-agnostic.
    expect(coachingUserMsg).toContain("SESSION REFERENCES");
    expect(coachingUserMsg).toContain("day-agnostic");
  });
});

describe("coach/respond — reasoning preamble stripping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("strips <rule> tags that leak into Claude's output", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "<rule>CRITICAL MILEAGE DISCREPANCY: athlete says 21mi but Strava shows 9mi.</rule>\n\nI'm seeing a mismatch — Strava shows 9 miles last week." }],
    });
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    const sentText = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sentText).not.toContain("<rule>");
    expect(sentText).not.toContain("CRITICAL MILEAGE DISCREPANCY");
    expect(sentText).toContain("I'm seeing a mismatch");
  });

  it("strips ⚠️-prefixed preamble paragraphs that Claude invents", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "⚠️ CRITICAL MILEAGE DISCREPANCY — athlete says 21mi but Strava shows 9mi.\n\nI'm seeing a mismatch — Strava shows 9 miles last week." }],
    });
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    const sentText = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sentText).not.toContain("⚠️");
    expect(sentText).not.toContain("CRITICAL MILEAGE DISCREPANCY");
    expect(sentText).toContain("I'm seeing a mismatch");
  });

  it("strips content before RESPONSE: label separator", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "⚠️ CRITICAL MILEAGE DISCREPANCY — athlete says 21mi but Strava shows 9mi.\nThis is a 2.4× discrepancy. I cannot build a plan until this is resolved.\nRESPONSE:\nI'm seeing a mismatch — Strava shows 9 miles last week." }],
    });
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    const sentText = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sentText).not.toContain("CRITICAL MILEAGE DISCREPANCY");
    expect(sentText).not.toContain("RESPONSE:");
    expect(sentText).toContain("I'm seeing a mismatch");
  });
});

describe("coach/respond — web search block filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("strips pre-search reasoning when response contains server_tool_use blocks", async () => {
    // Simulates web_search_20250305: the SDK returns "server_tool_use" (not "tool_use")
    // for the search request and "web_search_tool_result" for the result.
    // Text blocks BEFORE the last non-text block are reasoning and must not be sent.
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [
        { type: "text", text: "⚠️ GOAL DISCREPANCY DETECTED — checking race dates." },
        { type: "server_tool_use", id: "su_1", name: "web_search", input: { query: "Bay to Breakers 2026 date" } },
        { type: "web_search_tool_result", tool_use_id: "su_1", content: [] },
        { type: "text", text: "Now let me search for the course profile. Perfect, I have what I need." },
        { type: "server_tool_use", id: "su_2", name: "web_search", input: { query: "Bay to Breakers course profile" } },
        { type: "web_search_tool_result", tool_use_id: "su_2", content: [] },
        { type: "text", text: "Bay to Breakers is May 17 — 46 days out. Here's this week's plan." },
      ],
    });

    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const calls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const sentText = calls.map((c: unknown[]) => c[1] as string).join("\n");

    // Only the post-search coaching message should be sent
    expect(sentText).toContain("Bay to Breakers is May 17");
    // Pre-search reasoning must not appear
    expect(sentText).not.toContain("GOAL DISCREPANCY");
    expect(sentText).not.toContain("Now let me search");
  });

  it("sends all text blocks normally when no tool blocks are present", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [
        { type: "text", text: "Good run today!" },
        { type: "text", text: "Keep it up this week." },
      ],
    });

    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const calls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const sentText = calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sentText).toContain("Good run today");
    expect(sentText).toContain("Keep it up this week");
  });
});

describe("coach/respond — initial_plan closing message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    // Reset Claude mock — prior suites may have overridden it with web-search responses
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Easy run today!" }],
    });
  });

  it("calls generateAndSaveFullPlan with skipLinkSms=true and sends closing message", async () => {
    // The dashboard link is now included in our own closing message (not sent from
    // generateAndSaveFullPlan), so skipLinkSms must be true to avoid a duplicate link SMS.
    const { generateAndSaveFullPlan } = await import("@/lib/training-plan");
    const { sendSMS } = await import("@/lib/linq");

    setupSupabase({
      user: baseUser({ dashboard_token: null, onboarding_data: { weekly_miles: 20 } }),
      profile: baseProfile({ goal: "general_fitness" }),
      state: baseState({ current_week: 1 }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "initial_plan" });
    await POST(req);
    await flush();

    // generateAndSaveFullPlan must be called with skipLinkSms: true
    const gpCalls = (generateAndSaveFullPlan as ReturnType<typeof vi.fn>).mock.calls;
    expect(gpCalls.length).toBeGreaterThan(0);
    const opts = gpCalls[0][4] as Record<string, unknown>;
    expect(opts.skipLinkSms).toBe(true);

    // Closing message invites feedback
    const allTexts = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );
    const combined = allTexts.join("\n");
    expect(combined).toMatch(/how does this look/i);
  });
});

describe("coach/respond — initial_plan beginner tier (stale Strava history)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Let's get you started!" }],
    });
  });

  it("uses beginner-stale-history fitness tier when fitness_level=beginner and weekly_miles=16", async () => {
    // A user who self-identifies as a beginner but has old Strava activity (16mi/week)
    // must NOT get the MODERATE VOLUME fitness tier. The system prompt should call out
    // that the Strava history is stale and cap the plan at beginner levels.
    setupSupabase({
      user: baseUser({ dashboard_token: null, onboarding_data: { weekly_miles: 16 } }),
      profile: baseProfile({ fitness_level: "beginner" }),
      state: baseState({ current_week: 1 }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "initial_plan" });
    await POST(req);
    await flush();

    // Find the main Sonnet call — it has a long system prompt (not the short Haiku calls)
    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const sonnetCall = calls.find((c: unknown[]) => {
      const args = c[0] as Record<string, unknown>;
      return typeof args.system === "string" && (args.system as string).length > 200;
    });
    expect(sonnetCall).toBeDefined();
    const systemPrompt = (sonnetCall![0] as Record<string, unknown>).system as string;

    expect(systemPrompt).toContain("stale history");
    expect(systemPrompt).not.toContain("MODERATE VOLUME");
  });
});

describe("coach/respond — post_run cadence follow-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Great run!" }],
    });
  });

  // Cadence is now defaulted to nightly_reminders at plan generation time.
  // The post-run handler never sends a cadence question regardless of onboarding_step.
  it("never appends a cadence question on post-run (cadence is set at plan generation)", async () => {
    setupSupabase({
      user: baseUser({ onboarding_step: null }),
      profile: baseProfile(),
      state: baseState(),
    });

    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    const allTexts = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );

    expect(
      allTexts.some((t) => /morning of|evening before/i.test(t))
    ).toBe(false);
  });
});

describe("coach/respond — injury_hold trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("sets injury_hold_since and stores pre_injury_mileage_target when not already on hold", async () => {
    const stateChain = makeChain({
      data: { weekly_mileage_target: 28, injury_hold_since: null },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "training_state") return stateChain;
      return makeChain({ data: null, error: null });
    });

    const req = mockRequest({ userId: "user-001", trigger: "injury_hold" });
    const result = await POST(req);
    await flush();

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const holdUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => payload?.injury_hold_since != null
    );
    expect(holdUpdate).toBeDefined();
    expect(holdUpdate![0].pre_injury_mileage_target).toBe(28);
    expect(holdUpdate![0].weekly_mileage_target).toBe(0);
    expect(holdUpdate![0].weekly_plan_sessions).toBeNull();
    expect((result as { data: unknown }).data).toMatchObject({ ok: true });
  });

  it("skips update when already on hold", async () => {
    const stateChain = makeChain({
      data: { weekly_mileage_target: 0, injury_hold_since: "2026-04-10" },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "training_state") return stateChain;
      return makeChain({ data: null, error: null });
    });

    // dry_run so the handler runs inline and we can inspect the return value
    const req = mockRequest({ userId: "user-001", trigger: "injury_hold", dry_run: true });
    const result = await POST(req);
    await flush();

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.length).toBe(0);
    expect((result as { data: unknown }).data).toMatchObject({ ok: true, skipped: "already_on_hold" });
  });
});

describe("coach/respond — injury_clear trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("clears injury_hold_since and pre_injury_mileage_target, then fires generateAndSaveFullPlan", async () => {
    const holdDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // ~10 days ago — clearly in the 2-week ramp bucket (≥2w, <3w)
    const stateChain = makeChain({
      data: { injury_hold_since: holdDate, pre_injury_mileage_target: 30, weekly_mileage_target: 0 },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: { phone_number: "+12025550001", strava_athlete_id: null, onboarding_data: {} }, error: null });
      if (table === "training_profiles") return makeChain({ data: { goal: "half_marathon", race_date: null }, error: null });
      if (table === "training_state") return stateChain;
      if (table === "races") return makeChain({ data: [], error: null });
      return makeChain({ data: null, error: null });
    });

    const req = mockRequest({ userId: "user-001", trigger: "injury_clear" });
    const result = await POST(req);
    await flush();

    // Should clear the hold
    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const clearUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => payload?.injury_hold_since === null
    );
    expect(clearUpdate).toBeDefined();
    expect(clearUpdate![0].pre_injury_mileage_target).toBeNull();

    // Should trigger plan rebuild with 60% ramp (2 weeks injured)
    const { generateAndSaveFullPlan } = await import("@/lib/training-plan");
    expect(generateAndSaveFullPlan).toHaveBeenCalled();
    const callArgs = (generateAndSaveFullPlan as ReturnType<typeof vi.fn>).mock.calls[0];
    // prescribedWeek1Miles should be 60% of 30 = 18mi
    expect(callArgs[3]).toBeCloseTo(18, 0); // avgWeeklyMileage arg (null → returnBase used via prescribedWeek1Miles)
    const opts = callArgs[4] as Record<string, unknown>;
    expect(opts.prescribedWeek1Miles).toBeCloseTo(18, 0);
    expect(opts.resetToWeek1).toBe(false);

    expect((result as { data: unknown }).data).toMatchObject({ ok: true });
  });
});

describe("coach/respond — lighter_week trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("reduces weekly_mileage_target by 25% and clears weekly_plan_sessions", async () => {
    const stateChain = makeChain({
      data: { weekly_mileage_target: 40 },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "training_state") return stateChain;
      return makeChain({ data: null, error: null });
    });

    // Non-dry_run: POST returns immediately, update runs inside after()
    const req = mockRequest({ userId: "user-001", trigger: "lighter_week" });
    await POST(req);
    await flush();

    // 40 * 0.75 = 30 → rounded to nearest 0.5 = 30
    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const lighterUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => payload?.weekly_mileage_target != null
    );
    expect(lighterUpdate).toBeDefined();
    expect(lighterUpdate![0].weekly_mileage_target).toBeCloseTo(30, 0);
    expect(lighterUpdate![0].weekly_plan_sessions).toBeNull();
  });

  it("returns correct previous_target and new_target, rounding to nearest 0.5", async () => {
    // 35 * 0.75 = 26.25 → Math.round(26.25 * 2) / 2 = Math.round(52.5) / 2 = 53 / 2 = 26.5
    const stateChain = makeChain({
      data: { weekly_mileage_target: 35 },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "training_state") return stateChain;
      return makeChain({ data: null, error: null });
    });

    // dry_run so the return value is inline (includes previous_target / new_target)
    const req = mockRequest({ userId: "user-001", trigger: "lighter_week", dry_run: true });
    const result = await POST(req);

    expect((result as { data: unknown }).data).toMatchObject({ ok: true, previous_target: 35, new_target: 26.5 });
  });
});

// ---------- helpers for date-sensitive tests ----------

/**
 * Returns a session date string in M/D format for a given offset from today.
 * Uses the same timezone as baseUser() ("America/New_York") so that comparisons
 * against the route's activity-date logic (which also uses the user's timezone)
 * remain correct even when CI runs in UTC.
 */
function sessionDateOffset(offsetDays: number, timezone = "America/New_York"): string {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d);
  const [, m, day] = localStr.split("-").map(Number);
  return `${m}/${day}`;
}

describe("coach/respond — nightly_reminder end-of-week guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Great week — plan coming tonight!" }],
    });
  });

  it("sends no-guess guard to Claude when no plan exists (all plan columns null)", async () => {
    // No week-level plan at all — weekly_mileage_target, weekly_long_run_miles, weekly_quality_session all null.
    // This can happen if initial_plan hasn't fired yet or a plan wipe left no data.
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_mileage_target: null,
        weekly_long_run_miles: null,
        weekly_quality_session: null,
        weekly_plan_sessions: null,
      }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "nightly_reminder" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const systemPrompt = calls[0][0].system as string;
    const userMsg = calls[0][0].messages[0].content as string;

    // Guard must be present — reminders never prescribe a specific today's workout
    // (stated once in PRINCIPLES principle 8 in the system prompt, applies to all reminder branches).
    expect(systemPrompt).toContain("never prescribe a specific");
    // No-plan branch must be active in the user message — not the normal reminder text
    expect(userMsg).toContain("plan for next week is coming tonight");
    expect(userMsg).not.toContain("Heads up —");
  });

  it("does NOT activate the guard when a week-level plan exists", async () => {
    // Normal case — weekly_mileage_target is set (standard baseState).
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(), // weekly_mileage_target: 30 by default
    });

    const req = mockRequest({ userId: "user-001", trigger: "nightly_reminder" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const userMsg = calls[0][0].messages[0].content as string;

    // Should use the normal reminder path, NOT the guard
    expect(userMsg).not.toContain("Do NOT mention a specific workout");
  });
});

describe("coach/respond — projected mileage cap when sessions are null", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("replaces wildly over-target projection when weekly_plan_sessions is null", async () => {
    // Claude returns "on track for ~77.2 mi" but the weekly target is 40mi
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Nice run! 8.2 mi logged this week. You've got sessions left — on track for ~77.2 mi this week." }],
    });

    setupSupabase({
      user: baseUser({ strava_athlete_id: 12345 }),
      profile: baseProfile(),
      state: baseState({
        weekly_mileage_target: 40,
        weekly_plan_sessions: null, // no session data — the triggering condition
      }),
    });

    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    const sentText = (sendSMS as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[1] as string)
      .join("\n");

    // The hallucinated 77.2 should be replaced with the 40mi target
    expect(sentText).not.toContain("77.2");
    expect(sentText).toContain("40");
  });

  it("leaves projections alone when they are within 30% of the target", async () => {
    // 42mi on a 40mi target = 5% over — should not be corrected
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Good work — on track for ~42 mi this week." }],
    });

    setupSupabase({
      user: baseUser({ strava_athlete_id: 12345 }),
      profile: baseProfile(),
      state: baseState({
        weekly_mileage_target: 40,
        weekly_plan_sessions: null,
      }),
    });

    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    const sentText = (sendSMS as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[1] as string)
      .join("\n");

    expect(sentText).toContain("42");
  });
});

describe("coach/respond — skipped non-run session detection on post_run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Great run!" }],
    });
  });

  it("injects PLAN DEVIATION guard when athlete runs on a strength day", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_plan_sessions: [
          { day: "Tue", date: sessionDateOffset(0), label: "Strength + mobility 30min" },
          { day: "Thu", date: sessionDateOffset(2), label: "Easy 4mi" },
        ],
      }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    // post_run with no conversations = 1 Claude call
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const coachingCall = calls[calls.length - 1];
    const userMsg = coachingCall[0].messages[0].content as string;

    expect(userMsg).toContain("PLAN DEVIATION — NON-RUN DAY");
    expect(userMsg).toContain("Strength + mobility 30min");
  });

  it("does NOT inject the guard when athlete runs on a planned run day", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_plan_sessions: [
          { day: "Tue", date: sessionDateOffset(0), label: "Easy 6mi @ 9:00/mi" },
          { day: "Thu", date: sessionDateOffset(2), label: "Tempo 5mi" },
        ],
      }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const coachingCall = calls[calls.length - 1];
    const userMsg = coachingCall[0].messages[0].content as string;

    expect(userMsg).not.toContain("PLAN DEVIATION — NON-RUN DAY");
  });
});
