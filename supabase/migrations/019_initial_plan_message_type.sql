-- Expand the conversations message_type CHECK constraint to allow 'initial_plan'.
-- initial_plan is stored during dry_run onboarding tests so the test runner can
-- read and display the generated week plan.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_message_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_message_type_check
  CHECK (message_type IN ('morning_plan', 'post_run', 'user_message', 'coach_response', 'reengagement', 'initial_plan'));
