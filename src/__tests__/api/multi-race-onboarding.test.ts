/**
 * Multi-race onboarding tests.
 *
 * Covers the full flow when an athlete mentions multiple races (e.g. "Dipsea in
 * June, Sierre Zinal 31k in August, and A Basin in September"):
 *
 *  1. handleGoal routing  — awaiting_race_date is SKIPPED when secondary_goal
 *     is set; next step jumps straight to awaiting_other_races.
 *  2. Question content    — the A-race question doesn't include a pre-filled
 *     date (the date/name mismatch bug).
 *  3. handleOtherRaces    — confirmed_a_race_date collapses A-race + date
 *     confirmation into one turn; B/C races preserved from secondary_goal.
 *  4. A race promotion    — inline date confirms in one turn; missing date
 *     still falls back to awaiting_race_date.
 *  5. completeOnboarding  — A + B/C races written to the races table.
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

// ---------- helpers ----------

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
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(response).then(resolve, reject);
  return c;
}

function makeRequest(body: unknown) {
  return { json: () => Promise.resolve(body) } as unknown as Request;
}

/** User at awaiting_goal, name already known, intro already sent */
function goalUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-001",
    phone_number: "+12025551234",
    name: "Jake",
    onboarding_step: "awaiting_goal",
    onboarding_data: { intro_sent: true, name: "Jake" },
    ...overrides,
  };
}

/** User at awaiting_other_races with multi-race data already set */
function multiRaceOtherRacesUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-001",
    phone_number: "+12025551234",
    name: "Jake",
    onboarding_step: "awaiting_other_races",
    onboarding_data: {
      goal: "10k",
      race_name: "Dipsea",
      goal_distance_miles: 7.4,
      race_date: "2026-06-14",           // pre-filled from web search, unconfirmed
      secondary_goal: "Sierre Zinal 31k in August and A Basin Cirque in September",
      intro_sent: true,
      name: "Jake",
    },
    ...overrides,
  };
}

// ---------- Claude mock response helpers ----------

const ON_TOPIC = { content: [{ type: "text", text: '{"on_topic": true}' }] };
const ACK_NULL = { content: [{ type: "text", text: "null" }] };
const EXTRACT_JAKE = { content: [{ type: "text", text: '{"name":"Jake"}' }] };
const DETECT_NULL = { content: [{ type: "text", text: "null" }] };

function multiRaceAck(overrides: Record<string, unknown> = {}) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ack: "Dipsea is a classic — 7.4 miles from Mill Valley to Stinson Beach.",
        date: "2026-06-14",
        distance_miles: 7.4,
        secondary_goal: "Sierre Zinal 31k in August and A Basin Cirque in September",
        distance_options: null,
        ...overrides,
      }),
    }],
  };
}

function otherRacesResponse(overrides: Record<string, unknown> = {}) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        confirmed_a_race_date: null,
        other_races: [],
        new_a_race: null,
        ...overrides,
      }),
    }],
  };
}

// ============================================================
// Group 1: handleGoal — routing when secondary_goal is detected
// ============================================================

describe("handleGoal — multi-race routing", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("skips awaiting_race_date and routes to awaiting_other_races when secondary_goal is set", async () => {
    // handleGoal call order (checkOffTopic is SKIPPED for awaiting_goal):
    // 1. goalParse Sonnet  [parallel]
    // 2. extractAdditionalFields Haiku  [parallel]
    // 3. detectAndAnswerImmediate Haiku  [second parallel]
    // 4. generateRaceAcknowledgment Sonnet  [second parallel]
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"complete":true,"no_event":false,"goal":"10k","race_name":"Dipsea","goal_distance_miles":7.4}' }] })
      .mockResolvedValueOnce(EXTRACT_JAKE)
      .mockResolvedValueOnce(DETECT_NULL)
      .mockResolvedValueOnce(multiRaceAck());

    const usersChain = chain({ data: goalUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "I'm doing Dipsea in June, Sierre Zinal 31k in August, and A Basin in September" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(
      ([p]: [Record<string, unknown>]) => "onboarding_step" in p,
    );
    expect(stepUpdate).toBeDefined();
    // Must jump directly to awaiting_other_races — NOT awaiting_race_date
    expect(stepUpdate[0].onboarding_step).toBe("awaiting_other_races");
    expect(stepUpdate[0].onboarding_data.secondary_goal).toBeTruthy();
  });

  it("stores the web-search pre-filled race_date even when secondary_goal is set", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"complete":true,"no_event":false,"goal":"10k","race_name":"Dipsea","goal_distance_miles":7.4}' }] })
      .mockResolvedValueOnce(EXTRACT_JAKE)
      .mockResolvedValueOnce(DETECT_NULL)
      .mockResolvedValueOnce(multiRaceAck());

    const usersChain = chain({ data: goalUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "Dipsea June and Sierre Zinal August" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    // race_date from web search stored but NOT confirmed
    expect(stepUpdate[0].onboarding_data.race_date).toBe("2026-06-14");
    expect(stepUpdate[0].onboarding_data.race_date_confirmed).toBeFalsy();
  });

  it("routes to awaiting_race_date (not awaiting_other_races) for a single-race message", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"complete":true,"no_event":false,"goal":"marathon","race_name":null,"goal_distance_miles":null}' }] })
      .mockResolvedValueOnce(EXTRACT_JAKE)
      .mockResolvedValueOnce(DETECT_NULL)
      // No secondary_goal in ack
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ ack: "A marathon is a great goal.", date: "2026-10-15", secondary_goal: null, distance_miles: null, distance_options: null }) }] });

    const usersChain = chain({ data: goalUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "Training for the Chicago Marathon in October" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    expect(stepUpdate).toBeDefined();
    // Single race → awaiting_race_date first (normal flow)
    expect(stepUpdate[0].onboarding_step).toBe("awaiting_race_date");
  });
});

