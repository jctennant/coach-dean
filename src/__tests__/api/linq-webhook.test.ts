import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------- Capture after() callbacks so tests can await background work ----------
const afterQueue: Array<() => Promise<void>> = [];

async function flush() {
  const cbs = afterQueue.splice(0);
  for (const fn of cbs) await fn();
}

// ---------- module mocks (must be before imports) ----------
vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("@/lib/linq", () => ({
  sendSMS: vi.fn().mockResolvedValue({ chatId: "chat-123" }),
  startTyping: vi.fn().mockResolvedValue(undefined),
  markRead: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/anthropic", () => ({
  anthropic: {
    messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Great run!" }] }) },
  },
}));

vi.mock("@/lib/track", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/timezone", () => ({
  inferTimezoneFromPhone: vi.fn().mockReturnValue("America/New_York"),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({ data, init }),
  },
  after: (fn: () => Promise<void>) => {
    afterQueue.push(fn);
  },
}));

vi.mock("crypto", () => ({
  default: {
    createHmac: () => ({ update: () => ({ digest: () => "valid-sig" }) }),
  },
}));

// ---------- imports (after mocks) ----------
import { POST } from "@/app/api/webhooks/linq/route";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";

// ---------- Helpers ----------

/**
 * Build a chainable mock for a single table response.
 * The chain supports: .select/.insert/.update/.eq etc → return self
 * .single()/.maybeSingle() → resolve with `response`
 * Direct await (thenable) → resolve with `response`
 */
function chain(response: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "update", "upsert", "delete",
    "eq", "neq", "is", "not", "gte", "lte", "in", "or", "order", "limit",
  ];
  for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
  c["single"] = vi.fn().mockResolvedValue(response);
  c["maybeSingle"] = vi.fn().mockResolvedValue(response);
  // Thenable: supports `await supabase.from("x").update({}).eq(...)` without .single()
  c["then"] = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown
  ) => Promise.resolve(response).then(resolve, reject);
  return c as typeof c;
}

/**
 * Build a request that mimics a Linq webhook payload.
 * LINQ_WEBHOOK_SECRET is left unset so signature verification is skipped.
 */
function makeRequest(phone: string, text: string, opts: { chatId?: string; event?: string } = {}) {
  const event = opts.event ?? "message.received";
  const chatId = opts.chatId ?? "chat-abc";
  const rawBody = JSON.stringify({
    data: {
      id: "msg-001",
      chat_id: chatId,
      sender_handle: { handle: phone },
      parts: [{ type: "text", value: text }],
    },
  });

  return {
    headers: {
      get: (key: string) => {
        if (key === "x-webhook-event") return event;
        return null; // no signature headers → skip verification
      },
    },
    text: () => Promise.resolve(rawBody),
  } as unknown as Request;
}

/**
 * Set up supabase.from() to return different data per table.
 * `tables` maps table name → response. Any table not listed returns { data: null, error: null }.
 * For tables called multiple times, provide an array of responses consumed in order.
 */
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

// ---------- Tests ----------

