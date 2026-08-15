import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRequest } from "../helpers/supabase-mock";

// ---------- system-prompt normalization ----------
// The coach call sends `system` as a cached-prefix array ([{text: static}, {text: dynamic}])
// for the main path, but some lighter paths still pass a plain string. This flattens either
// shape into the full prompt text so assertions can search the whole thing.
function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

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
  sendMediaSMS: vi.fn().mockResolvedValue(undefined),
  startTyping: vi.fn().mockResolvedValue(undefined),
  typingDurationMs: vi.fn().mockReturnValue(0),
}));

vi.mock("@/lib/photon", () => ({
  sendPoll: vi.fn().mockResolvedValue(undefined),
  isPhotonProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/track", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weather", () => ({
  fetchWeekWeather: vi.fn().mockResolvedValue(null),
  buildWeatherBlock: vi.fn().mockReturnValue(""),
}));

// Partial mock: only the DB/LLM-touching plan functions are stubbed. The pure computation
// helpers (skeletons, rehab scheduling, digests) are the real ones — stubbing them would make
// these tests assert against fabricated schedules rather than the ones athletes actually get.
vi.mock("@/lib/training-plan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/training-plan")>()),
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
import { sendPoll, isPhotonProvider } from "@/lib/photon";
import { PAIN_CHECKIN_POLL } from "@/lib/polls";

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
  /** training_plans row — needed by paths that read the stored arc (e.g. plan questions). */
  plan?: Record<string, unknown> | null;
  /** pain_checkins rows — {date, pain_level} — for the pain-trend block. */
  painCheckins?: Array<Record<string, unknown>>;
}) {
  // Reuse the same chain for training_state so we can inspect all update() calls.
  const stateChain = makeChain({ data: opts.state ?? null, error: null });

  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === "users") return makeChain({ data: opts.user ?? null, error: null });
    if (table === "training_profiles") return makeChain({ data: opts.profile ?? null, error: null });
    if (table === "training_state") return stateChain;
    if (table === "races") return makeChain({ data: opts.races ?? null, error: null });
    if (table === "conversations") return makeChain({ data: opts.conversations ?? null, error: null });
    if (table === "training_plans" && opts.plan) return makeChain({ data: opts.plan, error: null });
    if (table === "pain_checkins") return makeChain({ data: opts.painCheckins ?? null, error: null });
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
    return systemText(calls[0]?.[0]?.system);
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

describe("coach/respond — 'dashboard' keyword falls through to Claude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  });

  it("routes 'dashboard' message through normal Claude user_message path", async () => {
    setupSupabase({
      user: baseUser({ dashboard_token: "tok-ian-abc" }),
      profile: baseProfile(),
      state: baseState(),
      conversations: [
        { role: "user", content: "dashboard", created_at: "2026-03-30T10:50:00Z" },
      ],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    // Falls through to Claude — no early-exit
    expect(anthropic.messages.create).toHaveBeenCalled();
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
    // user_message makes 3 Claude calls: extraction (call 0), intent classifier (call 1), coaching (call 2).
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const coachingUserMsg = calls[2][0].messages[0].content as string;

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

  it("strips reasoning sentences glued to the real message in the final paragraph", async () => {
    // Lori's leak: leading reasoning paragraphs PLUS a final paragraph that glued
    // trailing reasoning ("Both key sessions are done. The athlete has completed…")
    // directly onto the actual coaching message ("Got it — the lap button catch…").
    // Paragraph-level stripping removes the leading paragraphs but never touches the
    // final one, so the sentence-level pass must remove the glued reasoning prefix.
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text:
        "I need to read the thread first to understand the context. Looking at RECENT CONVERSATION, the athlete has been receiving post-run coaching messages.\n\n" +
        "This is a FOLLOW-UP IN AN ACTIVE THREAD — they're answering my question about Lap 8.\n\n" +
        "What to do: Acknowledge their explanation briefly. Checking THIS WEEK'S sessions.\n\n" +
        "Both key sessions are done. The athlete has completed their week's core work in one session. Got it — the lap button catch explains it. You knocked out the speed work, which was the main event this week."
      }],
    });
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    const sentText = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    // The real coaching message survives
    // Em dash is now deterministically split into a period (normalizeEmDashes)
    expect(sentText).toContain("Got it. The lap button catch explains it");
    expect(sentText).toContain("You knocked out the speed work");
    // No reasoning leaks through — including the glued final-paragraph prefix
    expect(sentText).not.toContain("the athlete");
    expect(sentText).not.toContain("RECENT CONVERSATION");
    expect(sentText).not.toContain("FOLLOW-UP IN AN ACTIVE THREAD");
    expect(sentText).not.toContain("What to do:");
    expect(sentText).not.toContain("Both key sessions are done");
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

  it("calls generateAndSaveFullPlan and sends closing message inviting feedback", async () => {
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

    // generateAndSaveFullPlan must have been called
    const gpCalls = (generateAndSaveFullPlan as ReturnType<typeof vi.fn>).mock.calls;
    expect(gpCalls.length).toBeGreaterThan(0);

    // Closing message asks for a concrete yes/no confirmation rather than an open-ended
    // "how does this look?" — see the 2026-07-22 changelog on why an unconstrained close
    // led to athletes going quiet instead of confirming.
    const allTexts = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );
    const combined = allTexts.join("\n");
    expect(combined).toMatch(/reply yes/i);
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
      return systemText(args.system).length > 200;
    });
    expect(sonnetCall).toBeDefined();
    const systemPrompt = systemText((sonnetCall![0] as Record<string, unknown>).system);

    expect(systemPrompt).toContain("stale history");
    expect(systemPrompt).not.toContain("MODERATE VOLUME");
  });
});

