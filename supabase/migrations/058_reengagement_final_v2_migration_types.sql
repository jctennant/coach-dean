-- Add reengagement_final and v2_migration to the conversations message_type allowlist.
--
-- Both types were already used by code but missing from the constraint, so their
-- inserts failed silently:
--  - reengagement_final (cron/reengagement): the "never message again" marker row
--    never persisted, so the final goodbye nudge re-sent every 7 days to every
--    silent user instead of exactly once.
--  - v2_migration (admin/v2-migration): migration announcement rows were never
--    recorded in conversation history.
--  - awaiting_payment (cron/trial-expiry): trial-expiry messages were never
--    recorded in conversation history.
--  - awaiting_timezone (onboarding/handle): timezone-ask messages were never
--    recorded in conversation history.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_message_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_message_type_check
  CHECK (message_type IN (
    'post_run', 'initial_plan', 'initial_plan_link', 'morning_plan',
    'nightly_reminder', 'morning_reminder', 'weekly_recap', 'user_message',
    'coach_response', 'onboarding', 'awaiting_strava', 'reengagement',
    'reengagement_final', 'plan_import_week_ask', 'plan_upload', 'changelog',
    'dashboard_announcement', 'welcome_tips', 'workout_image', 'symptom_checkin',
    'injury_checkin', 'v2_migration', 'awaiting_payment', 'awaiting_timezone'
  ));
