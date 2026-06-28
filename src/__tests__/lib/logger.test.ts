import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "@/lib/logger";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

describe("createLogger — structured output", () => {
  let lines: string[] = [];

  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(s));
    vi.spyOn(console, "error").mockImplementation((s) => lines.push(s));
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastLine() {
    return JSON.parse(lines[lines.length - 1]);
  }

  it("emits valid JSON with required fields", () => {
    const log = createLogger({ agentName: "test-agent", correlationId: "abc-123", userId: "u1", trigger: "post_run" });
    log.info("hello world");
    const out = lastLine();
    expect(out.level).toBe("info");
    expect(out.message).toBe("hello world");
    expect(out.agentName).toBe("test-agent");
    expect(out.correlationId).toBe("abc-123");
    expect(out.userId).toBe("u1");
    expect(out.trigger).toBe("post_run");
    expect(typeof out.ts).toBe("string");
  });

  it("merges meta fields into the output", () => {
    const log = createLogger({ agentName: "a", correlationId: "b" });
    log.info("with meta", { durationMs: 123, model: "haiku" });
    const out = lastLine();
    expect(out.durationMs).toBe(123);
    expect(out.model).toBe("haiku");
  });

  it("suppresses debug logs when LOG_LEVEL=info", () => {
    process.env.LOG_LEVEL = "info";
    const log = createLogger({ agentName: "a", correlationId: "b" });
    log.debug("should be suppressed");
    expect(lines).toHaveLength(0);
  });

  it("emits debug logs when LOG_LEVEL=debug", () => {
    process.env.LOG_LEVEL = "debug";
    const log = createLogger({ agentName: "a", correlationId: "b" });
    log.debug("visible");
    expect(lines).toHaveLength(1);
    expect(lastLine().level).toBe("debug");
  });

  it("error level uses console.error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation((s) => lines.push(s));
    const log = createLogger({ agentName: "a", correlationId: "b" });
    log.error("something broke");
    const out = lastLine();
    expect(out.level).toBe("error");
    expect(errSpy).toHaveBeenCalled();
  });

  it("child logger inherits context and merges extras", () => {
    const parent = createLogger({ agentName: "parent", correlationId: "xyz" });
    const child = parent.child({ agentName: "child-agent", userId: "u2" });
    child.info("child message");
    const out = lastLine();
    expect(out.agentName).toBe("child-agent");
    expect(out.correlationId).toBe("xyz");
    expect(out.userId).toBe("u2");
  });

  it("suppresses warn when LOG_LEVEL=error", () => {
    process.env.LOG_LEVEL = "error";
    const log = createLogger({ agentName: "a", correlationId: "b" });
    log.warn("should be hidden");
    expect(lines).toHaveLength(0);
  });
});