describe("coach/respond — structured plan.weekly_total (deliver_message plan facts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("requires the plan field on the deliver_message tool for initial_plan", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "This week I'd aim for 12 miles, one quality session mid-week. Total: 12 mi.",
        plan: { weekly_total: 12 },
      } }],
    });
    setupSupabase({
      user: baseUser({ dashboard_token: null, onboarding_data: { weekly_miles: 10 } }),
      profile: baseProfile(),
      state: baseState({ current_week: 1 }),
    });
    const req = mockRequest({ userId: "user-001", trigger: "initial_plan" });
    await POST(req);
    await flush();

    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    const sonnetCall = create.mock.calls.find((c: unknown[]) => {
      const args = c[0] as Record<string, unknown>;
      return systemText(args.system).length > 200;
    });
    expect(sonnetCall).toBeDefined();
    const tools = (sonnetCall![0] as { tools?: Array<{ name?: string; input_schema?: { required?: string[] } }> }).tools ?? [];
    const deliverTool = tools.find((t) => t.name === "deliver_message");
    expect(deliverTool?.input_schema?.required).toContain("plan");
  });

  it("corrects a mismatched Total: figure to match the structured weekly_total", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        // message understates the total (8) relative to the structured field (12) —
        // the structured field is source of truth and should win.
        message: "This week I'd aim for a solid build, one quality session mid-week. Total: 8 mi.",
        plan: { weekly_total: 12 },
      } }],
    });
    setupSupabase({
      user: baseUser({ dashboard_token: null, onboarding_data: { weekly_miles: 10 } }),
      profile: baseProfile(),
      state: baseState({ current_week: 1 }),
    });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "initial_plan" });
    await POST(req);
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Total: 12 mi");
    expect(sent).not.toContain("Total: 8 mi");
  });

  it("clamps a structured weekly_total that blows past the safe Week-1 cap", async () => {
    // avg weekly_miles=5 (low-volume tier) → cap max = max(ceil(5*1.3), 6) = 7.
    // Claude reports 30 — a clear blowout that must be clamped, not sent as-is.
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "Let's build a strong base this week. Total: 30 mi.",
        plan: { weekly_total: 30 },
      } }],
    });
    setupSupabase({
      user: baseUser({ dashboard_token: null, onboarding_data: { weekly_miles: 5 } }),
      profile: baseProfile(),
      state: baseState({ current_week: 1 }),
    });
    const { sendSMS } = await import("@/lib/linq");
    const { trackEvent } = await import("@/lib/track");
    const req = mockRequest({ userId: "user-001", trigger: "initial_plan" });
    await POST(req);
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Total: 7 mi");
    expect(sent).not.toContain("Total: 30 mi");
    expect(trackEvent).toHaveBeenCalledWith(
      "user-001",
      "plan_weekly_total_clamped",
      expect.objectContaining({ trigger: "initial_plan", statedTotal: 30 })
    );
  });

  it("does not require the plan field for non-plan triggers", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: { message: "Nice easy run today!" } }],
    });
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "post_run" });
    await POST(req);
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Nice easy run today!");
  });

  it("tracks an advisory event when structured long_run_distance exceeds the low-volume cap", async () => {
    // avg weekly_miles=5 (low-volume) -> long run cap = max(ceil(5*0.35),3) = 3
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "This week I'd aim for 6 miles, with a long run around 6 miles. Total: 6 mi.",
        plan: { weekly_total: 6, long_run_distance: 6 },
      } }],
    });
    setupSupabase({
      user: baseUser({ dashboard_token: null, onboarding_data: { weekly_miles: 5 } }),
      profile: baseProfile(),
      state: baseState({ current_week: 1 }),
    });
    const { trackEvent } = await import("@/lib/track");
    const req = mockRequest({ userId: "user-001", trigger: "initial_plan" });
    await POST(req);
    await flush();

    expect(trackEvent).toHaveBeenCalledWith(
      "user-001",
      "plan_long_run_exceeded_cap",
      expect.objectContaining({ trigger: "initial_plan", statedLongRun: 6, longRunCap: 3 })
    );
  });

  it("tracks an advisory event when a structured quality-session pace isn't faster than easy pace", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "This week: 20 miles total with a tempo run at 9:30/mi. Total: 20 mi.",
        plan: {
          weekly_total: 20,
          quality_sessions: [{ distance: 4, pace: "9:30/mi" }], // slower than stored easy pace below
        },
      } }],
    });
    setupSupabase({
      user: baseUser({ dashboard_token: null, onboarding_data: { weekly_miles: 20 } }),
      profile: baseProfile({ current_easy_pace: "9:00/mi" }),
      state: baseState({ current_week: 1 }),
    });
    const { trackEvent } = await import("@/lib/track");
    const req = mockRequest({ userId: "user-001", trigger: "initial_plan" });
    await POST(req);
    await flush();

    expect(trackEvent).toHaveBeenCalledWith(
      "user-001",
      "plan_quality_pace_not_faster_than_easy",
      expect.objectContaining({ trigger: "initial_plan", qualityPace: "9:30/mi", easyPace: "9:00/mi" })
    );
  });

  it("does not flag a quality pace that is genuinely faster than easy pace", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "This week: 20 miles total with a tempo run at 8:00/mi. Total: 20 mi.",
        plan: {
          weekly_total: 20,
          quality_sessions: [{ distance: 4, pace: "8:00/mi" }],
        },
      } }],
    });
    setupSupabase({
      user: baseUser({ dashboard_token: null, onboarding_data: { weekly_miles: 20 } }),
      profile: baseProfile({ current_easy_pace: "9:00/mi" }),
      state: baseState({ current_week: 1 }),
    });
    const { trackEvent } = await import("@/lib/track");
    const req = mockRequest({ userId: "user-001", trigger: "initial_plan" });
    await POST(req);
    await flush();

    expect(trackEvent).not.toHaveBeenCalledWith(
      "user-001",
      "plan_quality_pace_not_faster_than_easy",
      expect.anything()
    );
  });
});

describe("coach/respond — enforceVolumeCaps re-gated to user_message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("scales down an over-cap dated session list in a user_message schedule response", async () => {
    // avg weekly_miles=5 (low-volume) -> weekly cap = max(ceil(5*1.3),6) = 7
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "Here's the updated schedule:\nMon 3/9 · Easy 5mi\nWed 3/11 · Easy 5mi\nSat 3/14 · Long run 5mi\nTotal: 15mi",
      } }],
    });
    setupSupabase({
      user: baseUser({ onboarding_data: { weekly_miles: 5 } }),
      profile: baseProfile(),
      state: baseState(),
    });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).not.toContain("Total: 15mi");
    const totalMatch = sent.match(/Total:\s*~?(\d+(?:\.\d+)?)\s*mi/);
    expect(totalMatch).toBeTruthy();
    expect(parseFloat(totalMatch![1])).toBeLessThanOrEqual(7.5);
  });

  it("does not touch a moderate-volume athlete's user_message session list", async () => {
    // avg weekly_miles=25 (moderate) -> no low-volume cap applies at all
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "Here's the updated schedule:\nMon 3/9 · Easy 8mi\nWed 3/11 · Tempo 6mi\nSat 3/14 · Long run 14mi\nTotal: 28mi",
      } }],
    });
    setupSupabase({
      user: baseUser({ onboarding_data: { weekly_miles: 25 } }),
      profile: baseProfile(),
      state: baseState(),
    });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Total: 28mi");
  });
});

