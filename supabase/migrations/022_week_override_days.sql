-- Add this-week schedule override to training_profiles.
-- When a user says "I want to run Mon/Wed/Fri this week instead of my normal days",
-- Dean stores the temporary days here rather than overwriting training_days.
-- The crons check this first (if not expired) and fall back to training_days.
-- Expires end-of-week (Sunday) so no cleanup job is needed.
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS this_week_override_days text[] DEFAULT NULL;
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS this_week_override_expires date DEFAULT NULL;
