-- 035_plan_import_mountain.sql
--
-- 1. Add course_record_minutes to races — enables percentile-based predictions
--    for mountain/sky races where VDOT alone is unreliable (everyone hikes steep).
-- 2. Extend trail_subtype constraint to include 'mountain' for VK/sky/Skyrunner events.
-- 3. Add external_plan_notes to training_profiles — stores a plain-text description
--    of an athlete's existing plan (Runna, Garmin Coach, coach-written, etc.).
--    Dean uses this as context in coaching feedback without requiring structured import.
-- 4. Add dashboard_announcement_sent_at to users — idempotency guard for the
--    dashboard feature announcement message.

-- Course record (fastest known finish) in minutes
ALTER TABLE races ADD COLUMN IF NOT EXISTS course_record_minutes float;

-- Expand trail_subtype to include 'mountain' (VK / sky / scramble-style races)
ALTER TABLE races DROP CONSTRAINT IF EXISTS races_trail_subtype_check;
ALTER TABLE races ADD CONSTRAINT races_trail_subtype_check
  CHECK (trail_subtype IN ('groomed', 'mixed', 'technical', 'highly_technical', 'mountain'));

-- External training plan description (stored as free text from onboarding or SMS)
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS external_plan_notes text;

-- Dashboard announcement idempotency guard
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_announcement_sent_at timestamptz;