describe("coach/respond — fixSessionDayAbbreviations wired into user_message (date/weekday hallucination guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    // Sunday, July 12, 2026 — same date the "Dean doesn't know what day it is" bug
    // was reported on, so a nearby session date exercises the same-month path.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T15:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("corrects a weekday abbreviation that doesn't match its stated calendar date", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        // July 13, 2026 is a Monday — this claims it's a Tuesday.
        message: "Here's the updated schedule:\nTue 7/13 · Easy 5mi\nTotal: 5mi",
      } }],
    });
    setupSupabase({
      user: baseUser({ onboarding_data: { weekly_miles: 25 } }),
      profile: baseProfile(),
      state: baseState(),
    });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Mon 7/13");
    expect(sent).not.toContain("Tue 7/13");
  });

  it("leaves an already-correct weekday abbreviation untouched", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "Here's the updated schedule:\nMon 7/13 · Easy 5mi\nTotal: 5mi",
      } }],
    });
    setupSupabase({
      user: baseUser({ onboarding_data: { weekly_miles: 25 } }),
      profile: baseProfile(),
      state: baseState(),
    });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Mon 7/13");
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
      return systemText(args.system).length > 200;
    });
    expect(sonnetCall).toBeDefined();
    const systemPrompt = systemText((sonnetCall![0] as Record<string, unknown>).system);

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
    const profileChain = makeChain({ data: null, error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "training_state") return stateChain;
      if (table === "training_profiles") return profileChain;
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

    // active_injury must be synced alongside injury_hold_since so the two signals can't
    // disagree (see 2026-07-17 changelog on the desync this fixes).
    const profileUpdateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const activeInjuryUpdate = profileUpdateCalls.find(([p]: [Record<string, unknown>]) => p?.active_injury === true);
    expect(activeInjuryUpdate).toBeDefined();
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

  it("starts RTR phase 1 (walk/run protocol) when called directly with no existing RTR phase", async () => {
    const holdDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const stateChain = makeChain({
      data: { injury_hold_since: holdDate, pre_injury_mileage_target: 30, weekly_mileage_target: 0, return_to_run_phase: null },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: { phone_number: "+12025550001", strava_athlete_id: null, onboarding_data: {}, linq_chat_id: null }, error: null });
      if (table === "training_profiles") return makeChain({ data: { goal: "half_marathon", race_date: null, injury_body_part: "shin" }, error: null });
      if (table === "training_state") return stateChain;
      if (table === "races") return makeChain({ data: [], error: null });
      return makeChain({ data: null, error: null });
    });

    const req = mockRequest({ userId: "user-001", trigger: "injury_clear" });
    const result = await POST(req);
    await flush();

    // Should set return_to_run_phase = 1 and clear injury_hold_since, but keep pre_injury_mileage_target
    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const phaseUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => payload?.return_to_run_phase === 1
    );
    expect(phaseUpdate).toBeDefined();
    expect(phaseUpdate![0].injury_hold_since).toBeNull();
    expect(phaseUpdate![0].pre_injury_mileage_target).toBeUndefined(); // kept, not cleared

    // Should send two SMS bubbles (phase 1 protocol)
    const { sendSMS } = await import("@/lib/linq");
    expect(sendSMS).toHaveBeenCalledTimes(2);
    const firstCall = (sendSMS as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(firstCall).toContain("walk/run intervals");

    // Should NOT generate a full plan yet
    const { generateAndSaveFullPlan } = await import("@/lib/training-plan");
    expect(generateAndSaveFullPlan).not.toHaveBeenCalled();

    // Non-dry-run always returns { ok: true } immediately; work runs in after()
    expect((result as { data: unknown }).data).toMatchObject({ ok: true });
  });

  it("graduates to full plan rebuild when called with return_to_run_phase = 2", async () => {
    const holdDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const stateChain = makeChain({
      data: { injury_hold_since: holdDate, pre_injury_mileage_target: 30, weekly_mileage_target: 0, return_to_run_phase: 2 },
      error: null,
    });
    const profileChain = makeChain({ data: { goal: "half_marathon", race_date: null }, error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: { phone_number: "+12025550001", strava_athlete_id: null, onboarding_data: {}, linq_chat_id: null }, error: null });
      if (table === "training_profiles") return profileChain;
      if (table === "training_state") return stateChain;
      if (table === "races") return makeChain({ data: [], error: null });
      return makeChain({ data: null, error: null });
    });

    const req = mockRequest({ userId: "user-001", trigger: "injury_clear" });
    const result = await POST(req);
    await flush();

    // Should clear hold, pre_injury_mileage_target, and return_to_run_phase
    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const clearUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => payload?.injury_hold_since === null && payload?.return_to_run_phase === null
    );
    expect(clearUpdate).toBeDefined();
    expect(clearUpdate![0].pre_injury_mileage_target).toBeNull();

    // active_injury clears at graduation (full return to running), not at RTR phase 1 start.
    const profileUpdateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const activeInjuryUpdate = profileUpdateCalls.find(([p]: [Record<string, unknown>]) => p?.active_injury === false);
    expect(activeInjuryUpdate).toBeDefined();

    // Should trigger plan rebuild with 60% ramp (2 weeks injured)
    const { generateAndSaveFullPlan } = await import("@/lib/training-plan");
    expect(generateAndSaveFullPlan).toHaveBeenCalled();
    const callArgs = (generateAndSaveFullPlan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[3]).toBeCloseTo(18, 0); // 60% of 30 = 18mi
    const opts = callArgs[4] as Record<string, unknown>;
    expect(opts.prescribedWeek1Miles).toBeCloseTo(18, 0);
    expect(opts.resetToWeek1).toBe(false);

    expect((result as { data: unknown }).data).toMatchObject({ ok: true });
  });

  it("does NOT clear active_injury when starting RTR phase 1 (still injury-adjacent monitoring)", async () => {
    const holdDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const stateChain = makeChain({
      data: { injury_hold_since: holdDate, pre_injury_mileage_target: 30, weekly_mileage_target: 0, return_to_run_phase: null },
      error: null,
    });
    const profileChain = makeChain({ data: { goal: "half_marathon", race_date: null, injury_body_part: "shin" }, error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: { phone_number: "+12025550001", strava_athlete_id: null, onboarding_data: {}, linq_chat_id: null }, error: null });
      if (table === "training_profiles") return profileChain;
      if (table === "training_state") return stateChain;
      if (table === "races") return makeChain({ data: [], error: null });
      return makeChain({ data: null, error: null });
    });

    const req = mockRequest({ userId: "user-001", trigger: "injury_clear" });
    await POST(req);
    await flush();

    const profileUpdateCalls = (profileChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const activeInjuryUpdate = profileUpdateCalls.find(([p]: [Record<string, unknown>]) => Object.prototype.hasOwnProperty.call(p, "active_injury"));
    expect(activeInjuryUpdate).toBeUndefined();
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
    const systemPrompt = systemText(calls[0][0].system);
    const userMsg = calls[0][0].messages[0].content as string;

    // Guard must be present — with no dated sessions on file, reminders name what's
    // outstanding this week rather than a specific today's workout (principle 8's
    // no-day-assignments branch in the system prompt, applies to all reminder branches).
    expect(systemPrompt).toContain("no day assignments on file");
    expect(systemPrompt).toContain(`not a specific "today's workout"`);
    // No-plan branch must be active in the user message — not the normal reminder text
    expect(userMsg).toContain("plan for next week is coming tonight");
    expect(userMsg).not.toContain("Heads up —");
  });

  it("tells Claude the week HAS assigned days when dated sessions are stored", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_plan_sessions: [
          { day: "Mon", date: "8/10", label: "Easy 4mi", type: "run" },
          { day: "Sat", date: "8/15", label: "Long run 7mi", type: "run" },
        ],
      }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = systemText(calls[calls.length - 1][0].system);
    // The day-agnostic framing must NOT be offered to an athlete whose plan has days —
    // that contradiction is what produced "doesn't matter what day" answers (2026-08-09).
    expect(systemPrompt).toContain("HAS assigned days");
    expect(systemPrompt).not.toContain("no day assignments on file");
    expect(systemPrompt).not.toContain("The plan is day-agnostic");
    expect(systemPrompt).not.toContain("Plans are day-agnostic");
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

describe("coach/respond — injury hold broken via post_run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Great run!" }],
    });
  });

  function setupWithActivity(activityType: string) {
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: baseUser(), error: null });
      if (table === "training_profiles") return makeChain({ data: baseProfile(), error: null });
      if (table === "training_state") return makeChain({ data: baseState({ injury_hold_since: "2026-08-14" }), error: null });
      if (table === "activities") {
        // Same split as setupOnboardingSupabase above: range/list queries need an array,
        // the .single() lookup by strava_activity_id needs the one triggering activity.
        const chain = makeChain({ data: [], error: null }) as Record<string, unknown>;
        chain.single = vi.fn().mockResolvedValue({
          data: { activity_type: activityType, distance_meters: 6116, moving_time_seconds: 2200, average_heartrate: 130, average_pace: "8:51", elevation_gain: 50 },
          error: null,
        });
        return chain;
      }
      return makeChain({ data: null, error: null });
    });
  }

  it("tells Dean to address the broken hold instead of the standard analysis when a Run comes in during a hold", async () => {
    setupWithActivity("Run");

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const userMsg = calls[calls.length - 1][0].messages[0].content as string;

    expect(userMsg).toContain("INJURY HOLD WAS ACTIVE FOR THIS RUN");
    expect(userMsg).toContain("2026-08-14");
  });

  it("does NOT inject the guard for a cross-training activity during a hold", async () => {
    setupWithActivity("Ride");

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const userMsg = calls[calls.length - 1][0].messages[0].content as string;

    expect(userMsg).not.toContain("INJURY HOLD WAS ACTIVE FOR THIS RUN");
  });

  it("does NOT inject the guard for a Run when no hold is active", async () => {
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: baseUser(), error: null });
      if (table === "training_profiles") return makeChain({ data: baseProfile(), error: null });
      if (table === "training_state") return makeChain({ data: baseState({ injury_hold_since: null }), error: null });
      if (table === "activities") {
        const chain = makeChain({ data: [], error: null }) as Record<string, unknown>;
        chain.single = vi.fn().mockResolvedValue({
          data: { activity_type: "Run", distance_meters: 6116, moving_time_seconds: 2200, average_heartrate: 130, average_pace: "8:51", elevation_gain: 50 },
          error: null,
        });
        return chain;
      }
      return makeChain({ data: null, error: null });
    });

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const userMsg = calls[calls.length - 1][0].messages[0].content as string;

    expect(userMsg).not.toContain("INJURY HOLD WAS ACTIVE FOR THIS RUN");
  });
});

