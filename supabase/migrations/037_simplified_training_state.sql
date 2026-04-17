-- Simplified weekly plan: replace day-level session tracking with week-level targets.
-- The coach now prescribes a weekly target + long run + quality session, rather than
-- assigning sessions to specific days. This removes day-assignment errors and the
-- entire [SESSION_LIST] extraction / sync_sessions machinery.

ALTER TABLE training_state
  ADD COLUMN IF NOT EXISTS weekly_long_run_miles numeric,
  ADD COLUMN IF NOT EXISTS weekly_quality_session text;

-- Backfill from existing arc data so current users see the right context immediately.
UPDATE training_state ts
SET
  weekly_long_run_miles = (
    SELECT (w->>'long_run_target')::numeric
    FROM training_plans tp,
    jsonb_array_elements(tp.weeks::jsonb) AS w
    WHERE tp.user_id = ts.user_id
      AND (w->>'week_number')::int = COALESCE(ts.current_week, 1)
    ORDER BY tp.created_at DESC
    LIMIT 1
  ),
  weekly_quality_session = (
    SELECT w->>'key_workout'
    FROM training_plans tp,
    jsonb_array_elements(tp.weeks::jsonb) AS w
    WHERE tp.user_id = ts.user_id
      AND (w->>'week_number')::int = COALESCE(ts.current_week, 1)
    ORDER BY tp.created_at DESC
    LIMIT 1
  )
WHERE ts.weekly_long_run_miles IS NULL;
