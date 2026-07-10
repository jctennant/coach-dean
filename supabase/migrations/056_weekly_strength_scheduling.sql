-- Deterministic (non-LLM) weekly strength scheduling.
-- weekly_strength_day: first day of the week (full day name, e.g. "Thursday") the athlete
--   is NOT scheduled to run, i.e. the complement of training_profiles.training_days. Null
--   when the athlete trains all 7 days (no day off to place a dedicated strength session on).
-- weekly_strength_routine_key: strength-library.ts routine key re-evaluated each week from
--   current injury_notes/injury_body_part via composeStrengthRoutine(). Null when there's no
--   injury signal and no default has been computed yet.
-- Computed alongside weekly_long_run_miles/weekly_quality_session at initial_plan and
-- weekly_recap time — deliberately NOT derived from Claude free-text (see 2026-04-16 changelog
-- entry on why day-level weekly_plan_sessions tracking was removed for AI-generated plans).
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS weekly_strength_day text;
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS weekly_strength_routine_key text;