describe("coach/respond — pain trend block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Sounds like it's settling down." }],
    });
  });

  it("injects the pain trend with real logged numbers when an injury is active", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ injury_notes: "shin splints", injury_body_part: "shin", active_injury: true }),
      state: baseState(),
      painCheckins: [
        { date: "2026-08-10", pain_level: 4 },
        { date: "2026-08-12", pain_level: 2 },
        { date: "2026-08-14", pain_level: 1 },
      ],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = systemText(calls[calls.length - 1][0].system);

    expect(systemPrompt).toContain("PAIN TREND");
    expect(systemPrompt).toContain("2026-08-10: 4/10");
    expect(systemPrompt).toContain("2026-08-14: 1/10");
  });

  it("fires the progression gate with the shin functional test once the low-pain streak hits 3", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ injury_notes: "shin splints", injury_body_part: "shin", active_injury: true }),
      state: baseState(),
      painCheckins: [
        { date: "2026-08-12", pain_level: 1 },
        { date: "2026-08-13", pain_level: 0 },
        { date: "2026-08-14", pain_level: 1 },
      ],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = systemText(calls[calls.length - 1][0].system);

    expect(systemPrompt).toContain("PROGRESSION GATE MET");
    expect(systemPrompt).toContain("Single-leg hop in place");
  });

  it("does NOT inject a pain trend block when there's no active injury", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      painCheckins: [{ date: "2026-08-14", pain_level: 1 }],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = systemText(calls[calls.length - 1][0].system);

    expect(systemPrompt).not.toContain("PAIN TREND");
  });
});

describe("coach/respond — injury check-in pain poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Solid recovery run." }],
    });
    (isPhotonProvider as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  function setupRecoveryAthlete() {
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: baseUser(), error: null });
      if (table === "training_profiles") return makeChain({ data: baseProfile({ goal: "return_to_running", injury_body_part: "shin" }), error: null });
      if (table === "training_state") return makeChain({ data: baseState(), error: null });
      if (table === "activities") {
        const chain = makeChain({ data: [], error: null }) as Record<string, unknown>;
        chain.single = vi.fn().mockResolvedValue({
          data: { activity_type: "Run", distance_meters: 4828, moving_time_seconds: 1800, average_heartrate: 128, average_pace: "9:00", elevation_gain: 20 },
          error: null,
        });
        return chain;
      }
      return makeChain({ data: null, error: null });
    });
  }

  it("sends the pain check-in poll and suppresses the free-text question on Photon", async () => {
    (isPhotonProvider as ReturnType<typeof vi.fn>).mockReturnValue(true);
    setupRecoveryAthlete();

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    expect(sendPoll).toHaveBeenCalledWith(
      "+12025550001",
      PAIN_CHECKIN_POLL.title,
      PAIN_CHECKIN_POLL.options
    );

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const userMsg = calls[calls.length - 1][0].messages[0].content as string;
    expect(userMsg).toContain("that check-in is sent separately as a poll");
    expect(userMsg).not.toContain("INJURY CHECK-IN QUESTION:");
  });

  it("does NOT send the poll and keeps the free-text question on Linq (non-Photon)", async () => {
    setupRecoveryAthlete();

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    expect(sendPoll).not.toHaveBeenCalled();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const userMsg = calls[calls.length - 1][0].messages[0].content as string;
    expect(userMsg).toContain("INJURY CHECK-IN QUESTION:");
  });

  it("also fires for a race-goal athlete who is managing an active injury (not just goal=return_to_running)", async () => {
    (isPhotonProvider as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: baseUser(), error: null });
      if (table === "training_profiles") return makeChain({
        data: baseProfile({ goal: "trail_race", injury_body_part: "shin", active_injury: true }),
        error: null,
      });
      if (table === "training_state") return makeChain({ data: baseState(), error: null });
      if (table === "activities") {
        const chain = makeChain({ data: [], error: null }) as Record<string, unknown>;
        chain.single = vi.fn().mockResolvedValue({
          data: { activity_type: "Run", distance_meters: 4828, moving_time_seconds: 1800, average_heartrate: 128, average_pace: "9:00", elevation_gain: 20 },
          error: null,
        });
        return chain;
      }
      return makeChain({ data: null, error: null });
    });

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    expect(sendPoll).toHaveBeenCalledWith(
      "+12025550001",
      PAIN_CHECKIN_POLL.title,
      PAIN_CHECKIN_POLL.options
    );
  });

  it("does NOT fire for a race-goal athlete with no active injury on file", async () => {
    (isPhotonProvider as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: baseUser(), error: null });
      if (table === "training_profiles") return makeChain({
        data: baseProfile({ goal: "trail_race" }),
        error: null,
      });
      if (table === "training_state") return makeChain({ data: baseState(), error: null });
      if (table === "activities") {
        const chain = makeChain({ data: [], error: null }) as Record<string, unknown>;
        chain.single = vi.fn().mockResolvedValue({
          data: { activity_type: "Run", distance_meters: 4828, moving_time_seconds: 1800, average_heartrate: 128, average_pace: "9:00", elevation_gain: 20 },
          error: null,
        });
        return chain;
      }
      return makeChain({ data: null, error: null });
    });

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999 });
    await POST(req);
    await flush();

    expect(sendPoll).not.toHaveBeenCalled();
  });
});

describe("coach/respond — generic recovery filler is stripped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("strips 'This is exactly what recovery looks like' padding from a post_run message", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "This is exactly what recovery looks like right now. Staying aerobic while the shin heals. How's the shin feeling today?" }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ goal: "return_to_running", injury_body_part: "shin" }),
      state: baseState(),
    });

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999, dry_run: true });
    const res = await POST(req) as unknown as { data: { message: string } };

    expect(res.data.message).not.toMatch(/this is exactly what recovery looks like/i);
    expect(res.data.message).toContain("How's the shin feeling today?");
  });

  it("strips the phrase without 'exactly' or 'right now' too", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "That's what recovery looks like. Keep it up." }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ goal: "return_to_running", injury_body_part: "shin" }),
      state: baseState(),
    });

    const req = mockRequest({ userId: "user-001", trigger: "post_run", activityId: 999, dry_run: true });
    const res = await POST(req) as unknown as { data: { message: string } };

    expect(res.data.message).not.toMatch(/what recovery looks like/i);
  });
});

describe("coach/respond — rehab protocol tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("executes get_rehab_protocol and feeds the result back before replying", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    // First call: Dean requests the rehab protocol (stop_reason tool_use).
    // Second call: the final coaching text after the tool result is fed back.
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu-1", name: "get_rehab_protocol", input: { body_part: "it_band", available_tools: ["pool"] } }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "For the IT band: clamshells and lateral band walks. Pool running keeps fitness with zero IT band stress." }],
      });

    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ active_injury: true, injury_body_part: "it_band", injury_severity: "moderate", injury_body_parts: ["it_band"] }),
      state: baseState(),
    });
    const { sendSMS } = await import("@/lib/linq");
    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    // Round-trip: tool request + final response = two model calls
    expect(create.mock.calls.length).toBe(2);

    // The rehab tool was offered on the first call
    const firstTools = (create.mock.calls[0][0] as { tools?: Array<{ name?: string }> }).tools ?? [];
    expect(firstTools.some((t) => t.name === "get_rehab_protocol")).toBe(true);

    // The second call fed back a tool_result carrying the code-built protocol
    const secondMsgs = (create.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> }).messages;
    const toolResult = secondMsgs
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []))
      .find((b) => b?.type === "tool_result");
    expect(toolResult).toBeDefined();
    const trText = String((toolResult as Record<string, unknown>).content);
    expect(trText.toLowerCase()).toContain("clamshells");          // from BODY_PART_EXERCISES.it_band
    expect(trText.toLowerCase()).toContain("injury-safe cross-training"); // cross-training section present
    expect(trText.toLowerCase()).toContain("swimming");            // from CROSS_TRAINING_ALTERNATIVES.it_band

    // The athlete receives the final text, not Dean's tool-call turn
    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("IT band");
  });

  it("does not offer the rehab tool on a nightly reminder with no injury", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ content: [{ type: "text", text: "Don't forget tonight's easy run." }] });
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    await POST(mockRequest({ userId: "user-001", trigger: "nightly_reminder" }));
    await flush();
    const lastCall = create.mock.calls[create.mock.calls.length - 1];
    const tools = (lastCall?.[0] as { tools?: Array<{ name?: string }> })?.tools ?? [];
    expect(tools.some((t) => t.name === "get_rehab_protocol")).toBe(false);
  });
});

