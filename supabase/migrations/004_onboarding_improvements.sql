ALTER TABLE training_profiles ADD COLUMN crosstraining_tools text[] DEFAULT '{}';
ALTER TABLE training_profiles ADD COLUMN proactive_cadence text DEFAULT 'weekly_only';
-- proactive_cadence values: 'nightly_reminders' | 'weekly_only'
