-- 044_max_hr_estimate.sql
-- Persist the tiered max HR estimate (from estimateMaxHR) to training_profiles
-- so the coach, dashboard, and intensity-distribution analytics share one value
-- instead of recomputing independently (which can produce divergent zone labels).
--
-- Existing rows stay NULL; coach/respond and the Strava callback backfill lazily
-- the next time they recompute. No data backfill is needed because every call site
-- already has a recompute fallback.

ALTER TABLE training_profiles
  ADD COLUMN IF NOT EXISTS max_hr_estimate            INTEGER,
  ADD COLUMN IF NOT EXISTS max_hr_estimate_updated_at TIMESTAMPTZ;
