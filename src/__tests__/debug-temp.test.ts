import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/lib/linq", () => ({ sendSMS: vi.fn().mockResolvedValue({ chatId: "chat-123" }), startTyping: vi.fn(), shareContactCard: vi.fn() }));
vi.mock("@/lib/anthropic", () => ({ anthropic: { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: '{"complete":false,"no_event":false,"goal":null}' }] }) } } }));
vi.mock("@/lib/track", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/paces", () => ({ calculateVDOTPaces: vi.fn(), estimatePacesFromEasyPace: vi.fn() }));
vi.mock("next/server", () => ({ NextResponse: { json: (d: unknown) => ({ data: d }) }, after: (fn: () => Promise<void>) => { void fn(); } }));

import { POST } from "@/app/api/onboarding/handle/route";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

function chain(response: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  const methods = ["select", "insert", "update", "upsert", "delete", "eq", "neq", "is", "not", "gte", "lte", "in", "or", "order", "limit"];
  for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
  c["single"] = vi.fn().mockResolvedValue(response);
  c["maybeSingle"] = vi.fn().mockResolvedValue(response);
  c["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(response).then(resolve, reject);
  return c;
}

const ON_TOPIC = { content: [{ type: "text", text: '{"on_topic": true}' }] };
const ACK_NULL = { content: [{ type: "text", text: "null" }] };

function otherRacesResponse(overrides: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text: JSON.stringify({ confirmed_a_race_date: null, other_races: [], new_a_race: null, ...overrides }) }] };
}

describe("debug handleOtherRaces", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("debug: prints update args", async () => {
    vi.mocked(anthropic.messages.create)
      .mockResolvedValueOnce(ON_TOPIC)
      .mockResolvedValueOnce(otherRacesResponse({ confirmed_a_race_date: "2026-06-14", other_races: [{ date: "2026-08-08", name: "Sierre Zinal 31k", goal: "30k", priority: "B" }] }))
      .mockResolvedValueOnce(ACK_NULL);

    const usersChain = chain({
      data: {
        id: "user-001", phone_number: "+12025551234", name: "Jake",
        onboarding_step: "awaiting_other_races",
        onboarding_data: { goal: "10k", race_name: "Dipsea", goal_distance_miles: 7.4, race_date: "2026-06-14", secondary_goal: "Sierre Zinal 31k in August", intro_sent: true, name: "Jake" },
      },
      error: null,
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "users") return usersChain;
      return chain({ data: null, error: null });
    });

    await POST({ json: () => Promise.resolve({ userId: "user-001", message: "Yes! Dipsea June 14, Sierre Zinal August 8" }) } as unknown as Request);

    const updateCalls = (usersChain.update as ReturnType<typeof vi.fn>).mock.calls;
    const stepUpdate = updateCalls.find(([p]: [Record<string, unknown>]) => "onboarding_step" in p);

    // Write to file so we can inspect it
    require("fs").writeFileSync("/tmp/vitest-debug.json", JSON.stringify({
      callCount: updateCalls.length,
      calls: updateCalls.map((c: unknown[]) => c[0]),
      stepUpdate: stepUpdate ? stepUpdate[0] : null,
    }, null, 2));

    expect(true).toBe(true);
  });
});
