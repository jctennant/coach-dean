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
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"complete":false,"no_event":false,"goal":null}' }],
      }),
    },
  },
}));

vi.mock("@/lib/track", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/paces", () => ({
  calculateVDOTPaces: vi.fn(),
  estimatePacesFromEasyPace: vi.fn(),
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

const INTRO_MSG = "Hey Tomo! I'm Coach Dean — your AI running coach, entirely over text.";

// ---------- Tests ----------

describe("POST /api/onboarding/handle — loop detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends de-escalation when last 2 assistant messages are identical (within 2 min)", async () => {
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString();

    mockTables({
      users: {
        data: {
          id: "user-001", phone_number: "+12025551234", name: "Tomo",
          onboarding_step: "awaiting_goal", onboarding_data: {},
        },
        error: null,
      },
      conversations: {
        data: [
          { content: INTRO_MSG, created_at: recentTime },
          { content: INTRO_MSG, created_at: recentTime },
        ],
        error: null,
      },
    });

    const req = makeRequest({ userId: "user-001", message: "you're not tomo lol" });
    await POST(req);

    expect(sendSMS).toHaveBeenCalledOnce();
    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      expect.stringMatching(/confused on my end/i)
    );
  });

  it("does NOT de-escalate when recent messages are different", async () => {
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString();

    mockTables({
      users: {
        data: {
          id: "user-001", phone_number: "+12025551234", name: "Tomo",
          onboarding_step: "awaiting_goal", onboarding_data: { intro_sent: true },
        },
        error: null,
      },
      conversations: {
        data: [
          { content: "What are you training for?", created_at: recentTime },
          { content: INTRO_MSG, created_at: recentTime }, // different from index 0
        ],
        error: null,
      },
    });

    const req = makeRequest({ userId: "user-001", message: "ok, i think there's some confusion" });
    await POST(req);

    expect(sendSMS).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/confused on my end/i)
    );
  });

  it("does NOT de-escalate when there is only one recent assistant message", async () => {
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString();

    mockTables({
      users: {
        data: {
          id: "user-001", phone_number: "+12025551234", name: "Tomo",
          onboarding_step: "awaiting_goal", onboarding_data: { intro_sent: true },
        },
        error: null,
      },
      conversations: {
        data: [
          { content: INTRO_MSG, created_at: recentTime },
        ],
        error: null,
      },
    });

    const req = makeRequest({ userId: "user-001", message: "what's up" });
    await POST(req);

    expect(sendSMS).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/confused on my end/i)
    );
  });

  it("sends step-appropriate de-escalation for awaiting_race_date", async () => {
    const raceDateRepeat = "When are you targeting for your race?";
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString();

    mockTables({
      users: {
        data: {
          id: "user-001", phone_number: "+12025551234", name: "Tomo",
          onboarding_step: "awaiting_race_date", onboarding_data: { goal: "marathon", intro_sent: true },
        },
        error: null,
      },
      conversations: {
        data: [
          { content: raceDateRepeat, created_at: recentTime },
          { content: raceDateRepeat, created_at: recentTime },
        ],
        error: null,
      },
    });

    const req = makeRequest({ userId: "user-001", message: "i dunno" });
    await POST(req);

    expect(sendSMS).toHaveBeenCalledOnce();
    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      expect.stringMatching(/tangled on my end/i)
    );
    // Should NOT ask "what are you training for?" — that step is already done
    expect(sendSMS).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/what are you training for/i)
    );
  });

  it("stays silent (no SMS) when de-escalation was already the last message sent", async () => {
    const deEscalation = "Looks like something got confused on my end — sorry about that! I'm Coach Dean, your AI running coach. What are you training for?";
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString();

    mockTables({
      users: {
        data: {
          id: "user-001", phone_number: "+12025551234", name: "Tomo",
          onboarding_step: "awaiting_goal", onboarding_data: {},
        },
        error: null,
      },
      conversations: {
        data: [
          { content: deEscalation, created_at: recentTime },
          { content: deEscalation, created_at: recentTime },
        ],
        error: null,
      },
    });

    const req = makeRequest({ userId: "user-001", message: "bro you're clearly another AI lol" });
    await POST(req);

    // De-escalation already sent — should stay silent rather than fire again
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("does NOT de-escalate when there are no recent assistant messages", async () => {
    mockTables({
      users: {
        data: {
          id: "user-001", phone_number: "+12025551234", name: "Tomo",
          onboarding_step: "awaiting_goal", onboarding_data: { intro_sent: true },
        },
        error: null,
      },
      conversations: {
        data: [],
        error: null,
      },
    });

    const req = makeRequest({ userId: "user-001", message: "I want to train for a 5K" });
    await POST(req);

    expect(sendSMS).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/confused on my end/i)
    );
  });
});

