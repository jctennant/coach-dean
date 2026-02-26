-- Add linq_chat_id to users so we can call typing/read-receipt APIs
-- Populated on first outbound message; used for all subsequent interactions
ALTER TABLE users ADD COLUMN IF NOT EXISTS linq_chat_id text;
