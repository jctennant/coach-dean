-- Re-engagement tracking.
-- reengagement_sent_at: timestamp of the last re-engagement nudge sent to a user.
-- Set to now() when a nudge is sent; reset to NULL when the user sends any inbound message.

ALTER TABLE users ADD COLUMN IF NOT EXISTS reengagement_sent_at timestamptz;

-- Expand the conversations message_type CHECK constraint to allow 'reengagement'.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_message_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_message_type_check
  CHECK (message_type IN ('morning_plan', 'post_run', 'user_message', 'coach_response', 'reengagement'));
