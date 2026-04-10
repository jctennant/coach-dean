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

describe("coach/respond — 'my plan' keyword early-exit", () => {
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
        { role: "user",      content: "My plan",                                         created_at: "2026-03-30T10:50:00Z" },
        { role: "assistant", content: "Your training plan isn't ready yet",              created_at: "2026-03-30T10:06:00Z" },
        { role: "user",      content: "My plan",                                         created_at: "2026-03-30T10:06:00Z" },
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
        { role: "user", content: "My plan", created_at: "2026-03-30T10:50:00Z" },
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

  it("does NOT early-exit when latest message is not 'my plan'", async () => {
    setupSupabase({
      user: baseUser({ dashboard_token: "tok-abc" }),
      profile: baseProfile(),
      state: baseState(),
      conversations: [
        { role: "user", content: "How's my tempo pace looking?", created_at: "2026-03-30T10:50:00Z" },
        { role: "user", content: "My plan",                      created_at: "2026-03-30T09:00:00Z" },
      ],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    // Normal Claude path taken
    expect(anthropic.messages.create).toHaveBeenCalled();
  });

  it("early-exits with dashboard link for natural-language plan requests", async () => {
    // "Could you send me my plan for training for bay to breakers?" was going through
    // to Claude, which used web search and generated an inline plan instead of the link.
    const variants = [
      "Could you send me my plan for training for bay to breakers?",
      "send me my training plan",
      "can you show me my plan",
      "I want to view my training plan",
      // Verbose phrasing that previously fell through to Claude (Issue 4 regression)
      "Show me the entire week by week plan",
      "show me my full plan",
    ];

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

  it("includes SESSION DAY LABELING instruction in user_message system prompt", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_plan_sessions: [
          { day: "Wed", date: "4/1", label: "Easy 3mi" },
          { day: "Thu", date: "4/2", label: "Tempo 4mi" },
        ],
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
    // SESSION DAY LABELING lives in the user message (buildUserMessage), not the system prompt.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const coachingUserMsg = calls[1][0].messages[0].content as string;

    // The SESSION DAY LABELING guard must be passed to Claude so Dean knows to
    // cross-check stored session dates against today rather than inferring from list order.
    expect(coachingUserMsg).toContain("SESSION DAY LABELING");
    expect(coachingUserMsg).toContain("cross-check the session");
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

  it("calls generateAndSaveFullPlan with skipLinkSms=true and sends no cadence question", async () => {
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

    // No cadence question should be sent at plan time — it's deferred until the
    // user responds to the plan (via inbound SMS or post-run)
    const allTexts = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );
    const combined = allTexts.join("\n");
    expect(combined).not.toMatch(/morning of|evening before|reminder.*workout|workout.*reminder/i);
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

  it("appends cadence question after post-run response when onboarding_step is awaiting_cadence", async () => {
    setupSupabase({
      user: baseUser({
        onboarding_step: "awaiting_cadence",
        strava_athlete_id: "strava-123",
        onboarding_data: { timezone_confirmed: true },
      }),
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

    // Cadence question must appear as a follow-up SMS
    expect(
      allTexts.some((t) => /morning of|evening before/i.test(t))
    ).toBe(true);
  });

  it("does NOT append cadence question for a fully onboarded post-run user", async () => {
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

describe("coach/respond — sync_sessions trigger (extractAndStorePlanSessions tool use)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("calls save_plan_sessions tool and persists extracted sessions to training_state", async () => {
    const planText = "Mon 4/7 · Easy 5mi\nWed 4/9 · Tempo 4mi (2mi @ 8:00)\nSat 4/12 · Long run 10mi";
    const extractedSessions = [
      { day: "Mon", date: "4/7", label: "Easy 5mi", optional: false },
      { day: "Wed", date: "4/9", label: "Tempo 4mi (2mi @ 8:00)", optional: false },
      { day: "Sat", date: "4/12", label: "Long run 10mi", optional: false },
    ];

    // Build separate chains so we can inspect update() call args on training_state.
    // training_state is read twice (handleSyncSessions + syncArcCurrentWeek), so we
    // return sessions on both reads — simulating what was just written.
    const stateChain = makeChain({
      data: { current_week: 3, current_phase: "base", weekly_plan_sessions: extractedSessions },
      error: null,
    });

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: { id: "user-001", name: "Jake" }, error: null });
      if (table === "training_profiles") return makeChain({ data: { goal: "half_marathon" }, error: null });
      if (table === "training_state") return stateChain;
      if (table === "conversations") return makeChain({ data: { content: planText }, error: null });
      if (table === "training_plans") return makeChain({
        data: { id: "plan-1", weeks: [{ week_number: 3, phase: "base", mileage_target: 28, long_run_target: 10, key_workout: "Tempo", notes: "" }] },
        error: null,
      });
      return makeChain({ data: null, error: null });
    });

    // First Haiku call: extractAndStorePlanSessions — must use save_plan_sessions tool
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "tool-1", name: "save_plan_sessions", input: { sessions: extractedSessions } }],
    });
    // Second Haiku call: syncArcCurrentWeek dashboard notes — plain text
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [{ type: "text", text: "Base building this week. Keep the tempo controlled." }],
    });

    const req = mockRequest({ userId: "user-001", trigger: "sync_sessions" });
    await POST(req);
    await flush();

    // Verify extractAndStorePlanSessions used the tool_use format
    const llmCalls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const extractionCall = llmCalls[0][0] as Record<string, unknown>;
    expect(extractionCall.tools).toBeDefined();
    const tool = (extractionCall.tools as Array<Record<string, unknown>>)[0];
    expect(tool.name).toBe("save_plan_sessions");
    expect(extractionCall.tool_choice).toEqual({ type: "tool", name: "save_plan_sessions" });

    // Verify training_state was updated with the sessions from the tool response
    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const sessionUpdate = updateCalls.find(
      (c: unknown[]) => c[0] != null && typeof c[0] === "object" && "weekly_plan_sessions" in (c[0] as object)
    );
    expect(sessionUpdate).toBeDefined();
    expect((sessionUpdate![0] as Record<string, unknown>).weekly_plan_sessions).toEqual(extractedSessions);
  });

  it("returns ok:true with no SMS side effects", async () => {
    const stateChain = makeChain({ data: { current_week: 1, current_phase: "base", weekly_plan_sessions: [] }, error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: { id: "user-001", name: "Jake" }, error: null });
      if (table === "training_profiles") return makeChain({ data: { goal: "5k" }, error: null });
      if (table === "training_state") return stateChain;
      if (table === "conversations") return makeChain({ data: null, error: null }); // no plan message
      return makeChain({ data: null, error: null });
    });

    const req = mockRequest({ userId: "user-001", trigger: "sync_sessions" });
    await POST(req);
    await flush();

    // sync_sessions never sends SMS
    const { sendSMS } = await import("@/lib/linq");
    expect(sendSMS).not.toHaveBeenCalled();
  });
});
