-- Track whether the v2.0 transition message has been sent to a user.
-- NULL = not yet sent. Set to the timestamp when the message was delivered.
ALTER TABLE users ADD COLUMN IF NOT EXISTS v2_migration_sent_at timestamptz;
