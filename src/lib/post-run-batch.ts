/**
 * Post-run batch coalescing.
 *
 * Strava fires one webhook per activity. When a phone syncs a backlog, several arrive in
 * the same second, and before this module each one ran its own fully concurrent
 * coach/respond invocation — the athlete's SMS thread interleaved two half-messages and
 * then two identical pain check-in polls, with nothing tying either poll to the activity
 * it was asking about (observed 2026-08-16 and again in the 2026-08-09 backfill).
 *
 * webhooks/strava/route.ts already tried to prevent this by reading `conversations` for a
 * recent post_run row, but that's a read-then-act check against a row written ~12s later,
 * so racing handlers all read an empty table. The fix is to make the check a write:
 * `claimPostRunBatch` is a conditional UPDATE, which Postgres serializes on the row, so
 * exactly one handler can win regardless of how many arrive together.
 *
 * The winner then waits out the burst and coaches everything as one message; the losers
 * exit immediately, having already stored their activity row for the winner to pick up.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How long the leader waits after claiming before collecting the batch. The bursts this
 * exists for arrive within the same second (Strava pushes a bulk sync as a rapid series of
 * webhooks), so this only has to outlast the webhook fan-out, not a human's upload habits.
 * Anything arriving later than this is a genuinely separate upload and deserves its own
 * message rather than being retroactively folded into one already being written.
 */
export const BATCH_DEBOUNCE_MS = 20_000;

/**
 * Lifetime of a claim. A handler that dies mid-batch (OOM, deploy mid-flight) would
 * otherwise leave the column set forever and suppress every future post-run message for
 * that athlete. Any claim older than this is treated as abandoned and can be taken over.
 * Comfortably longer than debounce + generation + send, so it can't expire under a leader
 * that's merely slow.
 */
export const BATCH_CLAIM_TTL_MS = 5 * 60_000;

/**
 * How far back collection looks for uncoached activities. Bounds the blast radius if the
 * backfill in migration 059 ever missed rows, or if an activity was stored while no claim
 * could be made: a stale uncoached row from last month can never be swept into today's
 * message and presented as if the athlete just did it.
 */
export const BATCH_COLLECT_WINDOW_MS = 30 * 60_000;

export interface BatchActivity {
  strava_activity_id: number;
  activity_type: string | null;
  distance_meters: number | null;
  moving_time_seconds: number | null;
  start_date: string;
}

/**
 * Try to become the batch leader for this athlete.
 *
 * Atomic by virtue of being a single conditional UPDATE: when two handlers race, the second
 * blocks on the row lock, and on unblocking Postgres re-checks the WHERE clause against the
 * committed value (EvalPlanQual) — it sees the fresh timestamp, matches nothing, and reports
 * zero rows. That "zero rows updated" is the signal that someone else owns the batch.
 *
 * Returns false rather than throwing on error: failing to claim is always the safe
 * direction, because the alternative (assuming leadership on an errored claim) reintroduces
 * exactly the concurrent-send bug this exists to prevent.
 */
export async function claimPostRunBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - BATCH_CLAIM_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from("training_state")
    .update({ post_run_batch_claimed_at: now.toISOString() })
    .eq("user_id", userId)
    .or(`post_run_batch_claimed_at.is.null,post_run_batch_claimed_at.lt.${staleBefore}`)
    .select("user_id");

  if (error) {
    console.error(`[post-run-batch] claim failed for user ${userId}:`, error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Release the claim so the next upload can start a fresh batch immediately. Best-effort —
 * if this fails the claim simply expires via BATCH_CLAIM_TTL_MS instead, which delays the
 * athlete's next post-run message but never loses it.
 */
export async function releasePostRunBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from("training_state")
    .update({ post_run_batch_claimed_at: null })
    .eq("user_id", userId);
  if (error) console.error(`[post-run-batch] release failed for user ${userId}:`, error.message);
}

/**
 * Collect every activity still awaiting a post-run message, newest first, and mark them
 * coached in the same pass.
 *
 * Marking happens here — before generation, not after a successful send — deliberately. The
 * two failure modes are "an activity gets no message" and "an activity gets two messages",
 * and this codebase consistently prefers the former (see the layered dedup guards already in
 * webhooks/strava/route.ts). Marking after the send would leave the whole generation window
 * open for a straggler webhook to collect the same rows again and produce the exact
 * duplicate-message pair this module exists to eliminate.
 */
export async function collectPostRunBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  now: Date = new Date(),
): Promise<BatchActivity[]> {
  const since = new Date(now.getTime() - BATCH_COLLECT_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("activities")
    .select("strava_activity_id, activity_type, distance_meters, moving_time_seconds, start_date")
    .eq("user_id", userId)
    .is("post_run_coached_at", null)
    .gte("created_at", since)
    .order("start_date", { ascending: false });

  if (error) {
    console.error(`[post-run-batch] collect failed for user ${userId}:`, error.message);
    return [];
  }
  const activities = (data ?? []) as BatchActivity[];
  if (activities.length === 0) return [];

  const { error: markErr } = await supabase
    .from("activities")
    .update({ post_run_coached_at: now.toISOString() })
    .in("strava_activity_id", activities.map((a) => a.strava_activity_id));
  if (markErr) console.error(`[post-run-batch] mark-coached failed for user ${userId}:`, markErr.message);

  return activities;
}

/**
 * Pick which activity of a batch drives the coaching message.
 *
 * The most recent one by start time, which is both the one the athlete most likely just
 * finished and the one whose detailed splits/HR are most worth analysing. The rest ride
 * along as companions: named in the deterministic line 1 and summarised for the prompt, but
 * not given the full per-split treatment, since a message that analyses three sessions in
 * depth is longer than anyone reads over SMS.
 */
export function selectPrimaryActivity(activities: BatchActivity[]): BatchActivity | null {
  if (activities.length === 0) return null;
  return activities.reduce((best, a) =>
    new Date(a.start_date).getTime() > new Date(best.start_date).getTime() ? a : best
  );
}