describe("coach/respond — deliver_message tool (structural reasoning-leak fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("sends the deliver_message argument verbatim, always requests tools with tool_choice any, and never runs the text-block fallback", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: { message: "Solid effort out there today!" } }],
    });
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");
    await POST(mockRequest({ userId: "user-001", trigger: "post_run" }));
    await flush();

    // Two model calls: one to generate the message (tool_choice: any, deliver_message
    // tool) — no fallback/retry needed once deliver_message is present — and one from
    // the advisory date-consistency check (date-consistency-check.ts), which fires
    // because the message mentions "today". That second call is a post-hoc validator,
    // not a regeneration of the coaching message.
    expect(create.mock.calls.length).toBe(2);
    const firstCallParams = create.mock.calls[0][0] as { tool_choice?: unknown; tools?: Array<{ name?: string }> };
    expect(firstCallParams.tool_choice).toEqual({ type: "any" });
    expect(firstCallParams.tools?.some((t) => t.name === "deliver_message")).toBe(true);

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Solid effort out there today!");
  });

  it("ignores text blocks that precede a deliver_message tool_use block in the same response", async () => {
    // Simulates a leak-prone shape: Claude emits reasoning-ish text, then still calls
    // deliver_message. The structural fix means only the tool argument is ever read.
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me check the athlete's recent mileage before responding." },
        { type: "tool_use", id: "tu-1", name: "deliver_message", input: { message: "Great long run this weekend." } },
      ],
    });
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");
    await POST(mockRequest({ userId: "user-001", trigger: "post_run" }));
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Great long run this weekend.");
    expect(sent).not.toContain("Let me check");
  });

  it("continues the get_rehab_protocol round-trip and extracts the final deliver_message call", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu-1", name: "get_rehab_protocol", input: { body_part: "it_band", available_tools: ["pool"] } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu-2", name: "deliver_message", input: { message: "For the IT band: clamshells and lateral band walks." } }],
      });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ active_injury: true, injury_body_part: "it_band", injury_severity: "moderate", injury_body_parts: ["it_band"] }),
      state: baseState(),
    });
    const { sendSMS } = await import("@/lib/linq");
    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    expect(create.mock.calls.length).toBe(2);
    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("clamshells");
  });

  it("falls back to text-block extraction when deliver_message is never called", async () => {
    const create = anthropic.messages.create as ReturnType<typeof vi.fn>;
    // No stop_reason "tool_use" and no deliver_message block — the pre-existing fallback path.
    create.mockResolvedValue({ content: [{ type: "text", text: "Easy 5mi today, keep it conversational." }] });
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const { sendSMS } = await import("@/lib/linq");
    await POST(mockRequest({ userId: "user-001", trigger: "post_run" }));
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Easy 5mi today");
  });
});

describe("coach/respond — morning_plan quality-session derivation excludes cross-train/strength slots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "Tempo day — let's get after it!" }],
    });
  });

  it("does not misread a cross-train slot's display name (e.g. 'Bike') as the week's quality session", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_plan_sessions: [
          { day: "Mon", date: sessionDateOffset(0), label: "Bike", type: "cross_train" },
          { day: "Wed", date: sessionDateOffset(2), label: "Tempo 5mi (1mi WU + 3mi @ 7:45/mi + 1mi CD)", type: "run" },
        ],
      }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "morning_plan" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const systemPrompt = systemText(calls[0][0].system);

    expect(systemPrompt).toContain("Quality session this week: YES — Tempo 5mi (1mi WU + 3mi @ 7:45/mi + 1mi CD)");
    expect(systemPrompt).not.toContain("Quality session this week: YES — Bike");
  });

  it("does not misread a strength slot's label as the week's quality session", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_plan_sessions: [
          { day: "Thu", date: sessionDateOffset(0), label: "Strength + mobility", type: "strength" },
        ],
      }),
    });

    const req = mockRequest({ userId: "user-001", trigger: "morning_plan" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = systemText(calls[0][0].system);
    expect(systemPrompt).not.toContain("Quality session this week: YES — Strength");
  });
});

describe("coach/respond — Phase B fact gate (stated_facts equality check)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  // Routes non-coach calls (Haiku extraction/classification) to a harmless text
  // response and serves coach (deliver_message-bearing) calls from the given queue.
  function mockCoachCalls(queue: Array<Record<string, unknown>>) {
    let coachCall = 0;
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { tools?: Array<{ name?: string }> }) => {
        const isCoach = Array.isArray(args?.tools) && args.tools.some((t) => t.name === "deliver_message");
        if (!isCoach) return Promise.resolve({ content: [{ type: "text", text: "{}" }] });
        const resp = queue[Math.min(coachCall, queue.length - 1)];
        coachCall++;
        return Promise.resolve(resp);
      }
    );
  }

  function deliverWithFacts(id: string, message: string, facts: Record<string, unknown>) {
    return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name: "deliver_message", input: {
        message,
        stated_facts: { week_number: null, weekly_target: null, week_distance_completed: null, days_until_race: null, ...facts },
      } }],
    };
  }

  it("requires stated_facts on the deliver_message tool for user_message", async () => {
    mockCoachCalls([deliverWithFacts("tu-1", "Nice and steady this week.", {})]);
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState() });
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const coachCall = calls.find((c: unknown[]) => {
      const args = c[0] as { tools?: Array<{ name?: string }> };
      return Array.isArray(args?.tools) && args.tools.some((t) => t.name === "deliver_message");
    });
    expect(coachCall).toBeDefined();
    const tools = (coachCall![0] as { tools: Array<{ name?: string; input_schema?: { required?: string[] } }> }).tools;
    const deliverTool = tools.find((t) => t.name === "deliver_message");
    expect(deliverTool?.input_schema?.required).toContain("stated_facts");
  });

  it("rejects a wrong week number via tool_result and sends the corrected retry", async () => {
    mockCoachCalls([
      deliverWithFacts("tu-1", "You're in week 10 of the plan — solid spot.", { week_number: 10 }),
      deliverWithFacts("tu-2", "You're in week 8 of the plan — solid spot.", { week_number: 8 }),
    ]);
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState({ current_week: 8 }) });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("week 8");
    expect(sent).not.toContain("week 10");

    // The retry call must carry the rejection tool_result back to the model.
    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const retryCall = calls.find((c: unknown[]) => {
      const args = c[0] as { messages?: Array<{ role: string; content: unknown }> };
      return (args.messages ?? []).some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("DELIVERY REJECTED")
      );
    });
    expect(retryCall).toBeDefined();
  });

  it("does not retry when stated facts match ground truth", async () => {
    mockCoachCalls([
      deliverWithFacts("tu-1", "Week 8, right on plan. Target is 30 for the week.", { week_number: 8, weekly_target: 30 }),
    ]);
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState({ current_week: 8, weekly_mileage_target: 30 }) });
    const { sendSMS } = await import("@/lib/linq");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const coachCalls = calls.filter((c: unknown[]) => {
      const args = c[0] as { tools?: Array<{ name?: string }> };
      return Array.isArray(args?.tools) && args.tools.some((t) => t.name === "deliver_message");
    });
    expect(coachCalls.length).toBe(1);
    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("Week 8");
  });

  it("fails open when the retry still mismatches — sends the retry text anyway", async () => {
    mockCoachCalls([
      deliverWithFacts("tu-1", "You're in week 10 now.", { week_number: 10 }),
      deliverWithFacts("tu-2", "You're in week 11 now.", { week_number: 11 }),
    ]);
    setupSupabase({ user: baseUser(), profile: baseProfile(), state: baseState({ current_week: 8 }) });
    const { sendSMS } = await import("@/lib/linq");
    const { trackEvent } = await import("@/lib/track");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sent).toContain("week 11");
    const events = (trackEvent as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(events).toContain("stated_facts_mismatch_after_retry");
  });
});

