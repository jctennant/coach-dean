-- Structured per-session symptom tracking with canonical body part vocabulary.
-- Replaces the blunt injury_body_parts text[] with a richer per-occurrence log.
-- Enables 30-day recurrence detection for escalation logic.

ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS symptom_history jsonb DEFAULT '[]'::jsonb;

-- Add pending_sharp_disambiguation to training_state: true when the last user message
-- mentioned "sharp" pain but we haven't yet asked the clarifying question.
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS pending_sharp_disambiguation bool DEFAULT false;

-- Add symptom_checkin to the conversations message_type allowlist.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_message_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_message_type_check
  CHECK (message_type IN (
    'post_run', 'initial_plan', 'initial_plan_link', 'morning_plan',
    'nightly_reminder', 'morning_reminder', 'weekly_recap', 'user_message',
    'coach_response', 'onboarding', 'awaiting_strava', 'reengagement',
    'plan_import_week_ask', 'plan_upload', 'changelog', 'dashboard_announcement',
    'welcome_tips', 'workout_image', 'symptom_checkin'
  ));
