import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRequest } from "../helpers/supabase-mock";

// ---------- Capture after() callbacks ----------
const afterQueue: Array<() => Promise<void>> = [];
async function flush() {
  const cbs = afterQueue.splice(0);
  for (const fn of cbs) await fn();
}

// ---------- module mocks ----------
vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/lib/anthropic", () => ({
  anthropic: {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Easy run today!" }],
      }),
    },
  },
}));
vi.mock("@/lib/linq", () => ({
  sendSMS: vi.fn().mockResolvedValue({ chatId: null }),
  startTyping: vi.fn().mockResolvedValue(undefined),
  typingDurationMs: vi.fn().mockReturnValue(0),
}));
vi.mock("@/lib/track", () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/weather", () => ({
  fetchWeekWeather: vi.fn().mockResolvedValue(null),
  buildWeatherBlock: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/training-plan", () => ({
  generateAndSaveFullPlan: vi.fn().mockResolvedValue("new-token-abc"),
  computePhaseForPlan: vi.fn().mockReturnValue("base"),
  computeRacePreparedness: vi.fn().mockReturnValue({ flag: null }),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({ data, init }),
  },
  after: (fn: () => Promise<void>) => {
    afterQueue.push(fn);
  },
}));

import { POST } from "@/app/api/coach/respond/route";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

// ---------- helpers ----------
function makeChain(response: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "update", "upsert", "delete",
    "eq", "neq", "is", "not", "gte", "lte", "in", "or", "order", "limit",
  ];
  for (const m of methods) chain[m] = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(response);
  chain.maybeSingle = vi.fn().mockResolvedValue(response);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject);
  return chain;
}

function setupSupabase(opts: {
  user?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  state?: Record<string, unknown>;
  races?: Array<Record<string, unknown>>;
  conversations?: Array<Record<string, unknown>>;
  planWeeks?: Array<Record<string, unknown>>;
}) {
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === "users") return makeChain({ data: opts.user ?? null, error: null });
    if (table === "training_profiles") return makeChain({ data: opts.profile ?? null, error: null });
    if (table === "training_state") return makeChain({ data: opts.state ?? null, error: null });
    if (table === "races") return makeChain({ data: opts.races ?? null, error: null });
    if (table === "conversations") return makeChain({ data: opts.conversations ?? null, error: null });
    if (table === "training_plans") return makeChain({
      data: opts.planWeeks ? { weeks: opts.planWeeks, id: "plan-001" } : null,
      error: null,
    });
    return makeChain({ data: null, error: null });
  });
}

function daysFromNow(n: number): string {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function baseUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "user-001",
    phone_number: "+12025550001",
    strava_athlete_id: null,
    onboarding_step: null,
    linq_chat_id: "chat-001",
    timezone: "America/New_York",
    messaging_opted_out: false,
    onboarding_data: { weekly_miles: 30 },
    ...overrides,
  };
}

function baseProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: "half_marathon",
    race_date: null,
    injury_notes: null,
    preferred_units: "imperial",
    current_easy_pace: null,
    current_tempo_pace: null,
    current_interval_pace: null,
    current_vdot: null,
    days_per_week: 4,
    ...overrides,
  };
}

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    current_week: 3,
    current_phase: "base",
    weekly_mileage_target: 30,
    weekly_plan_sessions: null,
    taper_peak_miles: null,
    plan_adjustments: null,
    last_activity_summary: null,
    last_activity_date: null,
    ...overrides,
  };
}

function captureSystemPrompt(): string {
  const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
  return (calls[0]?.[0]?.system as string) ?? "";
}

function captureUserMessage(): string {
  const calls = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls;
  const messages = calls[0]?.[0]?.messages as Array<{ role: string; content: string }> | undefined;
  return messages?.[0]?.content ?? "";
}

// ---------- tests ----------

