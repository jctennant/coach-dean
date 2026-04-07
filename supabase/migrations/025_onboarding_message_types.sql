-- Add 'onboarding' and 'awaiting_strava' to the conversations message_type CHECK constraint.
-- These are used by the onboarding handler's sendAndStore calls but were missing from the
-- constraint, causing all assistant messages during onboarding to fail silently.

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_message_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_message_type_check
  CHECK (message_type IN (
    'morning_plan', 'post_run', 'user_message', 'coach_response',
    'reengagement', 'initial_plan', 'onboarding', 'awaiting_strava'
  ));
