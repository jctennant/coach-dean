-- Track which body parts have been mentioned with soreness/pain across sessions.
-- Used to detect recurring injuries and trigger escalation to rest + PT referral.
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS injury_body_parts text[] DEFAULT '{}';
