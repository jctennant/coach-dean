import { describe, it, expect, vi, beforeEach } from "vitest";

const afterQueue: Array<() => Promise<void>> = [];
vi.mock("next/server", () => ({
  after: (fn: () => Promise<void>) => {
    afterQueue.push(fn);
  },
}));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException }));

import { runAfter } from "@/lib/safe-after";

async function flushAfterQueue() {
  while (afterQueue.length > 0) {
    await afterQueue.shift()!();
  }
}

describe("runAfter", () => {
  beforeEach(() => {
    afterQueue.length = 0;
    captureException.mockClear();
  });

  it("runs the wrapped function", async () => {
    const fn = vi.fn(async () => {});
    runAfter("test-label", fn);
    await flushAfterQueue();
    expect(fn).toHaveBeenCalledOnce();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("catches a thrown error and reports it to Sentry with the label", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    runAfter("test-label", async () => {
      throw boom;
    });
    // The wrapped fn must not reject through the after() boundary.
    await expect(flushAfterQueue()).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledWith(boom, {
      tags: { after_label: "test-label" },
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("merges extra tags into the Sentry report", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    runAfter(
      "test-label",
      async () => {
        throw new Error("boom");
      },
      { trigger: "weekly_recap" }
    );
    await flushAfterQueue();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { after_label: "test-label", trigger: "weekly_recap" },
    });
    consoleError.mockRestore();
  });
});