describe("POST /api/webhooks/linq — non-message events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    delete process.env.LINQ_WEBHOOK_SECRET;
  });

  it("returns ok immediately and ignores non-message events", async () => {
    const req = makeRequest("+12025551234", "hi", { event: "read.receipt" });
    const res = await POST(req);
    await flush();
    expect((res as { data: { ok: boolean } }).data.ok).toBe(true);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/linq — opt-out (STOP keywords)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    delete process.env.LINQ_WEBHOOK_SECRET;
  });

  const hardStopKeywords = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "QUIT"];

  it.each(hardStopKeywords)("opts out user on hard-stop keyword: %s", async (keyword) => {
    mockTables({
      conversations: { data: null, error: null }, // no dedup
      users: { data: { id: "user-001", linq_chat_id: "chat-abc" }, error: null },
    });

    const req = makeRequest("+12025551234", keyword);
    await POST(req);
    await flush();

    expect(sendSMS).toHaveBeenCalledWith("+12025551234", expect.stringMatching(/unsubscribed/i));
  });

  it("opts out on 'STOP MESSAGES' (short stop phrase)", async () => {
    mockTables({
      conversations: { data: null, error: null },
      users: { data: { id: "user-001", linq_chat_id: "chat-abc" }, error: null },
    });

    const req = makeRequest("+12025551234", "STOP MESSAGES");
    await POST(req);
    await flush();

    expect(sendSMS).toHaveBeenCalledWith("+12025551234", expect.stringMatching(/unsubscribed/i));
  });

  it("does NOT opt out when 'stop' appears in a casual training question", async () => {
    // The coaching path has a 10s debounce — use fake timers to skip it.
    vi.useFakeTimers();
    try {
      mockTables({
        conversations: { data: null, error: null },
        users: {
          data: {
            id: "user-001", onboarding_step: null, timezone: "America/New_York",
            linq_chat_id: "chat-abc", messaging_opted_out: false,
            reengagement_sent_at: null, strava_athlete_id: null,
          },
          error: null,
        },
      });

      // "stop" appears but not followed by texting/messaging/sending/messages
      const req = makeRequest("+12025551234", "Should I stop at mile 10 or push through the full 13?");
      await POST(req);
      // Start flush (which triggers the after() callback including the 10s debounce),
      // then advance fake timers to resolve the pending setTimeout inside.
      const flushPromise = flush();
      await vi.advanceTimersByTimeAsync(15_000);
      await flushPromise;

      expect(sendSMS).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/unsubscribed/i)
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /api/webhooks/linq — opt-in (START keyword)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    delete process.env.LINQ_WEBHOOK_SECRET;
  });

  it("re-subscribes opted-out user on START keyword", async () => {
    mockTables({
      conversations: { data: null, error: null },
      users: { data: { id: "user-001", linq_chat_id: "chat-abc", messaging_opted_out: true }, error: null },
    });

    const req = makeRequest("+12025551234", "START");
    await POST(req);
    await flush();

    expect(sendSMS).toHaveBeenCalledWith("+12025551234", expect.stringMatching(/welcome back/i));
  });
});

