-- Add opt-out flag to users table.
-- Set when a user replies STOP or expresses they don't want messages.
-- All cron jobs and the inbound webhook check this before sending.

ALTER TABLE users ADD COLUMN IF NOT EXISTS messaging_opted_out boolean NOT NULL DEFAULT false;
