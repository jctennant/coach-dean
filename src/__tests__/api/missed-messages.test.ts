import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------- module mocks (must be before imports) ----------
vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("@/lib/track", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/admin-restrict", () => ({
  getRestrictedPhones: vi.fn().mockReturnValue(null),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({ data, init }),
  },
}));

// ---------- imports (after mocks) ----------
import { GET } from "@/app/api/cron/missed-messages/route";
import { supabase } from "@/lib/supabase";

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

function cronRequest() {
  return {
    headers: { get: (k: string) => (k === "authorization" ? "Bearer test-secret" : null) },
  } as unknown as Request;
}

const TEN_MIN_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();

describe("GET /api/cron/missed-messages — stranded-athlete recovery", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://coachdean.ai";
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("re-dispatches a stranded onboarding user to onboarding/handle with retry:true", async () => {
    // The failure shape this recovers: a stage handler stored the inbound row, then threw
    // before sending anything. Previously the cron filtered onboarding users out entirely,
    // so the only backstop was the reengagement cron two days later.
    mockTables({
      conversations: [
        {
          data: [{ user_id: "user-001", created_at: TEN_MIN_AGO, content: "it's a dull ache along the bone" }],
          error: null,
        },
        { data: null, error: null }, // reply check — no assistant reply
      ],
      users: {
        data: [
          {
            id: "user-001",
            phone_number: "+12025551234",
            onboarding_step: "onboarding",
            messaging_opted_out: false,
            linq_chat_id: "chat-9",
          },
        ],
        error: null,
      },
    });

    const res = (await GET(cronRequest())) as unknown as { data: { retried: number } };

    expect(res.data.retried).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://coachdean.ai/api/onboarding/handle");
    expect(JSON.parse(init.body)).toEqual({
      userId: "user-001",
      message: "it's a dull ache along the bone",
      retry: true,
      chatId: "chat-9",
    });
  });

  it("still routes fully-onboarded users to coach/respond", async () => {
    mockTables({
      conversations: [
        { data: [{ user_id: "user-002", created_at: TEN_MIN_AGO, content: "ran 6 today" }], error: null },
        { data: null, error: null },
      ],
      users: {
        data: [
          {
            id: "user-002",
            phone_number: "+12025559999",
            onboarding_step: null,
            messaging_opted_out: false,
            linq_chat_id: null,
          },
        ],
        error: null,
      },
    });

    await GET(cronRequest());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://coachdean.ai/api/coach/respond");
    expect(JSON.parse(init.body)).toEqual({ userId: "user-002", trigger: "user_message" });
  });

  it("skips awaiting_payment — its handler only re-sends a link the athlete already ignored", async () => {
    mockTables({
      conversations: [
        { data: [{ user_id: "user-003", created_at: TEN_MIN_AGO, content: "hmm" }], error: null },
        { data: null, error: null },
      ],
      users: {
        data: [
          {
            id: "user-003",
            phone_number: "+12025558888",
            onboarding_step: "awaiting_payment",
            messaging_opted_out: false,
            linq_chat_id: null,
          },
        ],
        error: null,
      },
    });

    const res = (await GET(cronRequest())) as unknown as { data: { retried: number } };

    expect(res.data.retried).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not re-dispatch when an assistant reply already landed", async () => {
    mockTables({
      conversations: [
        { data: [{ user_id: "user-004", created_at: TEN_MIN_AGO, content: "shin is sore" }], error: null },
        { data: { id: "a1" }, error: null }, // reply exists
      ],
      users: {
        data: [
          {
            id: "user-004",
            phone_number: "+12025557777",
            onboarding_step: "onboarding",
            messaging_opted_out: false,
            linq_chat_id: null,
          },
        ],
        error: null,
      },
    });

    const res = (await GET(cronRequest())) as unknown as { data: { retried: number } };

    expect(res.data.retried).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
