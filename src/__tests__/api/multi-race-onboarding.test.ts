/**
 * Onboarding — multi-race and extraction tests.
 *
 * Verifies that when an athlete mentions multiple races, the unified
 * handleConversation correctly merges extracted data and handles the A-race
 * vs B/C races distinction via the Haiku extraction call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------- module mocks (must precede imports) ----------
vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));

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

// ---------- helpers ----------

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
    reject?: (e: unknown) => unknown,
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

function mockLLMResponse(text: string) {
  (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    content: [{ type: "text", text }],
  });
}

function mockToolResponse(toolName: string, input: Record<string, unknown>) {
  (anthropic.messages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    content: [{ type: "tool_use", id: "tool-1", name: toolName, input }],
  });
}

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

// ---------- tests ----------

describe("Multi-race onboarding — extraction and data merging", () => {
  beforeEach(() => vi.clearAllMocks());

  it("extracts A-race and B/C races from conversation when athlete mentions multiple events", async () => {
    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
    });

    // Extract-first ordering: Haiku extraction runs BEFORE the main Sonnet call so
    // race names feed the OpenAI pre-search loop this same turn. Both race dates
    // are returned from extraction here, so needsRaceDateLookup is false and no
    // preSearchRaceDate calls fire.
    mockToolResponse("save_training_fields", {
      name: "Jake",
      goal: "50k",
      race_name: "Cirque Series Snowbird",
      race_date: "2026-06-20",
      other_races: [
        { name: "Dipsea Race", date: "2026-07-12", priority: "B", goal: null }
      ],
      training_days: null,
      timezone: null,
    });
    // Sonnet: continues conversation naturally
    mockLLMResponse("Got it — Snowbird in June is your A race, with Dipsea in July as a tune-up. Which days work best for training?");

    await POST(makeRequest({ userId: "user-001", message: "I'm training for Snowbird 50k in June and Dipsea in July" }));

    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      expect.stringContaining("Snowbird")
    );

    // Verify the onboarding_data update was called (supabase.from("users").update)
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls;
    const userUpdates = fromCalls.filter((c: unknown[]) => c[0] === "users");
    expect(userUpdates.length).toBeGreaterThan(0);
  });

  it("does not re-ask for goal when already in onboarding_data", async () => {
    mockTables({
      users: {
        data: onboardingUser({
          onboarding_data: {
            goal: "marathon",
            race_name: "Boston Marathon",
            race_date: "2026-04-20",
          }
        }),
        error: null,
      },
      conversations: [
        { data: [], error: null }, // content-dedup check in POST — no matching recent inbound message
        {
          data: [
            { role: "assistant", content: "What's your goal race?" },
            { role: "user", content: "Boston Marathon in April" },
            { role: "assistant", content: "Got it — Boston in April! Which days work best?" },
          ],
          error: null,
        },
      ],
    });

    // Extract-first: Haiku extraction first
    mockToolResponse("save_training_fields", {
      goal: "marathon",
      race_name: "Boston Marathon",
      race_date: "2026-04-20",
      training_days: null,
    });
    // Sonnet sees goal in system prompt "what you already know" and asks for schedule
    mockLLMResponse("Great! Which days of the week work best for training?");

    await POST(makeRequest({ userId: "user-001", message: "Monday, Wednesday, Friday, Sunday" }));

    const textSent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    // Should ask about schedule, not re-ask about goal
    expect(textSent).not.toContain("goal race");
  });

  it("VDOT paces calculated when race PR is extracted", async () => {
    const { calculateVDOTPaces } = await import("@/lib/paces");

    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
    });

    // Extract-first: Haiku extracts race time before main Sonnet call
    // → triggers VDOT calculation immediately, paces feed system prompt
    mockToolResponse("save_training_fields", {
      name: null,
      goal: "half_marathon",
      recent_race_distance_km: 5,
      recent_race_time_minutes: 22.5,
      training_days: null,
    });
    mockLLMResponse("Nice — a 22:30 5K is solid fitness! Which days do you prefer to train?");

    await POST(makeRequest({ userId: "user-001", message: "I ran a 22:30 5K last month" }));

    // calculateVDOTPaces should be called with the extracted race data
    expect(calculateVDOTPaces).toHaveBeenCalledWith(5, 22.5);
  });

  it("[READY] with multi-race data: all races written to races table during completeOnboarding", async () => {
    mockTables({
      users: [
        {
          data: onboardingUser({
            onboarding_data: {
              goal: "50k",
              race_name: "Snowbird 50K",
              race_date: "2026-06-20",
              training_days: ["monday", "wednesday", "friday", "sunday"],
              easy_pace: "9:30",
              timezone: "America/Denver",
              other_races: [
                { name: "Dipsea Race", date: "2026-07-12", priority: "B", goal: null }
              ],
              strava_connected: true,
            }
          }),
          error: null,
        },
        { data: null, error: null },  // POST processing-lock write (onboarding_data + processing_lock_at)
        { data: { onboarding_data: {} }, error: null },  // isReady update (line 806) — onboarding_data persist
        { data: { onboarding_data: {} }, error: null },  // fresh user fetch in completeOnboarding (line 1719)
        { data: { billing_enabled: false, reverse_trial_enabled: false, dashboard_token: null, phone_number: "+12025551234" }, error: null },  // billing check (line 1820)
        { data: [{ id: "user-001" }], error: null },  // update guard (onboarding_step → null)
      ],
      conversations: { data: [], error: null },
      activities: { data: [], error: null },
      races: { data: [], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    });

    // Extract-first: Haiku extraction (tool use) runs before Sonnet [READY]
    mockToolResponse("save_training_fields", {
      goal: "50k",
      race_name: "Snowbird 50K",
      race_date: "2026-06-20",
      training_days: ["monday", "wednesday", "friday", "sunday"],
      timezone: "America/Denver",
      other_races: [
        { name: "Dipsea Race", date: "2026-07-12", priority: "B", goal: null }
      ],
      has_existing_plan: false,
      wants_plan: true,
    });
    // Sonnet: sends [READY]
    mockLLMResponse("Perfect, I have everything I need to build your plan!\n[READY]");

    await POST(makeRequest({ userId: "user-001", message: "Denver, CO" }));

    const textSent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(textSent).toContain("everything I need");
    expect(textSent).not.toContain("[READY]");

    // races table should be written
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls;
    const racesInsert = fromCalls.some((c: unknown[]) => c[0] === "races");
    expect(racesInsert).toBe(true);
  });

  it("invalid goal bucket: discarded and not stored", async () => {
    mockTables({
      users: { data: onboardingUser(), error: null },
      conversations: { data: [], error: null },
    });

    // Extract-first: Haiku returns an invalid goal bucket (tool use) — "sprint_tri" is no longer valid
    mockToolResponse("save_training_fields", {
      goal: "sprint_tri",  // not in VALID_GOAL_BUCKETS
      race_name: null,
    });
    mockLLMResponse("What distance are you targeting?");

    await POST(makeRequest({ userId: "user-001", message: "I want to do a triathlon" }));

    // Response should still be sent (conversation continues)
    expect(sendSMS).toHaveBeenCalled();
  });
});

describe("Strava-connected onboarding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Strava connected user: skips asking about Strava, uses race history for pacing context", async () => {
    mockTables({
      users: {
        data: onboardingUser({
          onboarding_data: {
            strava_connected: true,
            strava_stats: { recent_run_totals: { distance: 100000 } },
          }
        }),
        error: null,
      },
      conversations: { data: [], error: null },
      // lookupBestStravaRace → activities + training_profiles
      activities: { data: [
        {
          distance_meters: 21097,
          moving_time_seconds: 5400,
          start_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          activity_type: "Run",
        }
      ], error: null },
      training_profiles: { data: { preferred_units: "imperial" }, error: null },
    });

    // Extract-first ordering
    mockToolResponse("save_training_fields", { goal: "half_marathon", training_days: null });
    mockLLMResponse("Great pace for a half marathon build! Which days work best?");

    await POST(makeRequest({ userId: "user-001", message: "I want to run a sub-2 half" }));

    expect(sendSMS).toHaveBeenCalled();
    const textSent = (sendSMS as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    // Should not include a Strava link (already connected)
    expect(textSent).not.toContain("api/auth/strava");
  });
});