// ---------------------------------------------------------------------------
// plan_action — structured plan-mutation signals (replaces the old bracket-tag
// mechanism: [SESSION_SWAP], [LIGHTER_WEEK], [INJURY_HOLD], [INJURY_CLEAR],
// [RTR_ADVANCE], [REBUILD_PLAN], [PHYSIO_REFERRAL]). These tests exercise the
// actual deliver_message → dispatch path via a full user_message request,
// closing the exact gap the migration fixed: before this, nothing tested that
// Claude's real tool-call output correctly drives a plan mutation — only the
// downstream handlers were tested, called directly via `trigger`.
// ---------------------------------------------------------------------------
describe("coach/respond — plan_action structured dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  it("session_swaps: swaps a session's label in weekly_plan_sessions", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "Given the calf tightness, I've swapped Thursday's run for an easy bike instead.",
        plan_action: { session_swaps: [{ day: "Thu", to: "40min easy bike" }] },
      } }],
    });
    const { stateChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_plan_sessions: [{ day: "Thursday", date: "2026-07-30", label: "Tempo 5mi" }],
      }),
      conversations: [
        { role: "user", content: "My calf is tight, can we swap Thursday's tempo for a bike ride?", created_at: "2026-07-30T10:00:00Z" },
      ],
    });
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    await flush(); // drain the nested runAfter (session_swap/lighter_week/injury_hold/physio_referral fire from inside the outer coach/respond runAfter)

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const swapUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => Array.isArray(p?.weekly_plan_sessions));
    expect(swapUpdate).toBeDefined();
    const sessions = swapUpdate![0].weekly_plan_sessions as Array<{ day: string; label: string }>;
    expect(sessions.find((s) => s.day === "Thursday")?.label).toBe("40min easy bike");
  });

  it("session_swaps: moving a session onto a day with no existing entry creates it instead of dropping it", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "Done — moved to Thursday.",
        plan_action: { session_swaps: [{ day: "Friday", to: "rest" }, { day: "Thursday", to: "Tempo 5mi" }] },
      } }],
    });
    const { stateChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_plan_sessions: [{ day: "Friday", date: "2026-07-31", label: "Tempo 5mi" }],
      }),
      conversations: [
        { role: "user", content: "I want to run Thursday instead of Friday", created_at: "2026-07-30T10:00:00Z" },
      ],
    });
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    await flush(); // drain the nested runAfter (session_swap/lighter_week/injury_hold/physio_referral fire from inside the outer coach/respond runAfter)

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const swapUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => Array.isArray(p?.weekly_plan_sessions));
    expect(swapUpdate).toBeDefined();
    const sessions = swapUpdate![0].weekly_plan_sessions as Array<{ day: string; date: string; label: string }>;
    expect(sessions.find((s) => s.day === "Friday")?.label).toBe("rest");
    const thursday = sessions.find((s) => s.day === "thursday");
    expect(thursday?.label).toBe("Tempo 5mi");
    // "M/D", matching what computeArcWeekSkeleton writes — this insert used to emit ISO
    // dates, so one sessions array could hold two formats (2026-08-09).
    expect(thursday?.date).toBe("7/30");
  });

  it("session_swaps: recomputes the week's stored totals so the schedule and target agree", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "Done — Wednesday is your long run now.",
        plan_action: { session_swaps: [{ day: "Wednesday", to: "Long run 9mi" }] },
      } }],
    });
    const { stateChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_mileage_target: 10,
        weekly_long_run_miles: 7,
        weekly_plan_sessions: [
          { day: "Wednesday", date: "7/29", label: "Easy 3mi", type: "run" },
          { day: "Saturday", date: "8/1", label: "Long run 7mi", type: "run" },
        ],
      }),
      conversations: [
        { role: "user", content: "can my long run move to Wednesday", created_at: "2026-07-30T10:00:00Z" },
      ],
    });
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    await flush();

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const swapUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => Array.isArray(p?.weekly_plan_sessions));
    expect(swapUpdate).toBeDefined();
    // Sessions now read 9mi + 7mi, longest 9 — both totals follow the swap rather than
    // staying at the pre-swap 10/7.
    expect(swapUpdate![0].weekly_mileage_target).toBe(16);
    expect(swapUpdate![0].weekly_long_run_miles).toBe(9);
  });

  it("lighter_week: fires the lighter_week loopback trigger", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "I've lightened this week given the fatigue — shorter easy runs, no quality sessions.",
        plan_action: { lighter_week: true },
      } }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: [
        { role: "user", content: "Feeling pretty beat up this week, can we dial it back?", created_at: "2026-07-30T10:00:00Z" },
      ],
    });
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    await flush(); // drain the nested runAfter (session_swap/lighter_week/injury_hold/physio_referral fire from inside the outer coach/respond runAfter)

    const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const lighterWeekCall = fetchCalls.find((c: unknown[]) => {
      const body = JSON.parse((c[1] as { body: string }).body);
      return body.trigger === "lighter_week";
    });
    expect(lighterWeekCall).toBeDefined();
  });

  it("injury_hold: fires the injury_hold loopback trigger", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "Given complete rest from your doctor, I've paused your running plan.",
        plan_action: { injury_hold: true },
      } }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: [
        { role: "user", content: "Doctor put me on complete rest this week.", created_at: "2026-07-30T10:00:00Z" },
      ],
    });
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    await flush(); // drain the nested runAfter (session_swap/lighter_week/injury_hold/physio_referral fire from inside the outer coach/respond runAfter)

    const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const injuryHoldCall = fetchCalls.find((c: unknown[]) => {
      const body = JSON.parse((c[1] as { body: string }).body);
      return body.trigger === "injury_hold";
    });
    expect(injuryHoldCall).toBeDefined();
  });

  it("physio_referral: writes physio_referral_sent_at directly", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "I'd really encourage you to get in front of a sports physio before your next run.",
        plan_action: { physio_referral: true },
      } }],
    });
    const { stateChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState(),
      conversations: [
        { role: "user", content: "It's a sharp, stabbing pain in my shin that's gotten worse.", created_at: "2026-07-30T10:00:00Z" },
      ],
    });
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    await flush(); // drain the nested runAfter (session_swap/lighter_week/injury_hold/physio_referral fire from inside the outer coach/respond runAfter)

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const referralUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => p?.physio_referral_sent_at != null);
    expect(referralUpdate).toBeDefined();
  });

  it("does NOT dispatch any plan mutation when plan_action is absent, even if the text sounds like it", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "I've swapped Thursday's run for an easy bike instead.",
        // plan_action deliberately omitted — this is exactly the gap the old
        // bracket-tag mechanism had: Claude confirms a change in prose but never
        // signals it, so nothing should actually happen.
      } }],
    });
    const { stateChain } = setupSupabase({
      user: baseUser(),
      profile: baseProfile(),
      state: baseState({
        weekly_plan_sessions: [{ day: "Thursday", date: "2026-07-30", label: "Tempo 5mi" }],
      }),
      conversations: [
        { role: "user", content: "My calf is tight, can we swap Thursday's tempo for a bike ride?", created_at: "2026-07-30T10:00:00Z" },
      ],
    });
    const { trackEvent } = await import("@/lib/track");
    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();
    await flush(); // drain the nested runAfter (session_swap/lighter_week/injury_hold/physio_referral fire from inside the outer coach/respond runAfter)

    const updateCalls = (stateChain.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.find(([p]: [Record<string, unknown>]) => Array.isArray(p?.weekly_plan_sessions))).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();

    // The advisory validator should flag this exact case.
    const events = (trackEvent as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(events).toContain("plan_action_unsignaled_change");
  });
});

