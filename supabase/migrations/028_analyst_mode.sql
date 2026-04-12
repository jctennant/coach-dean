-- Add coaching_mode to training_profiles.
-- 'full_coach' = structured plan + sessions + reminders (existing behavior)
-- 'analyst'    = no plan; post-run insights + weekly trend recap only

ALTER TABLE training_profiles
  ADD COLUMN IF NOT EXISTS coaching_mode text NOT NULL DEFAULT 'full_coach'
  CHECK (coaching_mode IN ('full_coach', 'analyst'));

-- Existing users all keep 'full_coach' — no backfill needed.
-- Analyst mode is opt-in at onboarding for new users.