describe("POST /api/webhooks/linq — message routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    delete process.env.LINQ_WEBHOOK_SECRET;
  });

  it("routes message from new user (no record) to onboarding/handle", async () => {
    mockTables({
      conversations: { data: null, error: null }, // no dedup
      users: [
        { data: null, error: null },              // lookup → not found
        { data: { id: "new-user-001" }, error: null }, // insert → created
      ],
    });

    const req = makeRequest("+12025551234", "I want to train for a 5K");
    await POST(req);
    await flush();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("onboarding/handle"),
      expect.objectContaining({ method: "POST" })
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("coach/respond"),
      expect.anything()
    );
  });

  it("routes onboarding user message to onboarding/handle", async () => {
    vi.useFakeTimers();
    try {
      mockTables({
        // conversations is called 3x: dedup check, insert (storedMsg), debounce latest-msg check
        conversations: [
          { data: null, error: null },                    // dedup → no existing
          { data: { id: "conv-001" }, error: null },      // insert → storedMsg
          { data: { id: "conv-001" }, error: null },      // debounce check → same id → proceed
        ],
        users: {
          data: {
            id: "user-001", onboarding_step: "awaiting_goal",
            timezone: "America/New_York", linq_chat_id: "chat-abc",
            messaging_opted_out: false, reengagement_sent_at: null, strava_athlete_id: null,
          },
          error: null,
        },
      });

      const req = makeRequest("+12025551234", "I want to run a marathon");
      await POST(req);
      const flushPromise = flush();
      await vi.advanceTimersByTimeAsync(15_000);
      await flushPromise;

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("onboarding/handle"),
        expect.objectContaining({ method: "POST" })
      );
      expect(global.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining("coach/respond"),
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("onboarding burst debounce: skips when a newer message has arrived", async () => {
    vi.useFakeTimers();
    try {
      mockTables({
        // conversations: dedup → null, insert → conv-001, debounce check → conv-002 (newer!)
        conversations: [
          { data: null, error: null },
          { data: { id: "conv-001" }, error: null },
          { data: { id: "conv-002" }, error: null }, // different id → newer message arrived
        ],
        users: {
          data: {
            id: "user-001", onboarding_step: "awaiting_goal",
            timezone: "America/New_York", linq_chat_id: "chat-abc",
            messaging_opted_out: false, reengagement_sent_at: null, strava_athlete_id: null,
          },
          error: null,
        },
      });

      const req = makeRequest("+12025551234", "wait hold up");
      await POST(req);
      const flushPromise = flush();
      await vi.advanceTimersByTimeAsync(15_000);
      await flushPromise;

      // A newer message arrived during the debounce window — this call should be skipped
      expect(global.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining("onboarding/handle"),
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores messages from opted-out users (no fetch, no SMS)", async () => {
    mockTables({
      conversations: { data: null, error: null }, // no dedup
      users: {
        data: {
          id: "user-001", onboarding_step: null, messaging_opted_out: true,
          linq_chat_id: "chat-abc", reengagement_sent_at: null, strava_athlete_id: null,
        },
        error: null,
      },
    });

    const req = makeRequest("+12025551234", "hello");
    await POST(req);
    await flush();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("'my plan' with token: sends link immediately, skips coach/respond", async () => {
    mockTables({
      conversations: [
        { data: null, error: null },           // dedup check → no existing
        { data: { id: "conv-001" }, error: null }, // insert storedMsg
      ],
      users: {
        data: {
          id: "user-001", onboarding_step: null, timezone: "America/New_York",
          linq_chat_id: "chat-abc", messaging_opted_out: false,
          reengagement_sent_at: null, strava_athlete_id: "12345",
          dashboard_token: "tok-abc123",
        },
        error: null,
      },
    });

    const req = makeRequest("+12025551234", "my plan");
    await POST(req);
    await flush();

    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      expect.stringContaining("http://localhost:3000/dashboard?token=tok-abc123")
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("coach/respond"),
      expect.anything()
    );
  });

  it("'my plan' case-insensitive variants all send the link", async () => {
    for (const variant of ["My plan", "MY PLAN", "my training plan", "My Training Plan"]) {
      vi.clearAllMocks();
      afterQueue.splice(0);
      mockTables({
        conversations: [
          { data: null, error: null },
          { data: { id: "conv-001" }, error: null },
        ],
        users: {
          data: {
            id: "user-001", onboarding_step: null, timezone: "America/New_York",
            linq_chat_id: "chat-abc", messaging_opted_out: false,
            reengagement_sent_at: null, strava_athlete_id: null,
            dashboard_token: "tok-xyz",
          },
          error: null,
        },
      });

      const req = makeRequest("+12025551234", variant);
      await POST(req);
      await flush();

      expect(sendSMS).toHaveBeenCalledWith(
        "+12025551234",
        expect.stringContaining("tok-xyz")
      );
    }
  });

  it("'my plan' with no token: falls through to coach/respond instead of dead-end message", async () => {
    vi.useFakeTimers();
    try {
      mockTables({
        conversations: [
          { data: null, error: null },           // dedup check
          { data: { id: "conv-001" }, error: null }, // insert storedMsg
          { data: { id: "conv-001" }, error: null }, // debounce latest-msg check
        ],
        users: {
          data: {
            id: "user-001", onboarding_step: null, timezone: "America/New_York",
            linq_chat_id: "chat-abc", messaging_opted_out: false,
            reengagement_sent_at: null, strava_athlete_id: null,
            dashboard_token: null, // no token yet
          },
          error: null,
        },
      });

      const req = makeRequest("+12025551234", "my plan");
      await POST(req);
      const flushPromise = flush();
      await vi.advanceTimersByTimeAsync(15_000);
      await flushPromise;

      // Should NOT send the old dead-end message
      expect(sendSMS).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/isn't ready yet/i)
      );
      // Should fall through to coach/respond for plan generation
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("coach/respond"),
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips duplicate messages (same external_message_id)", async () => {
    mockTables({
      // Dedup check returns an existing message → early return
      conversations: { data: { id: "conv-001" }, error: null },
    });

    const req = makeRequest("+12025551234", "hello");
    await POST(req);
    await flush();

    // Only the dedup check should have run — no user lookup, no routing
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith("conversations");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
