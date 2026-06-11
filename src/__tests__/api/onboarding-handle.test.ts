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
    "eq", "neq", "is", "not", "gte", "lte", "in", "or", "order", "limit",
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
    // 3 LLM calls total: extraction + pre-search + Sonnet
    expect((anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
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

describe("POST /api/onboarding/handle — awaiting_cadence step (legacy transition)", () => {
  beforeEach(() => vi.clearAllMocks());

  // awaiting_cadence is a legacy state — new users never enter it (cadence is defaulted to
  // nightly_reminders at plan generation time). Users stuck in this state are silently
  // graduated: onboarding_step cleared, proactive_cadence set to nightly_reminders, no SMS.
  it("silently graduates legacy awaiting_cadence users — clears state, no SMS sent", async () => {
    mockTables({
      users: {
        data: onboardingUser({ onboarding_step: "awaiting_cadence", onboarding_data: { timezone_confirmed: true } }),
        error: null,
      },
      training_profiles: { data: null, error: null },
    });

    await POST(makeRequest({ userId: "user-001", message: "morning works for me" }));

    // No SMS should be sent — user is silently transitioned
    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    expect(smsCalls).toHaveLength(0);
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
        ...(externalPlanDescription ? { external_plan_description: externalPlanDescription } : {}),
      },
    });

    const counters: Record<string, number> = {};
    const tables: Record<string, { data: unknown; error: unknown } | Array<{ data: unknown; error: unknown }>> = {
      users: [
        { data: userData, error: null },
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
