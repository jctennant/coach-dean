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