describe("coach/respond — metric unit conversion in prompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.splice(0);
  });

  describe("fitness tier volume caps", () => {
    it("shows km values for metric user in LOW VOLUME tier", async () => {
      setupSupabase({
        user: baseUser({ onboarding_data: { weekly_miles: 5 } }),
        profile: baseProfile({ preferred_units: "metric" }),
        state: baseState({ weekly_mileage_target: 8 }),
      });

      const req = mockRequest({ userId: "user-001", trigger: "user_message" });
      await POST(req);
      await flush();

      const prompt = captureSystemPrompt();
      expect(prompt).toContain("km");
      expect(prompt).not.toMatch(/FITNESS TIER.*\bmi\b/);
      expect(prompt).not.toMatch(/VOLUME CAP.*\bmi\b/);
      // 5 mi/week × 1.3 = 6.5, floor 6 → 6.0 mi = 9.7 km
      expect(prompt).toContain("9.7 km");
    });

    it("shows mi values for imperial user in LOW VOLUME tier", async () => {
      setupSupabase({
        user: baseUser({ onboarding_data: { weekly_miles: 5 } }),
        profile: baseProfile({ preferred_units: "imperial" }),
        state: baseState({ weekly_mileage_target: 8 }),
      });

      const req = mockRequest({ userId: "user-001", trigger: "user_message" });
      await POST(req);
      await flush();

      const prompt = captureSystemPrompt();
      expect(prompt).toMatch(/VOLUME CAP.*5\.0 mi/);
    });

    it("shows km values for metric user in MODERATE VOLUME tier", async () => {
      setupSupabase({
        user: baseUser({ onboarding_data: { weekly_miles: 20 } }),
        profile: baseProfile({ preferred_units: "metric" }),
        state: baseState({ weekly_mileage_target: 32 }),
      });

      const req = mockRequest({ userId: "user-001", trigger: "user_message" });
      await POST(req);
      await flush();

      const prompt = captureSystemPrompt();
      // 20 mi = 32.2 km
      expect(prompt).toContain("32.2 km");
      expect(prompt).not.toMatch(/MODERATE VOLUME.*\bmi\b/);
    });
  });

  describe("taper protocol", () => {
    it("shows km values in taper block for metric user (race ≤21 days)", async () => {
      setupSupabase({
        user: baseUser({ onboarding_data: { weekly_miles: 30 } }),
        profile: baseProfile({
          preferred_units: "metric",
          race_date: daysFromNow(10),
        }),
        state: baseState({ taper_peak_miles: 30 }),
      });

      const req = mockRequest({ userId: "user-001", trigger: "user_message" });
      await POST(req);
      await flush();

      const prompt = captureSystemPrompt();
      expect(prompt).toContain("TAPER PROTOCOL");
      expect(prompt).toContain("km");
      // Should not contain bare "mi" in the taper line
      expect(prompt).not.toMatch(/TAPER PROTOCOL[^]*?mi(?:les)?[^]*?Race week/);
    });

    it("shows mi values in taper block for imperial user", async () => {
      setupSupabase({
        user: baseUser({ onboarding_data: { weekly_miles: 30 } }),
        profile: baseProfile({
          preferred_units: "imperial",
          race_date: daysFromNow(10),
        }),
        state: baseState({ taper_peak_miles: 30 }),
      });

      const req = mockRequest({ userId: "user-001", trigger: "user_message" });
      await POST(req);
      await flush();

      const prompt = captureSystemPrompt();
      expect(prompt).toContain("TAPER PROTOCOL");
      expect(prompt).toMatch(/Peak volume ~30\.0 mi/);
    });
  });

  describe("user_message — full arc and next-week context", () => {
    const planWeeks = [
      { week_number: 3, phase: "base", mileage_target: 30, long_run_target: 10, key_workout: "6×400m @ 5K pace", notes: "Build week." },
      { week_number: 4, phase: "base", mileage_target: 33, long_run_target: 11, key_workout: "tempo run", notes: "Build week." },
    ];

    it("shows km in full arc context for metric user", async () => {
      setupSupabase({
        user: baseUser(),
        profile: baseProfile({ preferred_units: "metric" }),
        state: baseState({ current_week: 3 }),
        planWeeks,
      });

      const req = mockRequest({ userId: "user-001", trigger: "user_message" });
      await POST(req);
      await flush();

      const message = captureUserMessage();
      // 30 mi = 48.3 km — verify km appears in the arc data
      expect(message).toContain("48.3 km");
      // The arc data lines should use km, not mi (check the actual week lines)
      const arcMatch = message.match(/Week \d+ \([^)]+\): ([^\n]+)/g);
      expect(arcMatch).toBeTruthy();
      arcMatch!.forEach(line => {
        expect(line).not.toMatch(/\d+\.\d+ mi\b/);
      });
    });

    it("shows mi in full arc context for imperial user", async () => {
      setupSupabase({
        user: baseUser(),
        profile: baseProfile({ preferred_units: "imperial" }),
        state: baseState({ current_week: 3 }),
        planWeeks,
      });

      const req = mockRequest({ userId: "user-001", trigger: "user_message" });
      await POST(req);
      await flush();

      const message = captureUserMessage();
      expect(message).toContain("30.0 mi");
    });
  });
});
