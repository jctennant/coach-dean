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
    // Claude call order for awaiting_other_races:
    // 1. checkOffTopic Haiku → {"on_topic": true}  (added when awaiting_other_races was added to stepContext)
    // 2. handleOtherRaces parse Haiku → {"other_races": []}
    // 3. acknowledgeSharedInfo Haiku → null
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"on_topic": true}' }] })
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
    // Claude call order:
    // 1. checkOffTopic Haiku → {"on_topic": true}
    // 2. handleOtherRaces parse Haiku → {"other_races": [...]}
    // 3. acknowledgeSharedInfo Haiku → ack text
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"on_topic": true}' }] })
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

describe("POST /api/onboarding/handle — awaiting_name step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("goal message without a name routes to awaiting_name first", async () => {
    // Call order in handleGoal (complete goal, no named race, no otherNotes):
    // 1. goal parse (Sonnet)
    // 2. extractAdditionalFields (Haiku) → no name
    // 3. detectAndAnswerImmediate (Haiku) → null
    // 4. generateRaceAcknowledgment (Sonnet) → null
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"complete":true,"no_event":false,"goal":"marathon","race_name":null,"goal_distance_miles":null}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "null" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "null" }] });

    const usersChain = chain({
      data: { id: "user-001", phone_number: "+12025551234", name: null, onboarding_step: "awaiting_goal", onboarding_data: { intro_sent: true } },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Training for a marathon in October" });
    await POST(req);

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => "onboarding_step" in payload
    );
    expect(stepUpdate).toBeDefined();
    expect(stepUpdate[0].onboarding_step).toBe("awaiting_name");
  });

  it("goal message that includes a name skips awaiting_name and goes to awaiting_race_date", async () => {
    // extractAdditionalFields returns a name → awaiting_name is satisfied → next is awaiting_race_date
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"complete":true,"no_event":false,"goal":"marathon","race_name":null,"goal_distance_miles":null}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"name":"Jake"}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "null" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "null" }] });

    const usersChain = chain({
      data: { id: "user-001", phone_number: "+12025551234", name: null, onboarding_step: "awaiting_goal", onboarding_data: { intro_sent: true } },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Hey it's Jake, training for a marathon" });
    await POST(req);

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => "onboarding_step" in payload
    );
    expect(stepUpdate).toBeDefined();
    expect(stepUpdate[0].onboarding_step).toBe("awaiting_race_date");
  });

  it("handleName advances to awaiting_race_date and greets by name", async () => {
    // extractName (Haiku) returns "Jake"
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Jake" }] });

    const usersChain = chain({
      data: {
        id: "user-001", phone_number: "+12025551234", name: null,
        onboarding_step: "awaiting_name",
        onboarding_data: { goal: "marathon", intro_sent: true },
      },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Jake" });
    await POST(req);

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(
      ([payload]: [Record<string, unknown>]) => "onboarding_step" in payload
    );
    expect(stepUpdate).toBeDefined();
    expect(stepUpdate[0].name).toBe("Jake");
    expect(stepUpdate[0].onboarding_step).toBe("awaiting_race_date");

    // Should greet by name in the transition message
    const smsCalls = vi.mocked(sendSMS).mock.calls;
    const transitionSMS = smsCalls[smsCalls.length - 1];
    expect(transitionSMS[1]).toContain("Jake");
  });
});