describe("coach/respond — post_run_onboarding message shape", () => {
  /**
   * Mid-onboarding athletes used to get a chatty paragraph from a separate prompt that never
   * had the post_run OUTPUT CONTRACT applied to it (distance/pace/HR restated in prose, plus a
   * "Looking forward to..." sign-off). These assert the shape it sends now: a deterministic
   * mileage line, an optional one-sentence reaction, and the outstanding onboarding question.
   */
  const ONBOARDING_USER = {
    id: "user-onb",
    phone_number: "+12025550009",
    name: "Jake",
    onboarding_step: "onboarding",
    onboarding_data: { stage: "schedule_confirm", name: "Jake", goal: "trail_race" },
    linq_chat_id: "chat-onb",
    messaging_opted_out: false,
    timezone: "America/Denver",
  };

  const TODAY = new Date().toISOString();

  function setupOnboardingSupabase(conversations: Array<Record<string, unknown>>) {
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: ONBOARDING_USER, error: null });
      if (table === "conversations") return makeChain({ data: conversations, error: null });
      if (table === "activities") {
        // Two different activities queries run on this path: a .single() lookup for the
        // activity that triggered the webhook, and an awaited range query for the week's
        // totals. They need different shapes from the same chain.
        const chain = makeChain({
          data: [{ activity_type: "Run", distance_meters: 8690, start_date: TODAY }],
          error: null,
        }) as Record<string, unknown>;
        chain.single = vi.fn().mockResolvedValue({
          data: { activity_type: "Run", distance_meters: 8690, moving_time_seconds: 2800, average_heartrate: 151, average_pace: "8:45", elevation_gain: 100 },
          error: null,
        });
        return chain;
      }
      return makeChain({ data: null, error: null });
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("leads with the deterministic mileage line and appends the outstanding onboarding question", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "How's the shin feeling after that one?" }],
    });
    setupOnboardingSupabase([
      { role: "assistant", content: "Looks like you typically run Wed/Fri — sound right, or want different days?", message_type: "onboarding" },
    ]);

    const req = mockRequest({ userId: "user-onb", trigger: "post_run_onboarding", activityId: 555, dry_run: true });
    const res = await POST(req) as unknown as { data: { message: string } };

    const lines = res.data.message.split("\n\n");
    expect(lines[0]).toMatch(/^5\.4mi run today\./);
    expect(lines[1]).toBe("How's the shin feeling after that one?");
    expect(lines[2]).toBe("Looks like you typically run Wed/Fri — sound right, or want different days?");
  });

  it("sends only the mileage line and the question when Claude returns [NO_REPLY]", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "[NO_REPLY]" }],
    });
    setupOnboardingSupabase([
      { role: "assistant", content: "Looks like you typically run Wed/Fri — sound right, or want different days?", message_type: "onboarding" },
    ]);

    const req = mockRequest({ userId: "user-onb", trigger: "post_run_onboarding", activityId: 555, dry_run: true });
    const res = await POST(req) as unknown as { data: { message: string } };

    expect(res.data.message).not.toMatch(/NO_REPLY/);
    expect(res.data.message.split("\n\n")).toHaveLength(2);
    expect(res.data.message).toContain("Looks like you typically run Wed/Fri");
  });

  it("does not re-append a question the previous message already asked", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "[NO_REPLY]" }],
    });
    setupOnboardingSupabase([
      { role: "assistant", content: "4mi run today. 12mi running this week.\n\nLooks like you typically run Wed/Fri — sound right, or want different days?", message_type: "post_run" },
      { role: "assistant", content: "Looks like you typically run Wed/Fri — sound right, or want different days?", message_type: "onboarding" },
    ]);

    const req = mockRequest({ userId: "user-onb", trigger: "post_run_onboarding", activityId: 555, dry_run: true });
    const res = await POST(req) as unknown as { data: { message: string } };

    expect(res.data.message).not.toContain("sound right");
    expect(res.data.message.split("\n\n")).toHaveLength(1);
  });

  it("instructs Claude that line 1 is already sent and forbids the old sign-off shape", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: "text", text: "[NO_REPLY]" }],
    });
    setupOnboardingSupabase([]);

    const req = mockRequest({ userId: "user-onb", trigger: "post_run_onboarding", activityId: 555, dry_run: true });
    await POST(req);

    const prompt = systemText((anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0].system);
    expect(prompt).toContain("ONLY AN OPTIONAL SECOND LINE");
    expect(prompt).toContain("[NO_REPLY]");
    expect(prompt).toMatch(/Looking forward to/); // named as a forbidden sign-off
  });
});

// ---------------------------------------------------------------------------
// Strength routine delivery — text first, images on request
// ---------------------------------------------------------------------------
describe("coach/respond — strength routine delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("sends the routine as one text bubble and no images", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "Here's the routine that rebuilds shin tolerance. [STRENGTH_POSTER]",
      } }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ injury_notes: "shin splints", injury_body_part: "shin", active_injury: true, injury_severity: "moderate", training_days: ["monday", "wednesday", "thursday", "saturday"] }),
      state: baseState(),
      conversations: [{ role: "user", content: "what should I do for my shins?", created_at: "2026-08-09T10:00:00Z" }],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const { sendSMS, sendMediaSMS } = await import("@/lib/linq");
    const sentText = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    // The routine goes out as text...
    expect(sentText).toContain("Shin routine");
    expect(sentText).toContain("Want to see how any of these look? Just ask.");
    // ...and not as 9-13 separate image bubbles.
    expect((sendMediaSMS as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // The dashboard URL the token used to append is gone — SMS is the surface.
    expect(sentText).not.toContain("/plan/");
  });

  it("sends the images when the athlete asks how to do them", async () => {
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ injury_notes: "shin splints", injury_body_part: "shin", active_injury: true }),
      state: baseState(),
      conversations: [
        { role: "assistant", content: "Shin splints routine — daily this week, ~15 min:\n› Toe taps on a stair — 2×20\n› Tibialis anterior raises — 3×15\nWant to see how any of these look? Just ask.", created_at: "2026-08-09T10:00:00Z" },
        { role: "user", content: "how do I do that?", created_at: "2026-08-09T10:01:00Z" },
      ],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const { sendMediaSMS } = await import("@/lib/linq");
    const mediaCalls = (sendMediaSMS as ReturnType<typeof vi.fn>).mock.calls;
    expect(mediaCalls.length).toBe(2);
    expect(mediaCalls[0][1]).toContain("Toe taps on a stair");
    // Handled deterministically — Claude is never called for this turn.
    expect((anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("sends the image when the athlete names an exercise outside a digest reply", async () => {
    // The real failure (2026-08-11): Dean had named the exercises in prose, not a digest, so the
    // ask fell through to coaching — the athlete got a written description followed by a digest
    // closing with "Want to see how any of these look? Just ask.", the question they just asked.
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ injury_notes: "shin splints", injury_body_part: "shin", active_injury: true }),
      state: baseState(),
      conversations: [
        { role: "assistant", content: "Bring the band and knock out a few of the exercises when you're able. Dorsiflexion, tib raises, and the calf stretch travel well.", created_at: "2026-08-09T10:00:00Z" },
        { role: "user", content: "Pretty good at rest. Can you show me how the ankle alphabet goes?", created_at: "2026-08-09T10:01:00Z" },
      ],
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const { sendSMS, sendMediaSMS } = await import("@/lib/linq");
    const mediaCalls = (sendMediaSMS as ReturnType<typeof vi.fn>).mock.calls;
    expect(mediaCalls.length).toBe(1);
    expect(mediaCalls[0][1]).toContain("Ankle alphabet");
    // A lone illustration carries the form cue, since the image alone doesn't say it.
    expect(mediaCalls[0][1]).toContain("trace each letter");
    expect(mediaCalls[0][2]).toContain("/strength-exercises/ankle_alphabet.png");
    // No digest re-inviting the question the athlete just asked.
    const sentText = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sentText).not.toContain("Want to see how any of these look?");
    expect((anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("illustrates rather than digests when Dean names exercises answering a 'show me'", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
        message: "That one's a mobility drill — here's what it looks like.",
        exercise_ids: ["ankle_alphabet"],
      } }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ injury_notes: "shin splints", injury_body_part: "shin", active_injury: true }),
      state: baseState(),
      conversations: [
        { role: "assistant", content: "Keep the routine going this week.", created_at: "2026-08-09T10:00:00Z" },
        { role: "user", content: "show me the one where you draw with your foot", created_at: "2026-08-09T10:01:00Z" },
      ],
    });

    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const { sendSMS, sendMediaSMS } = await import("@/lib/linq");
    expect((sendMediaSMS as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const sentText = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string).join("\n");
    expect(sentText).not.toContain("Want to see how any of these look?");
  });

  it("leaves an unrelated reply to coaching, even right after a digest", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: { message: "Moved it." } }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({ injury_notes: "shin splints", active_injury: true }),
      state: baseState(),
      conversations: [
        { role: "assistant", content: "Shin splints routine — daily this week, ~15 min:\n› Toe taps on a stair — 2×20\nWant to see how any of these look? Just ask.", created_at: "2026-08-09T10:00:00Z" },
        { role: "user", content: "can we move the long run to Sunday?", created_at: "2026-08-09T10:01:00Z" },
      ],
    });

    const req = mockRequest({ userId: "user-001", trigger: "user_message" });
    await POST(req);
    await flush();

    const { sendMediaSMS } = await import("@/lib/linq");
    expect((sendMediaSMS as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Plan questions: one schedule, and the routine as its own message
// ---------------------------------------------------------------------------
describe("coach/respond — plan question schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    // buildScheduleDigest reads the real wall clock (Date.now()) when no nowMs is passed, and
    // filters the stored sessions to "still ahead of today" — so the fixture's session dates
    // (Wed 8/12, Sat 8/15, in the week following the Sun 8/9 conversation) only stay "upcoming"
    // if the clock is pinned nearby. Monday 8/10 keeps both sessions ahead of "today".
    // Only fake Date — leaving setTimeout/setInterval real, since the route's compose-delay
    // and typing-indicator loops rely on real timers to resolve during the test.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-10T15:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupPlanQuestion() {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockImplementation((args: { system?: unknown }) => {
      // The intent classifier is a plain-text Haiku call; everything else is the coach tool call.
      if (typeof args.system === "string" && args.system.includes("classifying a message")) {
        return Promise.resolve({ content: [{ type: "text", text: '{"intent":"plan_question","body_part":null,"cadence":null,"confidence":"high"}' }] });
      }
      return Promise.resolve({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: {
          message: "Here's next week.\n\nMon 8/10 · Easy 5mi\nWed 8/12 · Long run 7mi\nSat 8/15 · Easy 2.5mi\n\nKeep the shin routine going.",
        } }],
      });
    });
    return setupSupabase({
      user: baseUser(),
      profile: baseProfile({
        injury_notes: "shin splints", injury_body_part: "shin", active_injury: true, injury_severity: "moderate",
        training_days: ["monday", "wednesday", "thursday", "saturday"], crosstraining_tools: ["bike"],
      }),
      state: baseState({
        weekly_plan_sessions: [
          { day: "Wed", date: "8/12", label: "Easy 3.5mi", type: "run", rehab_routine_key: "shin" },
          { day: "Sat", date: "8/15", label: "Long run 7mi", type: "run" },
        ],
      }),
      conversations: [{ role: "user", content: "What is the full plan for the week?", created_at: "2026-08-09T10:00:00Z" }],
      plan: { weeks: [
        { week_number: 8, mileage_target: 17, long_run_target: 7, key_workout: "Easy 2.5mi + 5x20sec strides" },
        { week_number: 9, mileage_target: 16, long_run_target: 7, key_workout: "Easy 3mi + 5x20sec strides" },
      ] },
    });
  }

  it("strips Dean's own day list so only the stored schedule goes out", async () => {
    setupPlanQuestion();
    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const { sendSMS } = await import("@/lib/linq");
    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string);
    const all = sent.join("\n");
    // Dean's invented days are gone — his prose put the long run Wednesday, the plan says Saturday.
    expect(all).not.toContain("Mon 8/10 · Easy 5mi");
    expect(all).not.toContain("Wed 8/12 · Long run 7mi");
    // His framing survives.
    expect(all).toContain("Keep the shin routine going.");
  });

  it("follows the schedule with the routine as a separate message", async () => {
    setupPlanQuestion();
    await POST(mockRequest({ userId: "user-001", trigger: "user_message" }));
    await flush();

    const { sendSMS } = await import("@/lib/linq");
    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string);
    const schedule = sent.find((t: string) => t.includes("this week:") || t.includes("Next week"));
    const routine = sent.find((t: string) => t.includes("Want to see how any of these look?"));
    expect(schedule).toBeDefined();
    expect(routine).toBeDefined();
    // The schedule names the routine per day; the routine message carries the exercises.
    expect(schedule).toContain("shin routine");
    expect(schedule).not.toContain("Toe taps");
    expect(routine).toContain("Toe taps on a stair");
  });
});

