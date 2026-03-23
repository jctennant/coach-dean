import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRequest } from "../helpers/supabase-mock";

// ---------- Capture after() callbacks so tests can await background work ----------
const afterQueue: Array<() => Promise<void>> = [];

async function flush() {
  const cbs = afterQueue.splice(0);
  for (const fn of cbs) await fn();
}

// ---------- module mocks ----------
vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("@/lib/strava", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue("valid-token"),
  getActivity: vi.fn().mockResolvedValue({
    id: 999,
    type: "Run",
    distance: 8046.72,      // ~5 miles in meters
    moving_time: 2400,       // 40 min
    elapsed_time: 2500,
    average_heartrate: 155,
    max_heartrate: 175,
    average_cadence: 178,
    total_elevation_gain: 50,
    suffer_score: 42,
    start_date: "2026-03-23T13:00:00Z",
    splits_metric: [],
    laps: [],
    gear: null,
  }),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({ data, init }),
  },
  after: (fn: () => Promise<void>) => {
    afterQueue.push(fn);
  },
}));

// ---------- imports (after mocks) ----------
import { GET, POST } from "@/app/api/webhooks/strava/route";
import { supabase } from "@/lib/supabase";
import { getActivity } from "@/lib/strava";

// Helper: build a chainable supabase mock that returns different values per table
function chainWith(response: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  const methods = ["select", "insert", "update", "upsert", "delete", "eq", "neq", "in",
    "gte", "lte", "is", "not", "order", "limit"];
  for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
  c["single"] = vi.fn().mockResolvedValue(response);
  c["maybeSingle"] = vi.fn().mockResolvedValue(response);
  return c;
}

function mockUser(overrides = {}) {
  return { id: "user-001", phone_number: "+12025551234", onboarding_step: null, ...overrides };
}

function setupSupabase(opts: {
  user?: unknown;
  existingActivity?: unknown;
  manualDupes?: unknown[];
  nearDupes?: unknown[];
  recentPostRun?: unknown;
} = {}) {
  const calls: string[] = [];
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    calls.push(table);
    if (table === "users") {
      return chainWith({ data: opts.user ?? mockUser(), error: null });
    }
    if (table === "activities") {
      const existing = opts.existingActivity !== undefined ? opts.existingActivity : null;
      const chain = chainWith({ data: existing, error: null });
      // upsert resolves to success
      (chain["upsert"] as ReturnType<typeof vi.fn>).mockReturnValue(
        chainWith({ data: null, error: null })
      );
      // Override maybeSingle to simulate "not found" (new activity)
      (chain["maybeSingle"] as ReturnType<typeof vi.fn>).mockResolvedValue({ data: existing, error: null });
      return chain;
    }
    if (table === "conversations") {
      return chainWith({ data: opts.recentPostRun ?? null, error: null });
    }
    return chainWith({ data: null, error: null });
  });
  return calls;
}

describe("GET /api/webhooks/strava (subscription verification)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("responds to valid subscription challenge", async () => {
    process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = "my-secret-token";
    const req = {
      url: "http://localhost?hub.mode=subscribe&hub.verify_token=my-secret-token&hub.challenge=abc123",
    } as unknown as Request;

    const res = await GET(req);
    expect((res as { data: Record<string, string> }).data["hub.challenge"]).toBe("abc123");
  });

  it("rejects incorrect verify token", async () => {
    process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = "my-secret-token";
    const req = {
      url: "http://localhost?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123",
    } as unknown as Request;

    const res = await GET(req);
    expect((res as { init: { status: number } }).init?.status).toBe(403);
  });
});

describe("POST /api/webhooks/strava", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  });

  it("always returns 200 immediately (Strava 2-second requirement)", async () => {
    const req = mockRequest({ object_type: "athlete", aspect_type: "deauthorize", owner_id: 12345, object_id: 0 });
    const res = await POST(req);
    // Response comes back before after() work completes
    expect((res as { data: { ok: boolean } }).data.ok).toBe(true);
  });

  it("handles athlete deauthorize by clearing tokens", async () => {
    const updateChain = chainWith({ data: null, error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue(updateChain);

    const req = mockRequest({ object_type: "athlete", aspect_type: "deauthorize", owner_id: 12345, object_id: 0 });
    await POST(req);
    await flush();
    expect(supabase.from).toHaveBeenCalledWith("users");
  });

  it("ignores unknown event types without calling Strava API", async () => {
    const req = mockRequest({ object_type: "gear", aspect_type: "create", owner_id: 12345, object_id: 0 });
    await POST(req);
    await flush();
    expect(getActivity).not.toHaveBeenCalled();
  });

  it("skips coaching for unknown user", async () => {
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue(
      chainWith({ data: null, error: null })
    );

    const req = mockRequest({ object_type: "activity", aspect_type: "create", owner_id: 99999, object_id: 1 });
    await POST(req);
    await flush();
    expect(getActivity).not.toHaveBeenCalled();
  });

  it("skips coaching for users still in onboarding", async () => {
    setupSupabase({ user: mockUser({ onboarding_step: "awaiting_schedule" }) });

    const req = mockRequest({ object_type: "activity", aspect_type: "create", owner_id: 12345, object_id: 999 });
    await POST(req);
    await flush();

    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("coach/respond"),
      expect.anything()
    );
  });

  it("fires coaching response for new activity from onboarded user", async () => {
    setupSupabase({ existingActivity: null });

    const req = mockRequest({ object_type: "activity", aspect_type: "create", owner_id: 12345, object_id: 999 });
    await POST(req);
    await flush();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("coach/respond"),
      expect.objectContaining({ method: "POST" })
    );
  });
});