// ============================================================
// Group 2: awaiting_other_races — question content
// ============================================================

describe("awaiting_other_races — question content after multi-race goal", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("asks 'which is A race' and does NOT include a specific pre-filled date in the question", async () => {
    // This tests the bug where "Is the Sierre Zinal the A race? I have June 14 for it"
    // was sent — date came from Dipsea but was shown for Sierre Zinal (classifier mismatch).
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"complete":true,"no_event":false,"goal":"10k","race_name":"Dipsea","goal_distance_miles":7.4}' }] })
      .mockResolvedValueOnce(EXTRACT_JAKE)
      .mockResolvedValueOnce(DETECT_NULL)
      .mockResolvedValueOnce(multiRaceAck());

    const usersChain = chain({ data: goalUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "I'm doing Dipsea in June, Sierre Zinal 31k in August, and A Basin in September" }));

    expect(sendSMS).toHaveBeenCalled();
    const sentMessage: string = (sendSMS as ReturnType<typeof vi.fn>).mock.calls[0][1];

    // Must ask about the A race
    expect(sentMessage).toMatch(/A race/i);
    // Must NOT include "I have [date] for it" — that was the bug
    expect(sentMessage).not.toMatch(/I have .+ for it/);
    // Must NOT embed a specific date in the A-race question
    expect(sentMessage).not.toMatch(/I have (January|February|March|April|May|June|July|August|September|October|November|December) \d+/);
  });

  it("asks for dates for all races (not just the A race)", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"complete":true,"no_event":false,"goal":"10k","race_name":"Dipsea","goal_distance_miles":7.4}' }] })
      .mockResolvedValueOnce(EXTRACT_JAKE)
      .mockResolvedValueOnce(DETECT_NULL)
      .mockResolvedValueOnce(multiRaceAck());

    const usersChain = chain({ data: goalUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "conversations") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "Dipsea in June, Sierre Zinal in August, A Basin September" }));

    const sentMessage: string = (sendSMS as ReturnType<typeof vi.fn>).mock.calls[0][1];
    // The combined question should ask for dates for each race
    expect(sentMessage).toMatch(/dates/i);
  });
});

// ============================================================
// Group 3: handleOtherRaces — date confirmed inline
// ============================================================

