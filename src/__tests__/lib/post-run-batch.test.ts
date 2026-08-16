import { describe, it, expect, vi } from "vitest";
import {
  claimPostRunBatch,
  collectPostRunBatch,
  releasePostRunBatch,
  selectPrimaryActivity,
  BATCH_CLAIM_TTL_MS,
  BATCH_COLLECT_WINDOW_MS,
} from "@/lib/post-run-batch";

/**
 * A supabase chain that records the filters applied to it and resolves to a fixed response.
 * The claim's correctness lives in the shape of the query it issues (a conditional UPDATE
 * that Postgres serializes on the row), so asserting the filters is asserting the mechanism.
 */
function chain(response: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown[]> = {};
  const c: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return c;
  };
  for (const m of ["select", "update", "eq", "or", "is", "gte", "in", "order"]) c[m] = vi.fn(record(m));
  // Terminal await: supabase chains are thenable.
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(response).then(resolve);
  return { c, calls };
}

function client(response: { data: unknown; error: unknown }) {
  const { c, calls } = chain(response);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = { from: vi.fn().mockReturnValue(c) } as any;
  return { supabase, calls };
}

describe("claimPostRunBatch", () => {
  const NOW = new Date("2026-08-16T19:10:41Z");

  it("wins the batch when the conditional update matches a row", async () => {
    const { supabase } = client({ data: [{ user_id: "u1" }], error: null });
    expect(await claimPostRunBatch(supabase, "u1", NOW)).toBe(true);
  });

  it("loses the batch when the update matches nothing", async () => {
    // What a racing sibling sees: Postgres re-evaluated the WHERE against the value the
    // winner just committed, so the row no longer qualifies and zero rows come back. This
    // is the entire fix for the interleaved-message bug — the losing handler must not send.
    const { supabase } = client({ data: [], error: null });
    expect(await claimPostRunBatch(supabase, "u1", NOW)).toBe(false);
  });

  it("only claims rows that are unclaimed or past the TTL", async () => {
    const { supabase, calls } = client({ data: [{ user_id: "u1" }], error: null });
    await claimPostRunBatch(supabase, "u1", NOW);

    const staleBefore = new Date(NOW.getTime() - BATCH_CLAIM_TTL_MS).toISOString();
    expect(calls.or[0][0]).toBe(
      `post_run_batch_claimed_at.is.null,post_run_batch_claimed_at.lt.${staleBefore}`
    );
    expect(calls.update[0][0]).toEqual({ post_run_batch_claimed_at: NOW.toISOString() });
    expect(calls.eq[0]).toEqual(["user_id", "u1"]);
  });

  it("declines the claim when the update errors", async () => {
    // Assuming leadership on an errored claim would reintroduce concurrent sends, so a
    // failure has to resolve toward "someone else has it".
    const { supabase } = client({ data: null, error: { message: "connection reset" } });
    expect(await claimPostRunBatch(supabase, "u1", NOW)).toBe(false);
  });
});

describe("collectPostRunBatch", () => {
  const NOW = new Date("2026-08-16T19:10:41Z");
  const rows = [
    { strava_activity_id: 2, activity_type: "Swim", distance_meters: 720, moving_time_seconds: 960, start_date: "2026-08-16T07:52:55Z" },
    { strava_activity_id: 1, activity_type: "Walk", distance_meters: 1448, moving_time_seconds: 1080, start_date: "2026-08-15T08:42:39Z" },
  ];

  it("returns every uncoached activity inside the collection window", async () => {
    const { supabase, calls } = client({ data: rows, error: null });
    expect(await collectPostRunBatch(supabase, "u1", NOW)).toEqual(rows);

    expect(calls.is[0]).toEqual(["post_run_coached_at", null]);
    expect(calls.gte[0]).toEqual([
      "created_at",
      new Date(NOW.getTime() - BATCH_COLLECT_WINDOW_MS).toISOString(),
    ]);
  });

  it("marks the collected activities coached in the same pass", async () => {
    // Marking before generation rather than after is deliberate: the alternative leaves the
    // whole generation window open for a straggler webhook to collect the same rows and
    // produce the duplicate message this module exists to eliminate.
    const { supabase, calls } = client({ data: rows, error: null });
    await collectPostRunBatch(supabase, "u1", NOW);

    expect(calls.update[0][0]).toEqual({ post_run_coached_at: NOW.toISOString() });
    expect(calls.in[0]).toEqual(["strava_activity_id", [2, 1]]);
  });

  it("issues no update when nothing is awaiting coaching", async () => {
    const { supabase, calls } = client({ data: [], error: null });
    expect(await collectPostRunBatch(supabase, "u1", NOW)).toEqual([]);
    expect(calls.update).toBeUndefined();
  });

  it("returns empty rather than throwing when the query errors", async () => {
    const { supabase } = client({ data: null, error: { message: "timeout" } });
    expect(await collectPostRunBatch(supabase, "u1", NOW)).toEqual([]);
  });
});

describe("releasePostRunBatch", () => {
  it("clears the claim so the next upload can start a fresh batch", async () => {
    const { supabase, calls } = client({ data: null, error: null });
    await releasePostRunBatch(supabase, "u1");
    expect(calls.update[0][0]).toEqual({ post_run_batch_claimed_at: null });
    expect(calls.eq[0]).toEqual(["user_id", "u1"]);
  });
});

describe("selectPrimaryActivity", () => {
  const walk = { strava_activity_id: 1, activity_type: "Walk", distance_meters: 1448, moving_time_seconds: 1080, start_date: "2026-08-15T08:42:39Z" };
  const swim = { strava_activity_id: 2, activity_type: "Swim", distance_meters: 720, moving_time_seconds: 960, start_date: "2026-08-16T07:52:55Z" };

  it("picks the most recent activity regardless of input order", () => {
    expect(selectPrimaryActivity([walk, swim])?.strava_activity_id).toBe(2);
    expect(selectPrimaryActivity([swim, walk])?.strava_activity_id).toBe(2);
  });

  it("returns null for an empty batch", () => {
    expect(selectPrimaryActivity([])).toBeNull();
  });
});
