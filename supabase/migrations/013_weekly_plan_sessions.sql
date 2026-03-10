-- Add weekly_plan_sessions to training_state so the specific planned sessions
-- (day, date, distance, type) are stored after each plan generation and passed
-- back to Claude in all subsequent messages, preventing plan inconsistency.
--
-- Structure (array of objects):
-- [
--   { "day": "Tue", "date": "2026-03-10", "label": "Easy 6.5 km" },
--   { "day": "Thu", "date": "2026-03-12", "label": "Easy 6.5 km" },
--   { "day": "Sat", "date": "2026-03-14", "label": "Easy 8 km" }
-- ]
--
-- Reset to [] at the start of each new weekly_recap so stale sessions don't bleed over.

ALTER TABLE training_state
  ADD COLUMN IF NOT EXISTS weekly_plan_sessions jsonb DEFAULT '[]'::jsonb;