// ---------------------------------------------------------------------------
// Coaching question handling — onboarding should answer questions at any step
// rather than ignoring them or giving a 1-sentence non-answer.
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/handle — coaching questions during onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Prevent real fetch calls (e.g. plan_feedback → initial_plan re-trigger)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
  });

  // ── Bug 5 regression ──────────────────────────────────────────────────────
  // Athlete asks to change the plan during awaiting_cadence.
  // Old behavior: bare cadence re-ask, plan never revised.
  // Fixed: acknowledge change, store preference in conversation history,
  //        re-trigger initial_plan so Dean rebuilds with the new preferences.
  it("awaiting_cadence: plan change request triggers acknowledgment + initial_plan re-trigger", async () => {
    // Claude call order:
    // 1. handleCadence Haiku (classify cadence) → "unclear"
    // 2. handleNonCadenceMessage Haiku (classify message type) → "plan_feedback"
    // 3. handleNonCadenceMessage Sonnet (generate acknowledgment) → ack text
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "unclear" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "plan_feedback" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Absolutely — rebuilding around 1-2 runs and 4 cycling days." }] });

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return chain({ data: { id: "user-001", phone_number: "+12025551234", name: "Alex", onboarding_step: "awaiting_cadence", onboarding_data: {} }, error: null });
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Do I need to run this much? I'd like to only run 1-2 times a week and cycle 4 days." });
    await POST(req);

    // Should send the acknowledgment, not the bare cadence re-ask
    expect(sendSMS).toHaveBeenCalledOnce();
    const smsText = vi.mocked(sendSMS).mock.calls[0][1];
    expect(smsText).toMatch(/rebuild|1-2|cycling/i);
    expect(smsText).not.toBe("Just one last thing before your plan: would you prefer reminders the morning of each session, the evening before, or just a weekly Sunday overview?");

    // initial_plan should be re-triggered to regenerate the plan with new preferences
    const fetchMock = vi.mocked(global.fetch as ReturnType<typeof vi.fn>);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/coach/respond"),
      expect.objectContaining({ body: expect.stringContaining("initial_plan") })
    );
  });

  // ── Bug 6 regression ──────────────────────────────────────────────────────
  // Athlete asks a coaching question during awaiting_cadence.
  // Old behavior: question silently ignored, bare cadence re-ask sent.
  // Fixed: question answered by Sonnet, cadence re-ask appended at end.
  it("awaiting_cadence: coaching question is answered and cadence is re-asked at the end", async () => {
    // Claude call order:
    // 1. handleCadence Haiku → "unclear"
    // 2. handleNonCadenceMessage Haiku → "coaching_question"
    // 3. handleNonCadenceMessage Sonnet → answer + cadence question
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "unclear" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "coaching_question" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "For a first half marathon you don't need to run the full distance beforehand. Build up to 10-11 miles and race-day adrenaline carries you the rest.\n\nOne last thing — would you prefer reminders the morning of each session, the evening before, or just a weekly Sunday overview?" }] });

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return chain({ data: { id: "user-001", phone_number: "+12025551234", name: "Vivian", onboarding_step: "awaiting_cadence", onboarding_data: {} }, error: null });
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Should I try to run almost a half marathon before the actual race?" });
    await POST(req);

    expect(sendSMS).toHaveBeenCalledOnce();
    const smsText = vi.mocked(sendSMS).mock.calls[0][1];
    // Should contain the coaching answer
    expect(smsText).toMatch(/half marathon|training|adrenaline/i);
    // Should still include the cadence question
    expect(smsText).toMatch(/morning.*session|evening before|weekly.*Sunday/i);
  });

  // ── checkOffTopic improvement ─────────────────────────────────────────────
  // Coaching questions at steps with off-topic check (e.g. awaiting_schedule)
  // previously got a 1-sentence Haiku non-answer. Now get a real Sonnet answer.
  it("awaiting_schedule: coaching question gets a real Sonnet answer and re-asks the schedule question", async () => {
    // Claude call order:
    // 1. checkOffTopic Haiku → {"on_topic": false, "type": "coaching_question"}
    // 2. checkOffTopic Sonnet (generate answer) → answer + re-ask
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"on_topic": false, "type": "coaching_question"}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Long runs build your aerobic base and train your body to use fat efficiently — they're the backbone of half marathon prep.\n\nHow many days a week are you looking to train?" }] });

    const usersChain = chain({ data: { id: "user-001", phone_number: "+12025551234", name: "Sam", onboarding_step: "awaiting_schedule", onboarding_data: { goal: "half_marathon", intro_sent: true } }, error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "Why do I need to do long runs?" });
    await POST(req);

    expect(sendSMS).toHaveBeenCalledOnce();
    const smsText = vi.mocked(sendSMS).mock.calls[0][1];
    // Should contain the Sonnet coaching answer (not a throwaway 1-sentence)
    expect(smsText).toMatch(/long run|aerobic|base/i);
    // Should include the schedule re-ask at the end
    expect(smsText).toMatch(/how many days|days.*week/i);
    // Step should NOT have advanced — no onboarding_step update on usersChain
    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    expect(stepUpdate).toBeUndefined();
  });

  // ── awaiting_strava expansion ─────────────────────────────────────────────
  // Previously only Strava-specific questions ("?" + /strava/i) were detected.
  // General coaching questions were silently treated as a skip.
  it("awaiting_strava: non-Strava coaching question is answered and Strava link is nudged", async () => {
    // Claude call order:
    // 1. detectAndAnswerImmediate Haiku → answer text
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Aim for 3-4 runs per week with one long run at the weekend for a half marathon." }] });

    const usersChain = chain({ data: { id: "user-001", phone_number: "+12025551234", name: null, onboarding_step: "awaiting_strava", onboarding_data: { goal: "half_marathon", intro_sent: true } }, error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    const req = makeRequest({ userId: "user-001", message: "How many runs per week should I be doing?" });
    await POST(req);

    expect(sendSMS).toHaveBeenCalledOnce();
    const smsText = vi.mocked(sendSMS).mock.calls[0][1];
    // Should contain the coaching answer
    expect(smsText).toMatch(/runs? per week|long run/i);
    // Should include the Strava nudge (not silently treat message as a skip)
    expect(smsText).toMatch(/strava/i);
    // Step should NOT have advanced to awaiting_schedule
    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    expect(stepUpdate).toBeUndefined();
  });
});
