import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyIntent } from "@/lib/intent-classifier";

vi.mock("@/lib/anthropic", () => ({
  anthropic: {
    messages: {
      create: vi.fn(),
    },
  },
}));

import { anthropic } from "@/lib/anthropic";

const mockCreate = vi.mocked(anthropic.messages.create);

function makeResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("classifyIntent — happy paths", () => {
  it("returns injury_query with body part", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"intent":"injury_query","body_part":"knee","confidence":"high"}') as never);
    const result = await classifyIntent("my knee is really sore after yesterday's run", { activeInjury: false });
    expect(result.intent).toBe("injury_query");
    expect(result.bodyPart).toBe("knee");
    expect(result.confidence).toBe("high");
  });

  it("returns plan_question", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"intent":"plan_question","body_part":null,"confidence":"high"}') as never);
    const result = await classifyIntent("can we add a tempo run this week?", { activeInjury: false });
    expect(result.intent).toBe("plan_question");
    expect(result.bodyPart).toBeUndefined();
  });

  it("returns strava_query", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"intent":"strava_query","body_part":null,"confidence":"high"}') as never);
    const result = await classifyIntent("how many miles did I run last month?", { activeInjury: false });
    expect(result.intent).toBe("strava_query");
  });

  it("returns general for misc messages", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"intent":"general","body_part":null,"confidence":"high"}') as never);
    const result = await classifyIntent("thanks coach!", { activeInjury: false });
    expect(result.intent).toBe("general");
  });

  it("normalizes it_band body part", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"intent":"injury_query","body_part":"IT band","confidence":"high"}') as never);
    const result = await classifyIntent("IT band is flaring up", { activeInjury: false });
    expect(result.bodyPart).toBe("it_band");
  });
});

describe("classifyIntent — injury context fallback", () => {
  it("uses active injury context when body_part is null in response", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"intent":"injury_query","body_part":null,"confidence":"low"}') as never);
    const result = await classifyIntent("it hurts when I run", { activeInjury: true, bodyPart: "shin" });
    expect(result.bodyPart).toBe("shin");
  });

  it("does not apply injury context for non-injury intents", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"intent":"plan_question","body_part":null,"confidence":"high"}') as never);
    const result = await classifyIntent("what's my long run this week?", { activeInjury: true, bodyPart: "knee" });
    expect(result.bodyPart).toBeUndefined();
  });
});

describe("classifyIntent — error handling", () => {
  it("returns general fallback when Haiku call throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("rate limited") as never);
    const result = await classifyIntent("my ankle hurts", { activeInjury: false });
    expect(result.intent).toBe("general");
    expect(result.confidence).toBe("low");
  });

  it("returns general fallback when response is not valid JSON", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse("sorry, I cannot help with that") as never);
    const result = await classifyIntent("my shin hurts", { activeInjury: false });
    expect(result.intent).toBe("general");
    expect(result.confidence).toBe("low");
  });

  it("returns general for unrecognized intent value", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"intent":"unknown_type","body_part":null,"confidence":"high"}') as never);
    const result = await classifyIntent("something random", { activeInjury: false });
    expect(result.intent).toBe("general");
  });
});