describe("handleOtherRaces — date confirmation in same turn", () => {
  // handleOtherRaces call order:
  // 1. checkOffTopic Haiku
  // 2. parse Haiku  [parallel]
  // 3. acknowledgeSharedInfo Haiku  [parallel]
  // (4. lookupRaceDate Sonnet — only when new_a_race.date is null)

  beforeEach(() => { vi.clearAllMocks(); });

  it("sets race_date_confirmed when confirmed_a_race_date is returned and advances past awaiting_race_date", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      .mockResolvedValueOnce(otherRacesResponse({
        confirmed_a_race_date: "2026-06-14",
        other_races: [
          { date: "2026-08-08", name: "Sierre Zinal 31k", goal: "30k", priority: "B" },
          { date: "2026-09-20", name: "A Basin Cirque", goal: "10k", priority: "B" },
        ],
      }))
      .mockResolvedValueOnce(ACK_NULL);

    const usersChain = chain({ data: multiRaceOtherRacesUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "Yes! Dipsea June 14, Sierre Zinal August 8, A Basin September 20" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    expect(stepUpdate).toBeDefined();

    const data = stepUpdate[0].onboarding_data;
    expect(data.race_date).toBe("2026-06-14");
    expect(data.race_date_confirmed).toBe(true);
    // Should NOT loop back to awaiting_race_date
    expect(stepUpdate[0].onboarding_step).not.toBe("awaiting_race_date");
  });

  it("stores B/C races parsed in the same reply", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      .mockResolvedValueOnce(otherRacesResponse({
        confirmed_a_race_date: "2026-06-14",
        other_races: [
          { date: "2026-08-08", name: "Sierre Zinal 31k", goal: "30k", priority: "B" },
          { date: "2026-09-20", name: "A Basin Cirque", goal: "10k", priority: "B" },
        ],
      }))
      .mockResolvedValueOnce(ACK_NULL);

    const usersChain = chain({ data: multiRaceOtherRacesUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "Yes! Dipsea June 14, Sierre Zinal August 8, A Basin September 20" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    const data = stepUpdate[0].onboarding_data;

    expect(data.other_races).toHaveLength(2);
    expect(data.other_races[0].name).toBe("Sierre Zinal 31k");
    expect(data.other_races[0].priority).toBe("B");
    expect(data.other_races[1].name).toBe("A Basin Cirque");
    expect(data.other_races_answered).toBe(true);
  });

  it("loops back to awaiting_race_date when no date is confirmed in the reply", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      // confirmed_a_race_date: null and no new_a_race
      .mockResolvedValueOnce(otherRacesResponse({
        confirmed_a_race_date: null,
        other_races: [{ date: "2026-08-08", name: "Sierre Zinal 31k", goal: "30k", priority: "B" }],
      }))
      .mockResolvedValueOnce(ACK_NULL);

    const usersChain = chain({
      data: multiRaceOtherRacesUser({
        onboarding_data: {
          // race_date is null — no pre-fill available
          goal: "10k", race_name: "Dipsea", secondary_goal: "Sierre Zinal", intro_sent: true, name: "Jake",
        },
      }),
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "Yes, Dipsea is the A race!" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    expect(stepUpdate[0].onboarding_step).toBe("awaiting_race_date");
  });

  it("includes secondary_goal context in the LLM system prompt", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      .mockResolvedValueOnce(otherRacesResponse({ confirmed_a_race_date: "2026-06-14", other_races: [] }))
      .mockResolvedValueOnce(ACK_NULL);

    const usersChain = chain({ data: multiRaceOtherRacesUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "Yes — Dipsea June 14" }));

    // The 2nd Claude call (parallel parse) should contain secondary_goal text in system prompt
    const parseCalls = vi.mocked(anthropic.messages.create).mock.calls;
    // parseCalls[0] = checkOffTopic, parseCalls[1] = parse (first of parallel pair)
    const parseCallSystem = parseCalls[1][0].system as string;
    expect(parseCallSystem).toContain("Sierre Zinal 31k in August");
  });
});

// ============================================================
// Group 4: handleOtherRaces — A race promotion
// ============================================================

describe("handleOtherRaces — A race promotion", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("confirms A race in one turn when promotion includes an inline date", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      .mockResolvedValueOnce(otherRacesResponse({
        new_a_race: { name: "Sierre Zinal 31k", goal: "30k", date: "2026-08-08" },
        other_races: [{ date: "2026-06-14", name: "Dipsea", goal: "10k", priority: "B" }],
        confirmed_a_race_date: null,
      }))
      .mockResolvedValueOnce(ACK_NULL);
    // lookupRaceDate NOT called because new_a_race.date is already set

    const usersChain = chain({ data: multiRaceOtherRacesUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "No — Sierre Zinal is my A race, August 8" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    expect(stepUpdate).toBeDefined();

    const data = stepUpdate[0].onboarding_data;
    expect(data.race_name).toBe("Sierre Zinal 31k");
    expect(data.race_date).toBe("2026-08-08");
    expect(data.race_date_confirmed).toBe(true);
    // Does NOT need to loop back for date confirmation
    expect(stepUpdate[0].onboarding_step).not.toBe("awaiting_race_date");
  });

  it("old A race is moved to other_races as B when promotion happens", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      .mockResolvedValueOnce(otherRacesResponse({
        new_a_race: { name: "Sierre Zinal 31k", goal: "30k", date: "2026-08-08" },
        // LLM didn't include Dipsea in other_races — should be auto-added
        other_races: [],
        confirmed_a_race_date: null,
      }))
      .mockResolvedValueOnce(ACK_NULL);

    const usersChain = chain({ data: multiRaceOtherRacesUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "No, Sierre Zinal is my A, August 8" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    const data = stepUpdate[0].onboarding_data;

    // Old A race (Dipsea) should appear in other_races as B
    const dipsea = (data.other_races as Array<Record<string, unknown>>).find(
      r => typeof r.name === "string" && r.name.toLowerCase().includes("dipsea"),
    );
    expect(dipsea).toBeDefined();
    expect(dipsea?.priority).toBe("B");
  });

  it("loops back to awaiting_race_date when promoted race has no date from parse or web search", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      .mockResolvedValueOnce(otherRacesResponse({
        new_a_race: { name: "Sierre Zinal 31k", goal: "30k", date: null },
        other_races: [],
        confirmed_a_race_date: null,
      }))
      .mockResolvedValueOnce(ACK_NULL)
      // lookupRaceDate Sonnet — returns no date
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"date": null}' }] });

    const usersChain = chain({ data: multiRaceOtherRacesUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "No, Sierre Zinal is the A race" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    expect(stepUpdate[0].onboarding_step).toBe("awaiting_race_date");
  });

  it("does NOT loop back to awaiting_race_date when web search finds the promoted race date", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      .mockResolvedValueOnce(otherRacesResponse({
        new_a_race: { name: "Sierre Zinal 31k", goal: "30k", date: null },
        other_races: [],
        confirmed_a_race_date: null,
      }))
      .mockResolvedValueOnce(ACK_NULL)
      // lookupRaceDate finds the date
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"date": "2026-08-08"}' }] });

    const usersChain = chain({ data: multiRaceOtherRacesUser(), error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "No, Sierre Zinal is the A race" }));

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);
    const data = stepUpdate[0].onboarding_data;
    expect(data.race_date).toBe("2026-08-08");
    expect(data.race_date_confirmed).toBe(true);
    expect(stepUpdate[0].onboarding_step).not.toBe("awaiting_race_date");
  });
});

