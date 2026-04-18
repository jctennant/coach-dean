-- Add week1_start_date to training_state so the dashboard can anchor
-- the plan arc to the correct Monday without approximating from created_at.
-- Populated when the user confirms which week they're on after plan import.

ALTER TABLE training_state
  ADD COLUMN IF NOT EXISTS week1_start_date date;
