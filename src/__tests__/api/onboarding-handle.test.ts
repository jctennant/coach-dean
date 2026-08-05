import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------- module mocks (must be before imports) ----------
vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("@/lib/linq", () => ({
  sendSMS: vi.fn().mockResolvedValue({ chatId: "chat-123" }),
  startTyping: vi.fn().mockResolvedValue(undefined),
  shareContactCard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/anthropic", () => ({
  anthropic: {
    messages: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/track", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/paces", () => ({
  calculateVDOTPaces: vi.fn().mockReturnValue({ easy: "9:30", tempo: "7:45", interval: "6:55" }),
  estimatePacesFromEasyPace: vi.fn(),
  easyPaceRange: vi.fn().mockReturnValue("9:00–9:45"),
  formatRaceDistance: vi.fn().mockReturnValue("5K"),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {},
  getCheckoutPageUrl: vi.fn().mockReturnValue("https://coachdean.ai/checkout?token=test"),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({ data, init }),
  },
  after: (fn: () => Promise<void>) => { void fn(); },
}));

// ---------- imports (after mocks) ----------
import { POST } from "@/app/api/onboarding/handle/route";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import { anthropic } from "@/lib/anthropic";

// ---------- Helpers ----------

function chain(response: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "update", "upsert", "delete",
    "eq", "neq", "is", "not", "gt", "lt", "gte", "lte", "in", "or", "order", "limit",
  ];
  for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
  c["single"] = vi.fn().mockResolvedValue(response);
  c["maybeSingle"] = vi.fn().mockResolvedValue(response);
  c["then"] = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown
  ) => Promise.resolve(response).then(resolve, reject);
  return c;
}

function mockTables(
  tables: Record<string, { data: unknown; error: unknown } | Array<{ data: unknown; error: unknown }>>
) {
  const counters: Record<string, number> = {};
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const def = tables[table];
    if (!def) return chain({ data: null, error: null });
    if (Array.isArray(def)) {
      const idx = counters[table] ?? 0;
      counters[table] = idx + 1;
      return chain(def[idx] ?? { data: null, error: null });
    }
    return chain(def);
  });
}

function makeRequest(body: unknown) {
  return { json: () => Promise.resolve(body) } as unknown as Request;
}

/** Standard user in the "onboarding" step */
function onboardingUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-001",
    phone_number: "+12025551234",
    name: "Jake",
    onboarding_step: "onboarding",
    onboarding_data: {},
    ...overrides,
  };
}

/** Mock a single Anthropic text response */
function mockLLMResponse(text: string) {
  (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    content: [{ type: "text", text }],
  });
}

/** Mock a Haiku tool-use response (for extractFields) */
function mockToolResponse(toolName: string, input: Record<string, unknown>) {
  (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    content: [{ type: "tool_use", id: "tool-1", name: toolName, input }],
  });
}

// ---------- Tests ----------

// These tests encode the OpenAI onboarding path (notably the gpt-4o-search-preview
// pre-search call for race dates — see isOpenAI in onboarding/handle/route.ts), so their
// mocked LLM call sequences assume that path. Production now defaults to Anthropic (native
// web search, no pre-search), but the OpenAI path still ships for AI_PROVIDER=openai — pin
// the suite to it so the call-sequence assertions stay valid. (The Anthropic onboarding
// path is exercised by the simulation/onboarding evals.)
const ORIGINAL_AI_PROVIDER = process.env.AI_PROVIDER;
beforeEach(() => { process.env.AI_PROVIDER = "openai"; });
afterEach(() => {
  if (ORIGINAL_AI_PROVIDER === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = ORIGINAL_AI_PROVIDER;
});

describe("POST /api/onboarding/handle — unknown/null step", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 ok for null step (fully onboarded user)", async () => {
    mockTables({
      users: { data: { ...onboardingUser(), onboarding_step: null }, error: null },
    });

    const res = await POST(makeRequest({ userId: "user-001", message: "hi" }));
    expect((res as { data: unknown }).data).toMatchObject({ ok: true });
    expect(sendSMS).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/handle — user not found", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when user is not found", async () => {
    mockTables({
      users: { data: null, error: { message: "not found" } },
    });

    const res = await POST(makeRequest({ userId: "bad-id", message: "hi" }));
    expect((res as { init: { status: number } }).init?.status).toBe(404);
  });
});