// ============================================================
// Group 5: completeOnboarding — races table written correctly
// ============================================================

describe("completeOnboarding — races table for multi-race athlete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
  });

  /**
   * Fast-path: user at awaiting_schedule step with all prior data already set,
   * including confirmed A race and B/C other_races. Reply with training days
   * to trigger completeOnboarding.
   */
  it("writes A race and B/C races to races table when onboarding completes", async () => {
    // handleSchedule call order (checkOffTopic IS called for awaiting_schedule):
    // 1. checkOffTopic Haiku
    // 2. scheduleParser Haiku [parallel with extractAdditionalFields]
    // 3. extractAdditionalFields Haiku [parallel]
    // completeOnboarding is called directly (nextStep=null since all steps satisfied)
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({
        complete: true,
        days_per_week: 4,
        training_days: ["Monday", "Wednesday", "Friday", "Sunday"],
      }) }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "{}" }] }); // extractAdditionalFields

    const racesChain = chain({ data: null, error: null });
    const usersChain = chain({
      data: {
        id: "user-001",
        phone_number: "+12025551234",
        name: "Jake",
        onboarding_step: "awaiting_schedule",
        onboarding_data: {
          goal: "10k",
          race_name: "Dipsea",
          race_date: "2026-06-14",
          race_date_confirmed: true,
          goal_distance_miles: 7.4,
          goal_time_minutes: null,
          other_races: [
            { date: "2026-08-08", name: "Sierre Zinal 31k", goal: "30k", priority: "B" },
            { date: "2026-09-20", name: "A Basin Cirque", goal: "10k", priority: "C" },
          ],
          other_races_answered: true,
          strava_skipped: true,
          intro_sent: true,
          name: "Jake",
          weekly_miles: 35,
          easy_pace: "9:00",
        },
      },
      error: null,
    });

    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      if (table === "races") return racesChain;
      return chain({ data: null, error: null });
    });

    await POST(makeRequest({ userId: "user-001", message: "Monday, Wednesday, Friday, Sunday" }));

    // races.delete() should be called first (cleanup), then insert
    const deleteCalls = (racesChain.delete as ReturnType<typeof vi.fn>).mock.calls;
    expect(deleteCalls.length).toBeGreaterThan(0);

    const insertCalls = (racesChain.insert as ReturnType<typeof vi.fn>).mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);

    const inserted = insertCalls[0][0] as Array<Record<string, unknown>>;
    const priorities = inserted.map(r => r.priority).sort();
    expect(priorities).toEqual(["A", "B", "C"]);

    const aRace = inserted.find(r => r.priority === "A");
    expect(aRace?.race_name).toBe("Dipsea");
    expect(aRace?.race_date).toBe("2026-06-14");

    const bRace = inserted.find(r => r.priority === "B");
    expect(bRace?.race_name).toBe("Sierre Zinal 31k");
    expect(bRace?.race_date).toBe("2026-08-08");
  });
});
