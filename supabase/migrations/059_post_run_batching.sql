-- Post-run coalescing: when Strava bulk-syncs several activities at once (a phone coming
-- back online, a watch uploading a backlog), every activity fired its own coach/respond
-- invocation. Those invocations ran fully concurrently, so their SMS bubbles interleaved
-- and each one appended its own pain check-in poll — the athlete saw two half-messages
-- followed by two identical polls with no way to tell which referred to which activity.
--
-- The existing 10-minute suppression guard in webhooks/strava/route.ts was meant to prevent
-- exactly this, but it read `conversations` for a prior post_run row — and that row isn't
-- written until ~12s after the send, so two webhooks arriving in the same second both saw
-- an empty table and both proceeded. These two columns replace that read-then-act check
-- with a claim that's atomic at the database level.

-- Batch leader election. A concurrent UPDATE ... WHERE on the same row blocks until the
-- first transaction commits and then re-evaluates its WHERE clause against the new value,
-- so exactly one of N racing webhook handlers can transition this from NULL/stale to now().
-- The loser exits immediately; the winner debounces, then coaches every uncoached activity
-- as a single message. Stale claims (a handler that crashed mid-batch) expire via the TTL
-- the application applies in the WHERE clause, so a dead claim can never wedge an athlete.
--
-- No backfill needed: NULL correctly means "no batch in flight" for existing rows, which is
-- the same thing it means for new ones. There's no first-timer semantics attached to it.
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS post_run_batch_claimed_at timestamptz;

-- Per-activity "this has been coached" marker. Previously the only record that an activity
-- had been responded to was a conversations row carrying its strava_activity_id, which is
-- written late (after generation + send) and only ever for the one primary activity — there
-- was no way to mark the companions in a coalesced batch as handled. This column is set for
-- every activity in a batch at the moment the batch is claimed, so a straggler webhook that
-- arrives after collection can tell whether it was already covered.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS post_run_coached_at timestamptz;

-- BACKFILL (required — see CLAUDE.md "Backfill Rule for Behavioral Columns"). NULL on this
-- column means "never coached", so without this every activity already in the table would
-- read as awaiting a post-run message. The first batch to run for any athlete would collect
-- their entire history and try to coach all of it at once. Stamp existing rows with the time
-- we already know about them so they're all treated as settled.
UPDATE activities
SET post_run_coached_at = COALESCE(created_at, start_date)
WHERE post_run_coached_at IS NULL;

-- IANA zone the activity was actually recorded in, parsed from Strava's detailed activity
-- payload (which reports e.g. "(GMT-06:00) America/Denver"). Stored per-activity so a
-- relocation can be recognised from a run of agreeing activities rather than from a single
-- one — an athlete who races out of state shouldn't have their reminder schedule moved.
--
-- No backfill needed: NULL means "we didn't capture a zone for this activity", which is
-- true of every row predating this column and is handled by simply skipping those rows when
-- looking for agreement. It carries no first-timer semantics.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_timezone text;

-- Batch collection queries filter on (user_id, post_run_coached_at IS NULL) and are on the
-- hot path of every activity upload. Partial index so it only carries the handful of rows
-- actually awaiting coaching rather than the full activity history.
CREATE INDEX IF NOT EXISTS activities_uncoached_idx
  ON activities (user_id, created_at)
  WHERE post_run_coached_at IS NULL;
