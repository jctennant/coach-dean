-- 038_lthr_fields.sql
-- Add LTHR (Lactate Threshold Heart Rate) fields to training_profiles.
-- LTHR anchors Z1-Z5 zones to individual physiology rather than % of max HR estimates.

ALTER TABLE training_profiles
  ADD COLUMN IF NOT EXISTS lthr_estimate     INTEGER,
  ADD COLUMN IF NOT EXISTS lthr_source       TEXT,
  ADD COLUMN IF NOT EXISTS lthr_confidence   TEXT,
  ADD COLUMN IF NOT EXISTS lthr_last_updated TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lthr_history      JSONB,
  ADD COLUMN IF NOT EXISTS hr_zone_method    TEXT NOT NULL DEFAULT 'pct_max';

-- Existing rows keep pct_max (hr_zone_method already defaults via DEFAULT above).
-- LTHR columns are NULL until estimated — this is correct; coach/respond falls back
-- to the generic HR zone text when lthr_estimate IS NULL.
