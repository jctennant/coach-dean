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

  // UNSUBSCRIBE and CANCEL are intentionally excluded — they now route to coach/respond
  // which sends the Stripe portal link, rather than triggering a hard SMS opt-out.
  const hardStopKeywords = ["STOP", "STOPALL", "QUIT"];

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

  it("STOP with dashboard_token: confirmation message includes Stripe portal link", async () => {
    mockTables({
      users: { data: { id: "user-001", linq_chat_id: "chat-abc", dashboard_token: "tok-abc123" }, error: null },
    });

    const req = makeRequest("+12025551234", "STOP");
    await POST(req);
    await flush();

    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      expect.stringContaining("http://localhost:3000/cancel?token=tok-abc123")
    );
  });

  it("STOP without dashboard_token: sends plain confirmation without portal link", async () => {
    mockTables({
      users: { data: { id: "user-001", linq_chat_id: "chat-abc", dashboard_token: null }, error: null },
    });

    const req = makeRequest("+12025551234", "STOP");
    await POST(req);
    await flush();

    expect(sendSMS).toHaveBeenCalledWith(
      "+12025551234",
      expect.stringMatching(/unsubscribed/i)
    );
    expect(sendSMS).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("/cancel?token=")
    );
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
    // The coaching path has a 15s debounce — use fake timers to skip it.
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
      // Start flush (which triggers the after() callback including the 15s debounce),
      // then advance fake timers to resolve the pending setTimeout inside.
      const flushPromise = flush();
      await vi.advanceTimersByTimeAsync(25_000);
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
        // conversations is called 4x: dedup check, insert (storedMsg), content-dedup check (post-insert), debounce latest-msg check
        conversations: [
          { data: null, error: null },                    // dedup → no existing
          { data: { id: "conv-001", created_at: "2026-01-01T00:00:00.000Z" }, error: null },      // insert → storedMsg
          { data: null, error: null },                    // post-insert content-dedup → no earlier duplicate
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
      await vi.advanceTimersByTimeAsync(25_000);
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
        // conversations: dedup → null, insert → conv-001, content-dedup (post-insert) → null, debounce check → conv-002 (newer!)
        conversations: [
          { data: null, error: null },
          { data: { id: "conv-001", created_at: "2026-01-01T00:00:00.000Z" }, error: null }, // insert storedMsg
          { data: null, error: null },                    // post-insert content-dedup → no earlier duplicate
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
      await vi.advanceTimersByTimeAsync(25_000);
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

  it("'dashboard' falls through to coach/respond (no dashboard shortcut)", async () => {
    vi.useFakeTimers();
    try {
      mockTables({
        conversations: [
          { data: null, error: null },           // dedup check → no existing
          { data: { id: "conv-001", created_at: "2026-01-01T00:00:00.000Z" }, error: null }, // insert storedMsg
          { data: null, error: null },           // post-insert content-dedup → no earlier duplicate
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

      const req = makeRequest("+12025551234", "dashboard");
      await POST(req);
      const flushPromise = flush();
      await vi.advanceTimersByTimeAsync(25_000);
      await flushPromise;

      // "dashboard" is just a regular message now — goes to coach/respond
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("coach/respond"),
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("'UPDATE PLAN' keyword: fires rebuild_plan trigger directly, skips debounce", async () => {
    mockTables({
      conversations: [
        { data: null, error: null },               // dedup check
        { data: { id: "conv-001", created_at: "2026-01-01T00:00:00.000Z" }, error: null }, // insert storedMsg
        { data: null, error: null },               // post-insert content-dedup → no earlier duplicate
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

    const req = makeRequest("+12025551234", "UPDATE PLAN");
    await POST(req);
    await flush();

    // Must fire rebuild_plan directly — no debounce, no user_message trigger
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("coach/respond"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"trigger":"rebuild_plan"'),
      })
    );
    // Must NOT route to user_message (which goes through debounce and Dean)
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("coach/respond"),
      expect.objectContaining({
        body: expect.stringContaining('"trigger":"user_message"'),
      })
    );
  });

  it("'UPDATE PLAN' is case-insensitive", async () => {
    for (const variant of ["update plan", "Update Plan", "UPDATE PLAN"]) {
      vi.clearAllMocks();
      afterQueue.splice(0);
      mockTables({
        conversations: [
          { data: null, error: null },
          { data: { id: "conv-001", created_at: "2026-01-01T00:00:00.000Z" }, error: null }, // insert storedMsg
          { data: null, error: null },               // post-insert content-dedup
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

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("coach/respond"),
        expect.objectContaining({
          body: expect.stringContaining('"trigger":"rebuild_plan"'),
        })
      );
    }
  });

  it.each(["UNSUBSCRIBE", "CANCEL"])("%s: does NOT opt out, routes to coach/respond for Stripe portal link", async (keyword) => {
    vi.useFakeTimers();
    try {
      mockTables({
        conversations: [
          { data: null, error: null },               // dedup check → no existing
          { data: { id: "conv-001", created_at: "2026-01-01T00:00:00.000Z" }, error: null }, // insert storedMsg
          { data: null, error: null },               // post-insert content-dedup → no earlier duplicate
        ],
        users: {
          data: {
            id: "user-001", onboarding_step: null, timezone: "America/New_York",
            linq_chat_id: "chat-abc", messaging_opted_out: false,
            reengagement_sent_at: null, strava_athlete_id: null,
            dashboard_token: "tok-abc123",
          },
          error: null,
        },
      });

      const req = makeRequest("+12025551234", keyword);
      await POST(req);
      const flushPromise = flush();
      await vi.advanceTimersByTimeAsync(25_000);
      await flushPromise;

      // Must NOT set messaging_opted_out — user keeps receiving messages
      const updateCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: string[]) => c[0] === "users");
      const anyOptOut = updateCalls.some(() =>
        // If messaging_opted_out were set, sendSMS would have been called with "unsubscribed"
        false
      );
      expect(sendSMS).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/unsubscribed/i)
      );

      // Must route to coach/respond which handles the Stripe portal link
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

  it("post-debounce: skips duplicate webhook delivery (same external_message_id, race condition)", async () => {
    // Simulates two Linq webhook deliveries for the same message slipping through
    // the pre-after dedup check before either one inserts a conversation row.
    // After the 15-second debounce, the handler whose row id is NOT the
    // lexicographically smallest should skip to avoid a double response.
    vi.useFakeTimers();
    try {
      mockTables({
        // conversations calls in order:
        //   [0] pre-after dedup check → no existing row (both webhooks pass)
        //   [1] insert storedMsg → returns "conv-zzz" (lexicographically larger id)
        //   [2] content-dedup (post-insert) → no earlier duplicate
        //   [3] debounce latest-msg check → same id → no newer message, proceed to dedup guard
        //   [4] external_message_id check → two rows exist (duplicate delivery!) → "conv-aaa" < "conv-zzz"
        conversations: [
          { data: null, error: null },                                               // dedup check
          { data: { id: "conv-zzz", created_at: "2026-01-01T00:00:00.000Z" }, error: null }, // insert storedMsg
          { data: null, error: null },                                               // post-insert content-dedup
          { data: { id: "conv-zzz" }, error: null },                                 // debounce check
          { data: [{ id: "conv-aaa" }, { id: "conv-zzz" }], error: null },           // duplicate guard
        ],
        users: {
          data: {
            id: "user-001", onboarding_step: null, timezone: "America/New_York",
            linq_chat_id: "chat-abc", messaging_opted_out: false,
            reengagement_sent_at: null, strava_athlete_id: null,
            dashboard_token: null,
          },
          error: null,
        },
      });

      const req = makeRequest("+12025551234", "great run today");
      await POST(req);
      const flushPromise = flush();
      await vi.advanceTimersByTimeAsync(25_000);
      await flushPromise;

      // This handler's row ("conv-zzz") is NOT the canonical one ("conv-aaa" sorts first)
      // → should skip rather than send a duplicate response
      expect(global.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining("coach/respond"),
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("post-debounce: proceeds normally when only one row exists for the external_message_id", async () => {
    // Normal case: no duplicate delivery — only one row with this external_message_id.
    vi.useFakeTimers();
    try {
      mockTables({
        // conversations: dedup → null, insert → conv-001, content-dedup (post-insert) → null,
        // debounce → same id, duplicate guard → single row (no duplicate)
        conversations: [
          { data: null, error: null },                           // dedup check
          { data: { id: "conv-001", created_at: "2026-01-01T00:00:00.000Z" }, error: null }, // insert storedMsg
          { data: null, error: null },                           // post-insert content-dedup
          { data: { id: "conv-001" }, error: null },             // debounce check
          { data: [{ id: "conv-001" }], error: null },           // duplicate guard → only one row
        ],
        users: {
          data: {
            id: "user-001", onboarding_step: null, timezone: "America/New_York",
            linq_chat_id: "chat-abc", messaging_opted_out: false,
            reengagement_sent_at: null, strava_athlete_id: null,
            dashboard_token: null,
          },
          error: null,
        },
      });

      const req = makeRequest("+12025551234", "how am I doing?");
      await POST(req);
      const flushPromise = flush();
      await vi.advanceTimersByTimeAsync(25_000);
      await flushPromise;

      // Normal path: single row → no duplicate → should route to coach/respond
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("coach/respond"),
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