describe("POST /api/onboarding/handle — onboarding step (unified conversation)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normal turn: sends Claude response and updates onboarding_data", async () => {
    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
      activities: { data: [], error: null },
      races: { data: [], error: null },
      training_profiles: { data: null, error: null },
    });

    // Extract-first ordering: Haiku extraction runs BEFORE the main Sonnet call
    // so race names feed the OpenAI pre-search loop this same turn.
    mockToolResponse("save_training_fields", { name: "Jake", goal: null, training_days: null });
    // Sonnet: normal response (no signals)
    mockLLMResponse("Great! What days of the week work best for training?");

    await POST(makeRequest({ userId: "user-001", message: "I want to run a 5K" }));

    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      "Great! What days of the week work best for training?"
    );
  });

  it("[READY] signal: strips tag and calls completeOnboarding", async () => {
    mockTables({
      users: [
        // Mode already resolved via earlier [MODE:FROM_SCRATCH] tag, persisted in onboarding_data
        { data: onboardingUser({ onboarding_data: { goal: "5k", training_days: ["tuesday", "thursday", "saturday"], has_existing_plan: false, wants_plan: true, strava_connected: true } }), error: null },
        { data: { dashboard_token: "tok-abc" }, error: null },  // for completeOnboarding user lookup
      ],
      conversations: { data: [], error: null },
      activities: { data: [], error: null },
      races: { data: [], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    });

    // Extract-first: Haiku extraction (tool use) runs first
    mockToolResponse("save_training_fields", { name: "Jake", goal: "5k", training_days: ["tuesday","thursday","saturday"], timezone: "America/New_York" });
    // Sonnet: includes [READY] signal
    mockLLMResponse("Awesome, I have everything I need! Let's build your plan.\n[READY]");

    await POST(makeRequest({ userId: "user-001", message: "NYC, Monday Wednesday Friday" }));

    // [READY] should be stripped from the sent SMS
    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).not.toContain("[READY]");
    expect(textSent).toContain("everything I need");
  });

  it("[READY] signal with no training_days known: enters schedule_confirm checkpoint instead of completing onboarding", async () => {
    mockTables({
      users: { data: onboardingUser({ onboarding_data: { goal: "5k", strava_connected: true, injury_intake_done: true } }), error: null },
      conversations: { data: [], error: null },
      activities: { data: [], error: null }, // no history → inference returns null
      races: { data: [], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    });

    mockToolResponse("save_training_fields", { name: "Jake", goal: "5k", training_days: null });
    mockLLMResponse("Awesome, I have everything I need! Let's build your plan.\n[READY]");

    await POST(makeRequest({ userId: "user-001", message: "that's everything" }));

    // Should NOT complete onboarding yet — asks about schedule instead.
    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const lastText = smsCalls[smsCalls.length - 1]?.[1] as string;
    expect(lastText).toContain("days of the week");

    // onboarding_data should carry the schedule_confirm stage forward.
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls;
    const usersUpdates = fromCalls.filter((c: unknown[]) => c[0] === "users");
    expect(usersUpdates.length).toBeGreaterThan(0);
  });

  it("schedule_confirm stage: a reply completes onboarding", async () => {
    mockTables({
      users: [
        { data: onboardingUser({ onboarding_data: { goal: "5k", strava_connected: true, stage: "schedule_confirm" } }), error: null },
        { data: { dashboard_token: "tok-abc" }, error: null }, // completeOnboarding user lookup
      ],
      conversations: { data: [], error: null },
      activities: { data: [], error: null },
      races: { data: [], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    });

    // Two extraction calls happen for this turn: handleConversation's unconditional
    // "extract first" pass, then handleScheduleConfirm's own dedicated extraction
    // (same double-extraction shape as the existing injury_intake stage).
    mockToolResponse("save_training_fields", { training_days: ["monday", "wednesday", "friday"] });
    mockToolResponse("save_training_fields", { training_days: ["monday", "wednesday", "friday"] });

    await POST(makeRequest({ userId: "user-001", message: "Mon/Wed/Fri works, no extra preferences" }));

    // completeOnboarding should have run — training_profiles gets written.
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls;
    const profileUpdates = fromCalls.filter((c: unknown[]) => c[0] === "training_profiles");
    expect(profileUpdates.length).toBeGreaterThan(0);
  });

  it("[STRAVA_LINK] signal: sets step to awaiting_strava and injects URL", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
    });

    // Extract-first: Haiku extraction (tool use) runs first
    mockToolResponse("save_training_fields", { name: "Jake", goal: "marathon" });
    // Sonnet: includes [STRAVA_LINK] placeholder
    mockLLMResponse("Do you use Strava? Tap here to connect: [STRAVA_LINK]");

    await POST(makeRequest({ userId: "user-001", message: "I run marathons" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    // Standalone Strava turn: pitch + URL in one message (no pre-Strava context to split out)
    const stravaMsg = smsCalls[0]?.[1] as string;
    expect(stravaMsg).not.toContain("[STRAVA_LINK]");
    expect(stravaMsg).toContain("https://coachdean.ai/api/auth/strava");
    // No "skip" option in the message — Strava is now required
    expect(stravaMsg).not.toContain('"skip"');
    // Only one SMS sent (no separate pre-Strava response)
    expect(smsCalls.length).toBe(1);

    // Step should be set to awaiting_strava
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls;
    const updateCalls = fromCalls.filter((c: unknown[]) => c[0] === "users");
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it("[STRAVA_LINK] with zero lead-in: injects a deterministic transition using known injury context", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: {
        data: onboardingUser({
          onboarding_data: { name: "Jake", goal: "trail_race", injury_body_part_current: "posterior shin" },
        }),
        error: null,
      },
      conversations: { data: [], error: null },
    });

    mockToolResponse("save_training_fields", {});
    // Claude drops the link with no lead-in sentence at all (the reported bug).
    mockLLMResponse("[STRAVA_LINK]");

    await POST(makeRequest({ userId: "user-001", message: "It hurts sporadically during runs." }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const stravaMsg = smsCalls[0]?.[1] as string;
    expect(stravaMsg).not.toContain("[STRAVA_LINK]");
    expect(stravaMsg.toLowerCase()).toContain("posterior shin");
    expect(stravaMsg).toContain("https://coachdean.ai/api/auth/strava");
  });

  it("[STRAVA_LINK] with an inline transition sharing its paragraph: preserves Dean's own lead-in instead of dropping it", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
    });

    mockToolResponse("save_training_fields", {});
    mockLLMResponse("So I can see what's actually driving that shin soreness, connect Strava:\n[STRAVA_LINK]");

    await POST(makeRequest({ userId: "user-001", message: "It hurts sporadically during runs." }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const stravaMsg = smsCalls[0]?.[1] as string;
    expect(stravaMsg).not.toContain("[STRAVA_LINK]");
    expect(stravaMsg).toContain("So I can see what's actually driving that shin soreness, connect Strava:");
  });

  it("dry_run mode: skips SMS but still writes conversations", async () => {
    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
    });

    // Extract-first ordering: Haiku extraction runs before main Sonnet call
    mockToolResponse("save_training_fields", {});
    mockLLMResponse("Which days work for you?");

    await POST(makeRequest({ userId: "user-001", message: "5K goal", dry_run: true }));

    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("existing plan: [MODE:COMPLEMENT] tag sets has_existing_plan and external_plan_description is saved", async () => {
    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
    });

    // Extract-first ordering: Haiku extraction runs before main Sonnet call.
    // Haiku no longer extracts has_existing_plan / wants_plan — those come from the [MODE:...] tag.
    mockToolResponse("save_training_fields", {
      name: "Chris",
      goal: "half_marathon",
      external_plan_description: "Runna 16-week half marathon plan, week 6, ~35mi/week",
    });
    // Dean emits [MODE:COMPLEMENT] when athlete confirms they already have a plan
    mockLLMResponse("Got it — I'll work alongside your Runna plan, not replace it. You can also upload the PDF to the dashboard and I'll reference it directly. Which days are you running?\n[MODE:COMPLEMENT]");

    await POST(makeRequest({ userId: "user-001", message: "I'm already on a Runna plan, just want coaching support" }));

    // Verify onboarding_data was updated with both fields
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls;
    const userUpdateCalls = fromCalls
      .filter((c: unknown[]) => c[0] === "users")
      .map((c: unknown[]) => c);

    // Find the update call that contains onboarding_data
    const updateChains = (supabase.from as ReturnType<typeof vi.fn>).mock.results
      .map((r: { value: unknown }) => r.value)
      .filter(Boolean);

    // The key assertion: SMS was sent (Dean didn't reject the user)
    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      expect.stringContaining("Runna")
    );

    // Verify the update call included has_existing_plan and external_plan_description
    const allUpdateArgs = (supabase.from as ReturnType<typeof vi.fn>).mock.calls;
    const usersUpdates = allUpdateArgs.filter((c: unknown[]) => c[0] === "users");
    expect(usersUpdates.length).toBeGreaterThan(0);
  });

  it("pre-search: injects race date when race_name is known and race_date is missing", async () => {
    mockTables({
      users: {
        data: onboardingUser({
          onboarding_data: { race_name: "Boston Marathon", goal: "marathon" },
        }),
        error: null,
      },
      conversations: { data: [], error: null },
    });

    // Off-topic classifier (Haiku) now runs in POST for any question-shaped message that
    // has no on-topic keyword — "So when exactly is Boston?" has none, and the old
    // `length < 50` skip that used to exempt it was removed so short tangents like
    // "how much does this cost?" get classified too.
    mockLLMResponse("ON_TOPIC");
    // Extract-first ordering: extraction runs first. Returns null for race_date so
    // needsRaceDateLookup stays true and the pre-search fires for the stored race_name.
    mockToolResponse("save_training_fields", { race_date: null });
    // preSearchRaceDate (Haiku + search) → returns "DATE: 2026-04-20"
    mockLLMResponse("DATE: 2026-04-20");
    // Sonnet main response, sees the pre-lookup result in raceDateInjection
    mockLLMResponse("Boston Marathon is April 20, 2026 — that gives us a solid 18-week build.");

    await POST(makeRequest({ userId: "user-001", message: "So when exactly is Boston?" }));

    // SMS should include the race date from the pre-lookup
    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      expect.stringContaining("April 20, 2026")
    );
    // 4 LLM calls total: off-topic classifier + extraction + pre-search + Sonnet
    expect((anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  it("existing plan: has_existing_plan persists across turns without the tag re-firing", async () => {
    // Once [MODE:COMPLEMENT] sets has_existing_plan=true and it's saved to onboarding_data,
    // subsequent turns load that state from the DB — Dean doesn't need to re-emit the tag.
    mockTables({
      users: {
        data: onboardingUser({
          onboarding_data: {
            has_existing_plan: true,
            wants_plan: false,
            external_plan_description: "Runna 16-week HM plan, week 6, ~35mi/week",
          },
        }),
        error: null,
      },
      conversations: { data: [], error: null },
    });

    mockToolResponse("save_training_fields", {
      training_days: ["tuesday", "thursday", "saturday", "sunday"],
    });
    // No [MODE:...] tag on this follow-up turn — prior value must persist
    mockLLMResponse("Got it, Tuesday, Thursday, Saturday and Sunday. Which race are you targeting?");

    await POST(makeRequest({ userId: "user-001", message: "I run Tues, Thurs, Sat, Sun" }));

    expect(sendSMS).toHaveBeenCalledTimes(1);
  });

  it("legacy [MODE:...] tags are stripped from SMS even if model emits them", async () => {
    // Safety net: model may emit [MODE:...] tags from stale training. They should be stripped
    // from the SMS — the system no longer routes on them, they're just internal artifacts.
    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
    });

    mockToolResponse("save_training_fields", { name: "Jake", goal: "marathon" });
    mockLLMResponse("Perfect, I'll build you a plan from scratch. Do you use Strava?\n[MODE:FROM_SCRATCH]");

    await POST(makeRequest({ userId: "user-001", message: "Option 1" }));

    // [MODE:...] tag must be stripped from the sent SMS
    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).not.toContain("[MODE:");
    expect(textSent).toContain("build you a plan from scratch");
  });

  it("[DASHBOARD_LINK] without [READY]: treated as implicit [READY] (wrap-up safety net)", async () => {
    // Prod regression: Dean emitted a wrap-up with [DASHBOARD_LINK] but forgot [READY],
    // leaving the athlete stuck in "onboarding" with no plan generated. The system now
    // treats [DASHBOARD_LINK] as an implicit [READY] signal.
    mockTables({
      users: [
        {
          data: onboardingUser({
            onboarding_data: {
              name: "Jake",
              goal: "5k",
              has_existing_plan: false,
              wants_plan: true,
              injury_history: "none",
            },
          }),
          error: null,
        },
        { data: { dashboard_token: "tok-abc" }, error: null },
      ],
      conversations: { data: [], error: null },
      activities: { data: [], error: null },
      races: { data: [], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    });

    mockToolResponse("save_training_fields", {});
    // Dean's wrap-up: [DASHBOARD_LINK] present, [READY] forgotten
    mockLLMResponse("You're all set, Jake. Your dashboard is here:\n[DASHBOARD_LINK]");

    await POST(makeRequest({ userId: "user-001", message: "no injuries" }));

    // completeOnboarding should have fired — verified by the user update clearing onboarding_step
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls;
    const usersUpdates = fromCalls.filter((c: unknown[]) => c[0] === "users");
    expect(usersUpdates.length).toBeGreaterThan(0);
  });
});

