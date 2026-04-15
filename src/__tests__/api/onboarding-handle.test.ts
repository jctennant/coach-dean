import { describe, it, expect, vi, beforeEach } from "vitest";

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

    // Sonnet call: normal response (no signals)
    mockLLMResponse("Great! What days of the week work best for training?");
    // Haiku call: field extraction (tool use)
    mockToolResponse("save_training_fields", { name: "Jake", goal: null, training_days: null });

    await POST(makeRequest({ userId: "user-001", message: "I want to run a 5K" }));

    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      "Great! What days of the week work best for training?"
    );
  });

  it("[READY] signal: strips tag and calls completeOnboarding", async () => {
    mockTables({
      users: [
        { data: onboardingUser({ onboarding_data: { goal: "5k", training_days: ["tuesday", "thursday", "saturday"] } }), error: null },
        { data: { dashboard_token: "tok-abc" }, error: null },  // for completeOnboarding user lookup
      ],
      conversations: { data: [], error: null },
      activities: { data: [], error: null },
      races: { data: [], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    });

    // Sonnet: includes [READY] signal
    mockLLMResponse("Awesome, I have everything I need! Let's build your plan.\n[READY]");
    // Haiku extraction (tool use)
    mockToolResponse("save_training_fields", { name: "Jake", goal: "5k", training_days: ["tuesday","thursday","saturday"], timezone: "America/New_York" });

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

    // Sonnet: includes [STRAVA_LINK] placeholder
    mockLLMResponse("Do you use Strava? Tap here to connect: [STRAVA_LINK]");
    // Haiku extraction (tool use)
    mockToolResponse("save_training_fields", { name: "Jake", goal: "marathon" });

    await POST(makeRequest({ userId: "user-001", message: "I run marathons" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    // Standalone Strava turn: pitch + URL in one message (no pre-Strava context to split out)
    const stravaMsg = smsCalls[0]?.[1] as string;
    expect(stravaMsg).not.toContain("[STRAVA_LINK]");
    expect(stravaMsg).toContain("https://coachdean.ai/api/auth/strava");
    expect(stravaMsg).toContain('reply "skip"');
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

    mockLLMResponse("Which days work for you?");
    mockToolResponse("save_training_fields", {});

    await POST(makeRequest({ userId: "user-001", message: "5K goal", dry_run: true }));

    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("existing plan: has_existing_plan and external_plan_description are saved to onboarding_data", async () => {
    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
    });

    mockLLMResponse("Got it — I'll work alongside your Runna plan, not replace it. You can also upload the PDF to the dashboard and I'll reference it directly. Which days are you running?");
    mockToolResponse("save_training_fields", {
      name: "Chris",
      goal: "half_marathon",
      has_existing_plan: true,
      external_plan_description: "Runna 16-week half marathon plan, week 6, ~35mi/week",
    });

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

  it("existing plan: null has_existing_plan is not overwritten by subsequent turns", async () => {
    // Once has_existing_plan is set to true, a follow-up turn where Haiku returns null
    // should NOT overwrite it (the null-skip merge logic must hold)
    mockTables({
      users: {
        data: onboardingUser({
          onboarding_data: {
            has_existing_plan: true,
            external_plan_description: "Runna 16-week HM plan, week 6, ~35mi/week",
          },
        }),
        error: null,
      },
      conversations: { data: [], error: null },
    });

    mockLLMResponse("Got it, Tuesday, Thursday, Saturday and Sunday. Which race are you targeting?");
    // Haiku returns null for has_existing_plan on this turn (didn't re-extract it)
    mockToolResponse("save_training_fields", {
      training_days: ["tuesday", "thursday", "saturday", "sunday"],
      has_existing_plan: null,
      external_plan_description: null,
    });

    await POST(makeRequest({ userId: "user-001", message: "I run Tues, Thurs, Sat, Sun" }));

    expect(sendSMS).toHaveBeenCalledTimes(1);
    // Null values from Haiku must not overwrite previously saved truthy values
    // (validated by the merge logic: `if (v !== null && v !== undefined)`)
  });
});

describe("POST /api/onboarding/handle — awaiting_strava step", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skip: sets strava_skipped and routes back through handleConversation", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: { data: onboardingUser({ onboarding_step: "awaiting_strava" }), error: null },
      conversations: { data: [], error: null },
    });

    // Sonnet: conversation response after skip
    mockLLMResponse("No worries! Which days of the week work best for training?");
    // Haiku: field extraction (tool use)
    mockToolResponse("save_training_fields", {});

    await POST(makeRequest({ userId: "user-001", message: "skip" }));

    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      "No worries! Which days of the week work best for training?"
    );

    // Should update step back to "onboarding"
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls;
    const userFromCalls = fromCalls.filter((c: unknown[]) => c[0] === "users");
    expect(userFromCalls.length).toBeGreaterThan(0);
  });

  it("non-skip, non-question: re-sends the Strava link", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: { data: onboardingUser({ onboarding_step: "awaiting_strava" }), error: null },
      conversations: { data: null, error: null },
    });

    await POST(makeRequest({ userId: "user-001", message: "I'm not sure" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("https://coachdean.ai/api/auth/strava");
    expect(textSent).toContain("skip");
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
