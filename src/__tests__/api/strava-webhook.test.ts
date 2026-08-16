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
    splits_standard: [],
    laps: [],
    gear: null,
  }),
}));

// The batch module has its own unit tests (post-run-batch.test.ts) covering claim atomicity
// and collection. Mock it here so these tests exercise the webhook's branching without
// sitting through the real 20s debounce.
const mockClaim = vi.fn().mockResolvedValue(true);
const mockCollect = vi.fn();
const mockRelease = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/post-run-batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/post-run-batch")>();
  return {
    ...actual,
    BATCH_DEBOUNCE_MS: 0,
    claimPostRunBatch: (...args: unknown[]) => mockClaim(...args),
    collectPostRunBatch: (...args: unknown[]) => mockCollect(...args),
    releasePostRunBatch: (...args: unknown[]) => mockRelease(...args),
  };
});

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
    mockClaim.mockResolvedValue(true);
    mockRelease.mockResolvedValue(undefined);
    // Default: this webhook's own activity is the only thing awaiting coaching.
    mockCollect.mockResolvedValue([
      { strava_activity_id: 999, activity_type: "Run", distance_meters: 8046.72, moving_time_seconds: 2400, start_date: "2026-03-23T13:00:00Z" },
    ]);
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

  it("fires post_run_onboarding coaching for new activity from user still in onboarding", async () => {
    setupSupabase({ user: mockUser({ onboarding_step: "onboarding" }), existingActivity: null });

    const req = mockRequest({ object_type: "activity", aspect_type: "create", owner_id: 12345, object_id: 999 });
    await POST(req);
    await flush();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("coach/respond"),
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.trigger).toBe("post_run_onboarding");
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
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.trigger).toBe("post_run");
    expect(body.activityId).toBe(999);
    expect(body.companionActivityIds).toEqual([]);
  });

  it("coalesces a bulk upload into one call carrying the companions", async () => {
    // The 2026-08-16 bug: two activities uploaded in the same second produced two concurrent
    // coach/respond invocations whose SMS bubbles and pain polls interleaved. The batch
    // leader now answers for the whole burst in a single call.
    setupSupabase({ existingActivity: null });
    mockCollect.mockResolvedValue([
      { strava_activity_id: 19771283402, activity_type: "Swim", distance_meters: 720, moving_time_seconds: 960, start_date: "2026-08-16T07:52:55Z" },
      { strava_activity_id: 19771283481, activity_type: "Walk", distance_meters: 1448, moving_time_seconds: 1080, start_date: "2026-08-15T08:42:39Z" },
    ]);

    const req = mockRequest({ object_type: "activity", aspect_type: "create", owner_id: 12345, object_id: 999 });
    await POST(req);
    await flush();

    const coachCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes("coach/respond")
    );
    expect(coachCalls).toHaveLength(1);
    const body = JSON.parse(coachCalls[0][1].body);
    // Most recent activity drives the analysis; the older one rides along as context.
    expect(body.activityId).toBe(19771283402);
    expect(body.companionActivityIds).toEqual([19771283481]);
  });

  it("does not fire coaching when another handler already owns the batch", async () => {
    // The losing side of a concurrent burst. Its activity row is already stored and
    // uncoached, so the leader's collection pass covers it — firing here is exactly the
    // duplicate the claim exists to prevent.
    setupSupabase({ existingActivity: null });
    mockClaim.mockResolvedValue(false);

    const req = mockRequest({ object_type: "activity", aspect_type: "create", owner_id: 12345, object_id: 999 });
    await POST(req);
    await flush();

    const coachCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes("coach/respond")
    );
    expect(coachCalls).toHaveLength(0);
    expect(mockCollect).not.toHaveBeenCalled();
  });

  it("releases the batch claim even when coach/respond throws", async () => {
    // A stuck claim would suppress this athlete's post-run messages until the TTL expired.
    setupSupabase({ existingActivity: null });
    global.fetch = vi.fn().mockRejectedValue(new Error("coach/respond exploded"));

    const req = mockRequest({ object_type: "activity", aspect_type: "create", owner_id: 12345, object_id: 999 });
    await POST(req);
    await flush();

    expect(mockRelease).toHaveBeenCalledWith(expect.anything(), "user-001");
  });

  it("still fires immediately, unbatched, for users mid-onboarding", async () => {
    setupSupabase({ user: mockUser({ onboarding_step: "onboarding" }), existingActivity: null });

    const req = mockRequest({ object_type: "activity", aspect_type: "create", owner_id: 12345, object_id: 999 });
    await POST(req);
    await flush();

    expect(mockClaim).not.toHaveBeenCalled();
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.trigger).toBe("post_run_onboarding");
  });
});