describe("POST /api/onboarding/handle — awaiting_strava step", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skip text: re-sends Strava link (Strava is now required, no skip allowed)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: { data: onboardingUser({ onboarding_step: "awaiting_strava" }), error: null },
      conversations: { data: null, error: null },
    });

    await POST(makeRequest({ userId: "user-001", message: "skip" }));

    // Should re-send the Strava link (not proceed without Strava)
    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("https://coachdean.ai/api/auth/strava");
    // Should NOT contain "skip" option since Strava is required
    expect(textSent).not.toContain('"skip"');
  });

  it("non-question: re-sends the Strava link without skip option", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: { data: onboardingUser({ onboarding_step: "awaiting_strava" }), error: null },
      conversations: { data: null, error: null },
    });

    await POST(makeRequest({ userId: "user-001", message: "I'm not sure" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("https://coachdean.ai/api/auth/strava");
    // No skip option — Strava is required
    expect(textSent).not.toContain('"skip"');
  });

  it("Strava question: explains what Strava is and re-sends link", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: { data: onboardingUser({ onboarding_step: "awaiting_strava" }), error: null },
      conversations: { data: null, error: null },
    });

    await POST(makeRequest({ userId: "user-001", message: "What is Strava?" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("Strava is a free app");
    expect(textSent).toContain("https://coachdean.ai/api/auth/strava");
  });
});