// ---------------------------------------------------------------------------
// Plan deviation — only miles the plan actually covered can deviate from it
// ---------------------------------------------------------------------------
describe("coach/respond — plan deviation window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  function setupRecap(opts: { sessions: Array<Record<string, unknown>>; activities: Array<Record<string, unknown>> }) {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: { message: "Recap." } }],
    });
    const stateChain = makeChain({ data: baseState({ weekly_plan_sessions: opts.sessions }), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return makeChain({ data: baseUser(), error: null });
      if (table === "training_profiles") return makeChain({ data: baseProfile({ training_days: ["monday", "wednesday", "thursday", "saturday"] }), error: null });
      if (table === "training_state") return stateChain;
      if (table === "activities") return makeChain({ data: opts.activities, error: null });
      return makeChain({ data: null, error: null });
    });
  }

  const run = (date: string, miles: number) => ({
    activity_type: "Run", distance_meters: miles * 1609.34, start_date: `${date}T13:00:00Z`,
    moving_time_seconds: miles * 540, average_heartrate: 150, source: "strava",
  });

  it("does not accuse an athlete of overrunning a plan that didn't exist yet", async () => {
    // Onboarded Saturday: the plan covers 8/8 onward, but the week's runs start 8/4. Those
    // earlier miles used to count as "over plan" and produced "you've been going longer than
    // the plan all week" about a one-day-old plan.
    setupRecap({
      sessions: [{ day: "Sat", date: "8/8", label: "Long run 6.5mi", type: "run" }],
      activities: [run("2026-08-04", 4), run("2026-08-05", 6.6), run("2026-08-06", 5.4), run("2026-08-08", 4.2)],
    });
    await POST(mockRequest({ userId: "user-001", trigger: "weekly_recap" }));
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const prompt = calls.map((c: [{ system?: unknown; messages?: Array<{ content?: unknown }> }]) =>
      systemText(c[0].system) + String(c[0].messages?.[0]?.content ?? "")).join("\n");
    expect(prompt).not.toContain("PLAN DEVIATION PATTERN");
  });

  it("still flags a real pattern of running past the plan", async () => {
    setupRecap({
      sessions: [
        { day: "Mon", date: "8/3", label: "Easy 3mi", type: "run" },
        { day: "Wed", date: "8/5", label: "Easy 3mi", type: "run" },
        { day: "Thu", date: "8/6", label: "Easy 3mi", type: "run" },
      ],
      activities: [run("2026-08-03", 6), run("2026-08-05", 7), run("2026-08-06", 6.5)],
    });
    await POST(mockRequest({ userId: "user-001", trigger: "weekly_recap" }));
    await flush();

    const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
    const prompt = calls.map((c: [{ system?: unknown; messages?: Array<{ content?: unknown }> }]) =>
      systemText(c[0].system) + String(c[0].messages?.[0]?.content ?? "")).join("\n");
    expect(prompt).toContain("PLAN DEVIATION PATTERN");
  });
});

describe("coach/respond — weekly recap schedule surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  it("sends the week as text, not as the MMS card", async () => {
    (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "deliver_message", input: { message: "Solid week." } }],
    });
    setupSupabase({
      user: baseUser(),
      profile: baseProfile({
        training_days: ["monday", "wednesday", "thursday", "saturday"],
        injury_notes: "shin splints", injury_body_part: "shin", active_injury: true, injury_severity: "moderate",
        crosstraining_tools: ["bike"],
      }),
      state: baseState(),
      // Cover every plausible effectiveWeek so the recap always finds its week.
      plan: { weeks: Array.from({ length: 12 }, (_, i) => ({
        week_number: i + 1, mileage_target: 17, long_run_target: 7, key_workout: "Easy 2.5mi + 5x20sec strides",
      })) },
    });

    await POST(mockRequest({ userId: "user-001", trigger: "weekly_recap" }));
    await flush();

    const { sendSMS, sendMediaSMS } = await import("@/lib/linq");
    const sent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(sent.some((t: string) => /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+\/\d+ — /.test(t))).toBe(true);
    expect((sendMediaSMS as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // Rehab is on the day line, and the routine follows as its own message.
    expect(sent.join("\n")).toContain("shin routine");
    expect(sent.some((t: string) => t.includes("Want to see how any of these look?"))).toBe(true);
  });
});
