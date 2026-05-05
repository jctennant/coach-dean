import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRequest } from "../helpers/supabase-mock";

// ---------- module mocks ----------
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock("@/lib/linq", () => ({
  sendSMS: vi.fn().mockResolvedValue({ chatId: "chat-123" }),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({ data, init }),
  },
}));

// ---------- imports (after mocks) ----------
import { POST } from "@/app/api/signup/route";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";

function buildSupabaseMock(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  const defaults: Record<string, { data: unknown; error: unknown }> = {
    users_select: { data: null, error: null },       // existing user lookup → not found
    users_insert: { data: { id: "user-001" }, error: null }, // create user
    conversations_insert: { data: null, error: null },
    users_update: { data: null, error: null },
  };
  const resolved = { ...defaults, ...overrides };

  // We need to track call order since the same table is hit multiple times
  let usersCallCount = 0;
  const insertCapture: { lastUsersInsert: unknown } = { lastUsersInsert: null };

  const chain = (response: { data: unknown; error: unknown }) => {
    const c: Record<string, unknown> = {};
    const methods = ["select", "insert", "update", "eq", "is", "not", "order", "limit"];
    for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
    c["single"] = vi.fn().mockResolvedValue(response);
    c["maybeSingle"] = vi.fn().mockResolvedValue(response);
    return c;
  };

  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === "users") {
      usersCallCount++;
      if (usersCallCount === 1) return chain(resolved.users_select);
      const insertChain = chain(resolved.users_insert);
      (insertChain["insert"] as ReturnType<typeof vi.fn>).mockImplementation((payload: unknown) => {
        insertCapture.lastUsersInsert = payload;
        return insertChain;
      });
      return insertChain;
    }
    if (table === "conversations") return chain(resolved.conversations_insert);
    return chain({ data: null, error: null });
  });

  return insertCapture;
}

describe("POST /api/signup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid phone numbers", async () => {
    const res = await POST(mockRequest({ phone: "555-1234" }));
    expect((res as { data: { error: string } }).data.error).toMatch(/phone/i);
    expect((res as { init: { status: number } }).init?.status).toBe(400);
  });

  it("rejects non-US phone numbers", async () => {
    const res = await POST(mockRequest({ phone: "+441234567890" }));
    expect((res as { data: { error: string } }).data.error).toMatch(/phone/i);
    expect((res as { init: { status: number } }).init?.status).toBe(400);
  });

  it("rejects missing phone", async () => {
    const res = await POST(mockRequest({}));
    expect((res as { init: { status: number } }).init?.status).toBe(400);
  });

  it("returns 409 for duplicate phone number", async () => {
    buildSupabaseMock({
      users_select: { data: { id: "existing-user", onboarding_step: null }, error: null },
    });

    const res = await POST(mockRequest({ phone: "+12025551234" }));
    expect((res as { init: { status: number } }).init?.status).toBe(409);
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("creates user and sends welcome SMS for valid new phone", async () => {
    buildSupabaseMock();

    const res = await POST(mockRequest({ phone: "+12025551234" }));
    expect((res as { data: { ok: boolean } }).data.ok).toBe(true);
    expect(sendSMS).toHaveBeenCalledOnce();
    const [toPhone, message] = (sendSMS as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toPhone).toBe("+12025551234");
    expect(message).toContain("Coach Dean");
  });

  it("defaults reverse_trial_enabled to false when env var is unset", async () => {
    delete process.env.REVERSE_TRIAL_ENABLED;
    const capture = buildSupabaseMock();

    await POST(mockRequest({ phone: "+12025551234" }));
    const payload = capture.lastUsersInsert as Record<string, unknown>;
    expect(payload.reverse_trial_enabled).toBe(false);
    expect(payload.billing_enabled).toBeUndefined();
  });

  it("flips reverse_trial_enabled and billing_enabled on when env var is true", async () => {
    process.env.REVERSE_TRIAL_ENABLED = "true";
    const capture = buildSupabaseMock();

    await POST(mockRequest({ phone: "+12025551234" }));
    const payload = capture.lastUsersInsert as Record<string, unknown>;
    expect(payload.reverse_trial_enabled).toBe(true);
    expect(payload.billing_enabled).toBe(true);

    delete process.env.REVERSE_TRIAL_ENABLED;
  });

  it("returns 500 if user insert fails", async () => {
    buildSupabaseMock({
      users_insert: { data: null, error: { message: "DB error" } },
    });

    const res = await POST(mockRequest({ phone: "+12025551234" }));
    expect((res as { init: { status: number } }).init?.status).toBe(500);
    expect(sendSMS).not.toHaveBeenCalled();
  });
});
