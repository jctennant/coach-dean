import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, parseRetryAfterMs } from "@/lib/anthropic";

/** Build an HTTP-error-shaped object like the AI SDKs throw. */
function httpErr(status: number, headers?: Record<string, string>) {
  return Object.assign(new Error(`HTTP ${status}`), { status, headers });
}

describe("withRetry — delayed retry on rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // deterministic jitter
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.AI_MAX_RETRIES;
    delete process.env.AI_MAX_RETRY_WAIT_MS;
  });

  it("retries on 429 then returns the eventual success", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(httpErr(429))
      .mockResolvedValueOnce("ok");
    const p = withRetry(fn);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a non-retryable status (400)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpErr(400));
    await expect(withRetry(fn)).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after AI_MAX_RETRIES attempts and rethrows", async () => {
    process.env.AI_MAX_RETRIES = "3";
    const fn = vi.fn().mockRejectedValue(httpErr(429));
    const p = withRetry(fn);
    const assertion = expect(p).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once the total-wait budget would be exceeded", async () => {
    process.env.AI_MAX_RETRIES = "10";
    process.env.AI_MAX_RETRY_WAIT_MS = "1500"; // only the first ~1s backoff fits
    const fn = vi.fn().mockRejectedValue(httpErr(429));
    const p = withRetry(fn);
    const assertion = expect(p).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    // attempt 0 fails → wait 1000ms (fits); attempt 1 fails → next wait 2000ms exceeds
    // the 1500ms budget → rethrow. So fn ran twice.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("parseRetryAfterMs", () => {
  const err = (headers: Record<string, string>) => Object.assign(new Error("x"), { status: 429, headers });

  it("reads retry-after-ms (milliseconds)", () => {
    expect(parseRetryAfterMs(err({ "retry-after-ms": "1500" }))).toBe(1500);
  });
  it("reads retry-after (seconds)", () => {
    expect(parseRetryAfterMs(err({ "retry-after": "12" }))).toBe(12_000);
  });
  it("returns null when no retry-after header is present", () => {
    expect(parseRetryAfterMs(err({}))).toBeNull();
    expect(parseRetryAfterMs(new Error("no headers"))).toBeNull();
  });
  it("supports a Headers-like object with a .get() method", () => {
    const headers = { get: (k: string) => (k === "retry-after" ? "3" : null) };
    expect(parseRetryAfterMs(Object.assign(new Error("x"), { status: 429, headers }))).toBe(3_000);
  });
});
