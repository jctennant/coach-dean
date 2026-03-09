-- Add skip_dates to training_profiles for one-off workout skips.
-- When a user says "skip this Sunday", Dean stores that date here so the
-- morning/nightly reminder crons don't fire for that specific date without
-- permanently removing the day from training_days.
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS skip_dates text[] DEFAULT '{}';