describe("POST /api/onboarding/handle — awaiting_race_date step", () => {
  function raceDateUser(onboardingDataOverrides: Record<string, unknown> = {}) {
    return {
      id: "user-001",
      phone_number: "+12025551234",
      name: "Jake",
      onboarding_step: "awaiting_race_date",
      onboarding_data: {
        goal: "10k",
        race_name: "Dipsea Trail Race",
        intro_sent: true,
        ...onboardingDataOverrides,
      },
    };
  }

  // Claude call order for awaiting_race_date:
  // 1. checkOffTopic (1 Haiku call) → {"on_topic": true}
  // 2. handleRaceDate fires 3 parallel calls:
  //    a. date parse Haiku → {"race_date": ...}
  //    b. extractAdditionalFields Haiku → {}
  //    c. acknowledgeSharedInfo Haiku → null

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves pre-filled race_date when Haiku returns null (user said 'yes')", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"on_topic": true}' }] })       // checkOffTopic
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"race_date": null}' }] })      // date parse
      .mockResolvedValueOnce({ content: [{ type: "text", text: "{}" }] })                       // extractAdditionalFields
      .mockResolvedValueOnce({ content: [{ type: "text", text: "null" }] });                    // acknowledgeSharedInfo

    const usersChain = chain({ data: raceDateUser({ race_date: "2026-06-08" }), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Yes, that's right" });
    await POST(req);

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => "onboarding_step" in payload
    );
    expect(stepUpdate).toBeDefined();
    // Pre-filled date must be preserved — not overwritten with null
    expect(stepUpdate[0].onboarding_data.race_date).toBe("2026-06-08");
    expect(stepUpdate[0].onboarding_data.race_date_confirmed).toBe(true);
  });

  it("uses the new date when Haiku parses an explicit correction", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"on_topic": true}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"race_date": "2026-06-15"}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "{}" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "null" }] });

    const usersChain = chain({ data: raceDateUser({ race_date: "2026-06-08" }), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Actually it's June 15th" });
    await POST(req);

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => "onboarding_step" in payload
    );
    expect(stepUpdate).toBeDefined();
    // Explicit correction takes precedence over the pre-filled date
    expect(stepUpdate[0].onboarding_data.race_date).toBe("2026-06-15");
    expect(stepUpdate[0].onboarding_data.race_date_confirmed).toBe(true);
  });

  it("awaiting_other_races is NOT skipped when race_date is preserved", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"on_topic": true}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"race_date": null}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "{}" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "null" }] });

    const usersChain = chain({ data: raceDateUser({ race_date: "2026-06-08" }), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Yep" });
    await POST(req);

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => "onboarding_step" in payload
    );
    expect(stepUpdate).toBeDefined();
    // With race_date preserved, findNextStep should advance to awaiting_other_races
    // (not skip it by treating race_date as null)
    expect(stepUpdate[0].onboarding_step).toBe("awaiting_other_races");
  });
});

describe("POST /api/onboarding/handle — awaiting_other_races step", () => {
  // Base user at the awaiting_other_races step with a marathon goal
  function otherRacesUser(onboardingDataOverrides: Record<string, unknown> = {}) {
    return {
      id: "user-001",
      phone_number: "+12025551234",
      name: "Tomo",
      onboarding_step: "awaiting_other_races",
      onboarding_data: {
        goal: "marathon",
        race_date: "2026-10-15",
        race_date_confirmed: true,
        intro_sent: true,
        ...onboardingDataOverrides,
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores empty other_races and advances when athlete says no other races", async () => {
    // handleOtherRaces makes 2 parallel Claude calls: parse + acknowledgeSharedInfo
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"other_races":[]}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "null" }] });

    const usersChain = chain({ data: otherRacesUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Nope, just the one!" });
    await POST(req);

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => "onboarding_step" in payload
    );
    expect(stepUpdate).toBeDefined();
    expect(stepUpdate[0].onboarding_data.other_races).toEqual([]);
    expect(stepUpdate[0].onboarding_data.other_races_answered).toBe(true);
    // Next step after other_races for marathon (non-ultra, no goal_time yet) is awaiting_goal_time
    expect(stepUpdate[0].onboarding_step).toBe("awaiting_goal_time");
  });

  it("stores B/C races parsed from the message and advances", async () => {
    const parsedRaces = [
      { date: "2026-06-14", name: "Spring Half", goal: "half_marathon", priority: "B" },
      { date: "2026-04-05", name: "Local 5K", goal: "5k", priority: "C" },
    ];
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ other_races: parsedRaces }) }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Nice — some solid tune-up races in there." }] });

    const usersChain = chain({ data: otherRacesUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    const req = makeRequest({
      userId: "user-001",
      message: "Yeah — a half marathon in June as a tune-up, and a local 5K in April just for fun",
    });
    await POST(req);

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => "onboarding_step" in payload
    );
    expect(stepUpdate).toBeDefined();
    expect(stepUpdate[0].onboarding_data.other_races).toHaveLength(2);
    expect(stepUpdate[0].onboarding_data.other_races[0].priority).toBe("B");
    expect(stepUpdate[0].onboarding_data.other_races[1].priority).toBe("C");
    expect(stepUpdate[0].onboarding_data.other_races_answered).toBe(true);
  });
});