describe("POST /api/onboarding/handle — awaiting_payment step", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resends checkout link when user texts during awaiting_payment", async () => {
    mockTables({
      users: [
        { data: onboardingUser({ onboarding_step: "awaiting_payment" }), error: null },
        { data: { dashboard_token: "tok-abc" }, error: null },
      ],
      conversations: { data: null, error: null },
    });

    await POST(makeRequest({ userId: "user-001", message: "where is my plan?" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("https://coachdean.ai/checkout?token=test");
  });

  it("no-ops silently when dashboard_token is missing", async () => {
    mockTables({
      users: [
        { data: onboardingUser({ onboarding_step: "awaiting_payment" }), error: null },
        { data: { dashboard_token: null }, error: null },
      ],
    });

    const res = await POST(makeRequest({ userId: "user-001", message: "?" }));
    expect((res as { data: unknown }).data).toMatchObject({ ok: true });
    expect(sendSMS).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// current_week seeded from external_plan_description at [READY]
// ---------------------------------------------------------------------------
describe("POST /api/onboarding/handle — current_week seeded from external_plan_description", () => {
  beforeEach(() => vi.clearAllMocks());

  // Drains the microtask + macrotask queue so async work started by `void fn()`
  // inside after() has a chance to complete before assertions run.
  async function flushAsync() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  function buildSetup(externalPlanDescription: string | null) {
    // trackable training_state chain so we can inspect upsert payloads
    const tsChain = chain({ data: null, error: null });
    const stateUpserts: Array<Record<string, unknown>> = [];
    (tsChain.upsert as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: Record<string, unknown>) => {
        stateUpserts.push(payload);
        return tsChain;
      }
    );

    const userData = onboardingUser({
      onboarding_data: {
        goal: "half_marathon",
        training_days: ["tuesday", "thursday", "saturday"],
        has_existing_plan: externalPlanDescription !== null,
        wants_plan: externalPlanDescription === null,
        strava_connected: true, // required to pass the Strava gate before completeOnboarding
        injury_intake_done: true, // required to pass the injury-intake gate (maybeEnterInjuryIntake)
        ...(externalPlanDescription ? { external_plan_description: externalPlanDescription } : {}),
      },
    });

    const counters: Record<string, number> = {};
    const tables: Record<string, { data: unknown; error: unknown } | Array<{ data: unknown; error: unknown }>> = {
      users: [
        { data: userData, error: null },
        // POST processing-lock write (onboarding_data + processing_lock_at)
        { data: null, error: null },
        // isReady onboarding_data persist (line 806)
        { data: { onboarding_data: userData.onboarding_data }, error: null },
        // fresh user fetch inside completeOnboarding (line 1719)
        { data: { onboarding_data: userData.onboarding_data }, error: null },
        // billing check (line 1820)
        { data: { billing_enabled: false, reverse_trial_enabled: false, dashboard_token: "tok-abc", phone_number: "+12025551234" }, error: null },
        // update guard (onboarding_step → null)
        { data: [{ id: "user-001" }], error: null },
      ],
      conversations: { data: [], error: null },
      activities: { data: [], error: null },
      races: { data: [], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    };

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "training_state") return tsChain;
      const def = tables[table];
      if (!def) return chain({ data: null, error: null });
      if (Array.isArray(def)) {
        const idx = counters[table] ?? 0;
        counters[table] = idx + 1;
        return chain(def[idx] ?? { data: null, error: null });
      }
      return chain(def);
    });

    return { stateUpserts };
  }

  it("seeds current_week: 6 when external_plan_description contains 'week 6'", async () => {
    const { stateUpserts } = buildSetup("Runna 16-week HM plan, week 6, ~35mi/week");

    mockToolResponse("save_training_fields", {
      name: "Jake",
      goal: "half_marathon",
      training_days: ["tuesday", "thursday", "saturday"],
      timezone: "America/New_York",
    });
    mockLLMResponse("Let's go! I'll work alongside your Runna plan.\n[READY]");

    await POST(makeRequest({ userId: "user-001", message: "yes, week 6" }));
    await flushAsync();

    const stateWrite = stateUpserts.find(u => u.current_week != null);
    expect(stateWrite?.current_week).toBe(6);
  });

  it("defaults to current_week: 1 when external_plan_description has no week number", async () => {
    const { stateUpserts } = buildSetup(null);

    mockToolResponse("save_training_fields", {
      name: "Jake",
      goal: "half_marathon",
      training_days: ["tuesday", "thursday", "saturday"],
      timezone: "America/New_York",
    });
    mockLLMResponse("Great, I'll build you a plan from scratch!\n[READY]");

    await POST(makeRequest({ userId: "user-001", message: "starting from the beginning" }));
    await flushAsync();

    const stateWrite = stateUpserts.find(u => u.current_week != null);
    expect(stateWrite?.current_week).toBe(1);
  });

  it("parses week number case-insensitively ('Week 12')", async () => {
    const { stateUpserts } = buildSetup("Nike Run Club plan, Week 12 of 18");

    mockToolResponse("save_training_fields", {
      name: "Jake",
      goal: "marathon",
      training_days: ["monday", "wednesday", "friday", "sunday"],
      timezone: "America/Chicago",
    });
    mockLLMResponse("Perfect — I'll work alongside your Nike plan.\n[READY]");

    await POST(makeRequest({ userId: "user-001", message: "yes, week 12" }));
    await flushAsync();

    const stateWrite = stateUpserts.find(u => u.current_week != null);
    expect(stateWrite?.current_week).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Inbound dedup — must distinguish "already handled" from "prior pass failed"
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/handle — duplicate inbound handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips a duplicate whose first pass already replied", async () => {
    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: [
        // dedup select: matching inbound row from 20s ago
        { data: [{ id: "c1", created_at: "2026-08-04T12:00:00Z" }], error: null },
        // reply check: an assistant message landed after it → genuinely handled
        { data: [{ id: "a1" }], error: null },
      ],
    });

    await POST(makeRequest({ userId: "user-001", message: "shin has been sore for two weeks" }));

    expect(sendSMS).not.toHaveBeenCalled();
    expect((anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("skips a duplicate while the first pass still holds the processing lock", async () => {
    mockTables({
      users: {
        data: onboardingUser({
          onboarding_data: { processing_lock_at: new Date().toISOString() },
        }),
        error: null,
      },
      conversations: [
        { data: [{ id: "c1", created_at: "2026-08-04T12:00:00Z" }], error: null },
        { data: [], error: null }, // no reply yet — but the lock says it's in flight
      ],
    });

    await POST(makeRequest({ userId: "user-001", message: "shin has been sore for two weeks" }));

    expect(sendSMS).not.toHaveBeenCalled();
    expect((anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("re-processes a duplicate whose first pass died before replying", async () => {
    // The regression this guards: the original dedup skipped on the inbound row alone.
    // Handlers store that row before doing their work, so a pass that threw partway through
    // left the row behind with no reply — and every retry was then silently dropped,
    // stranding the athlete permanently. No reply and no live lock means retry.
    mockTables({
      users: [
        { data: onboardingUser({ onboarding_data: { name: "Jake" } }), error: null },
        { data: null, error: null }, // processing-lock write
      ],
      conversations: [
        { data: [{ id: "c1", created_at: "2026-08-04T12:00:00Z" }], error: null },
        { data: [], error: null }, // no assistant reply — prior pass failed
        { data: [], error: null }, // history
      ],
    });
    mockToolResponse("save_training_fields", { goal: "marathon" });
    mockLLMResponse("Marathon it is. What's the race?");

    await POST(makeRequest({ userId: "user-001", message: "training for a marathon" }));

    expect(sendSMS).toHaveBeenCalledWith("+12025551234", expect.stringContaining("Marathon it is"));
  });
});

// ---------------------------------------------------------------------------
// Off-topic handling outside the goals stage
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/handle — off-topic questions in non-goals stages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers a pricing question during schedule_confirm instead of completing onboarding", async () => {
    // handleScheduleConfirm treats any inbound message as confirmation and runs
    // completeOnboarding, so before off-topic classification moved into POST an unanswered
    // question here silently produced a plan instead of a reply.
    mockTables({
      users: [
        {
          data: onboardingUser({
            onboarding_data: {
              name: "Jake",
              goal: "marathon",
              strava_connected: true,
              stage: "schedule_confirm",
            },
          }),
          error: null,
        },
        { data: null, error: null }, // processing-lock write
      ],
      conversations: [
        { data: [], error: null }, // dedup: no prior inbound
        {
          data: [
            {
              role: "assistant",
              content: "Looks like you typically run Mon/Wed/Fri — sound right, or want different days?",
            },
          ],
          error: null,
        },
      ],
      training_profiles: { data: null, error: null },
      training_state: { data: null, error: null },
    });
    mockLLMResponse("OFF_TOPIC");
    mockLLMResponse(
      "There's a free 7-day trial, then it's a paid subscription. Looks like you typically run Mon/Wed/Fri — sound right, or want different days?"
    );

    await POST(makeRequest({ userId: "user-001", message: "how much does this cost" }));

    expect(sendSMS).toHaveBeenCalledWith("+12025551234", expect.stringContaining("7-day trial"));
    // Onboarding must NOT have been completed off the back of a question
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(tables).not.toContain("training_profiles");
    expect(tables).not.toContain("training_state");
  });

  it("answers an off-topic question during awaiting_strava instead of re-sending the link", async () => {
    mockTables({
      users: { data: onboardingUser({ onboarding_step: "awaiting_strava" }), error: null },
      conversations: [
        { data: [], error: null }, // dedup
        { data: [], error: null }, // history
      ],
    });
    mockLLMResponse("OFF_TOPIC");
    mockLLMResponse(
      "Nothing you log is shared with anyone else. To keep going I need to connect to Strava — the link's just above."
    );

    await POST(makeRequest({ userId: "user-001", message: "who else can see my data" }));

    const textSent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(textSent).toContain("Nothing you log is shared");
  });
});

// ---------------------------------------------------------------------------
// Injury-intake gate on the [READY] path
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/handle — injury intake is required before completion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes [READY] into injury intake when the stage never ran", async () => {
    // handleDataAnalysis normally writes stage: "injury_intake" after Strava connects. If it
    // throws first, the next message falls through to the goals stage, which sees Strava
    // connected and fires [READY] — completing onboarding with no injury data at all.
    mockTables({
      users: [
        { data: onboardingUser({ onboarding_data: { goal: "5k", strava_connected: true } }), error: null },
        { data: null, error: null }, // processing-lock write
      ],
      conversations: { data: [], error: null },
      activities: { data: [], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    });
    mockToolResponse("save_training_fields", { name: "Jake", goal: "5k" });
    mockLLMResponse("Great, that's everything I need.\n[READY]");

    await POST(makeRequest({ userId: "user-001", message: "that's everything" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const lastText = smsCalls[smsCalls.length - 1]?.[1] as string;
    expect(lastText).toContain("Has injury ever been a factor");

    // Must not have completed onboarding
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(tables).not.toContain("training_state");
  });

  it("does not re-ask when injury information is already on file", async () => {
    mockTables({
      users: [
        {
          data: onboardingUser({
            onboarding_data: {
              goal: "5k",
              strava_connected: true,
              training_days: ["tuesday", "thursday", "saturday"],
              current_niggles: "left shin gets sore after long runs",
            },
          }),
          error: null,
        },
        { data: null, error: null }, // processing-lock write
        { data: { onboarding_data: {} }, error: null }, // isReady persist
        { data: { onboarding_data: {} }, error: null }, // fresh fetch in completeOnboarding
        { data: { billing_enabled: false, reverse_trial_enabled: false, dashboard_token: null, phone_number: "+12025551234" }, error: null },
        { data: [{ id: "user-001" }], error: null }, // update guard
      ],
      conversations: { data: [], error: null },
      activities: { data: [], error: null },
      races: { data: [], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    });
    mockToolResponse("save_training_fields", { name: "Jake", goal: "5k" });
    mockLLMResponse("Great, that's everything I need.\n[READY]");

    await POST(makeRequest({ userId: "user-001", message: "that's everything" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const allText = smsCalls.map((c: unknown[]) => c[1] as string).join(" ");
    expect(allText).not.toContain("Has injury ever been a factor");
    // Onboarding proceeded to completion
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(tables).toContain("training_state");
  });
});
