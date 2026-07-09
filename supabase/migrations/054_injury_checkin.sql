-- Daily injury check-in support.
-- Stores the athlete's most recently reported pain level during injury hold
-- so morning cron can track recovery trend and the PWA can visualize it later.

ALTER TABLE training_state ADD COLUMN IF NOT EXISTS last_pain_level SMALLINT;
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS pain_reported_at DATE;

-- Add injury_checkin to the conversations message_type allowlist.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_message_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_message_type_check
  CHECK (message_type IN (
    'post_run', 'initial_plan', 'initial_plan_link', 'morning_plan',
    'nightly_reminder', 'morning_reminder', 'weekly_recap', 'user_message',
    'coach_response', 'onboarding', 'awaiting_strava', 'reengagement',
    'plan_import_week_ask', 'plan_upload', 'changelog', 'dashboard_announcement',
    'welcome_tips', 'workout_image', 'symptom_checkin', 'injury_checkin'
  ));
