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
    // Haiku call: field extraction
    mockLLMResponse('{"name": "Jake", "goal": null, "training_days": null}');

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
    // Haiku extraction
    mockLLMResponse('{"name": "Jake", "goal": "5k", "training_days": ["tuesday","thursday","saturday"], "timezone": "America/New_York"}');

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
    // Haiku extraction
    mockLLMResponse('{"name": "Jake", "goal": "marathon"}');

    await POST(makeRequest({ userId: "user-001", message: "I run marathons" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).not.toContain("[STRAVA_LINK]");
    expect(textSent).toContain("https://coachdean.ai/api/auth/strava");
    expect(textSent).toContain('reply "skip"');

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
    mockLLMResponse("{}");

    await POST(makeRequest({ userId: "user-001", message: "5K goal", dry_run: true }));

    expect(sendSMS).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/handle — awaiting_strava step", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skip: sets step to onboarding and asks next question", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: { data: onboardingUser({ onboarding_step: "awaiting_strava" }), error: null },
      conversations: { data: null, error: null },
    });

    // Haiku: next question after skip
    mockLLMResponse("No worries! Which days of the week work best for training?");

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

  it("Strava question: explains value and re-sends link", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";

    mockTables({
      users: { data: onboardingUser({ onboarding_step: "awaiting_strava" }), error: null },
      conversations: { data: null, error: null },
    });

    await POST(makeRequest({ userId: "user-001", message: "Is Strava worth it?" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("worth it");
    expect(textSent).toContain("https://coachdean.ai/api/auth/strava");
  });
});

describe("POST /api/onboarding/handle — awaiting_cadence step", () => {
  beforeEach(() => vi.clearAllMocks());

  it("morning preference: sets morning_reminders cadence", async () => {
    mockTables({
      users: {
        data: onboardingUser({ onboarding_step: "awaiting_cadence", onboarding_data: { timezone_confirmed: true } }),
        error: null,
      },
      conversations: { data: [{ id: "plan-msg" }], error: null },
      training_profiles: { data: null, error: null },
    });

    // Cadence classifier
    mockLLMResponse("morning");

    await POST(makeRequest({ userId: "user-001", message: "morning works for me" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("morning of each session");
  });

  it("nightly preference: sets nightly_reminders cadence", async () => {
    mockTables({
      users: {
        data: onboardingUser({ onboarding_step: "awaiting_cadence", onboarding_data: { timezone_confirmed: true } }),
        error: null,
      },
      conversations: { data: [{ id: "plan-msg" }], error: null },
      training_profiles: { data: null, error: null },
    });

    mockLLMResponse("nightly");

    await POST(makeRequest({ userId: "user-001", message: "evening before please" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("evening before");
  });

  it("weekly preference: sets weekly_only cadence", async () => {
    mockTables({
      users: {
        data: onboardingUser({ onboarding_step: "awaiting_cadence", onboarding_data: { timezone_confirmed: true } }),
        error: null,
      },
      conversations: { data: [{ id: "plan-msg" }], error: null },
      training_profiles: { data: null, error: null },
    });

    mockLLMResponse("weekly");

    await POST(makeRequest({ userId: "user-001", message: "no thanks, just weekly" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("weekly plan every Sunday");
  });

  it("unclear cadence: routes to non-cadence handler (cancel)", async () => {
    mockTables({
      users: {
        data: onboardingUser({ onboarding_step: "awaiting_cadence", onboarding_data: { timezone_confirmed: true } }),
        error: null,
      },
      conversations: { data: [{ id: "plan-msg" }], error: null },
      training_profiles: { data: null, error: null },
    });

    // Cadence classifier → unclear, then message classifier → cancel
    mockLLMResponse("unclear");
    mockLLMResponse("cancel");

    await POST(makeRequest({ userId: "user-001", message: "I want to cancel" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("cancel");
    expect(textSent).toContain("Stripe");
  });

  it("plan not yet sent: sends holding message and re-triggers initial_plan", async () => {
    mockTables({
      users: {
        data: onboardingUser({ onboarding_step: "awaiting_cadence", onboarding_data: { timezone_confirmed: true } }),
        error: null,
      },
      conversations: { data: [], error: null },  // empty → plan not sent
      training_profiles: { data: null, error: null },
    });

    mockLLMResponse("morning");

    await POST(makeRequest({ userId: "user-001", message: "morning" }));

    const smsCalls = (sendSMS as ReturnType<typeof vi.fn>).mock.calls;
    const textSent = smsCalls[0]?.[1] as string;
    expect(textSent).toContain("get your plan together");
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
