-- Add current_vdot to training_profiles so it's available in every session
-- without needing a PR in the current message.
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS current_vdot numeric;
