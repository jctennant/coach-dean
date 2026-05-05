import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("@/lib/linq", () => ({
  sendSMS: vi.fn().mockResolvedValue({ chatId: "chat-1" }),
}));

vi.mock("@/lib/stripe", () => ({
  getCheckoutPageUrl: vi.fn().mockReturnValue("https://coachdean.ai/checkout?token=abc"),
}));

vi.mock("@/lib/track", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({ data, init }),
  },
}));

import { GET } from "@/app/api/cron/trial-expiry/route";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";

type Row = Record<string, unknown>;

function mockTables(opts: {
  selectRows: Row[];
  updateError?: unknown;
  insertError?: unknown;
}) {
  const updates: Array<{ table: string; payload: Row; matchId?: string }> = [];

  const chain = (selectData: Row[]) => {
    const c: Record<string, unknown> = {};
    let lastId: string | undefined;
    let pendingUpdate: Row | null = null;
    c["select"] = vi.fn().mockReturnValue(c);
    c["update"] = vi.fn().mockImplementation((payload: Row) => {
      pendingUpdate = payload;
      return c;
    });
    c["insert"] = vi.fn().mockImplementation((payload: Row) => {
      updates.push({ table: "conversations", payload });
      return Promise.resolve({ data: null, error: opts.insertError ?? null });
    });
    c["eq"] = vi.fn().mockImplementation((col: string, val: string) => {
      if (col === "id") {
        lastId = val;
        if (pendingUpdate) {
          updates.push({ table: "users", payload: pendingUpdate, matchId: lastId });
          pendingUpdate = null;
        }
      }
      return c;
    });
    c["is"] = vi.fn().mockReturnValue(c);
    c["not"] = vi.fn().mockReturnValue(c);
    c["lte"] = vi.fn().mockReturnValue(c);
    c["then"] = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve({ data: selectData, error: null }).then(resolve, reject);
    return c;
  };

  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => chain(opts.selectRows));
  return { updates };
}

function req(authorized: boolean) {
  return {
    headers: {
      get: (h: string) =>
        h === "authorization" ? (authorized ? "Bearer test-secret" : null) : null,
    },
  } as unknown as Request;
}

describe("GET /api/cron/trial-expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-secret";
  });

  it("returns 401 without bearer token", async () => {
    mockTables({ selectRows: [] });
    const res = await GET(req(false));
    expect((res as { init: { status: number } }).init?.status).toBe(401);
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("returns sent=0 when no users match", async () => {
    mockTables({ selectRows: [] });
    const res = await GET(req(true));
    expect((res as { data: { sent: number } }).data.sent).toBe(0);
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("skips users whose subscription is already trialing or active", async () => {
    mockTables({
      selectRows: [
        { id: "u1", phone_number: "+1", name: "A", dashboard_token: "t1", subscription_status: "trialing" },
        { id: "u2", phone_number: "+2", name: "B", dashboard_token: "t2", subscription_status: "active" },
      ],
    });
    const res = await GET(req(true));
    expect((res as { data: { sent: number } }).data.sent).toBe(0);
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("sends SMS and gates eligible expired users", async () => {
    const { updates } = mockTables({
      selectRows: [
        { id: "u1", phone_number: "+15551110000", name: "Alice Runner", dashboard_token: "tok", subscription_status: null },
      ],
    });
    const res = await GET(req(true));
    expect((res as { data: { sent: number } }).data.sent).toBe(1);
    expect(sendSMS).toHaveBeenCalledOnce();
    const [phone, msg] = (sendSMS as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(phone).toBe("+15551110000");
    expect(msg).toContain("Alice");
    expect(msg).toContain("https://coachdean.ai/checkout");

    const userUpdate = updates.find((u) => u.table === "users" && u.matchId === "u1");
    expect(userUpdate).toBeDefined();
    expect(userUpdate!.payload.onboarding_step).toBe("awaiting_payment");
    expect(userUpdate!.payload.payment_link_sent_at).toBeDefined();
  });
});
