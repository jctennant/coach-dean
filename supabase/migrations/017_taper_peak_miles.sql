-- Store the athlete's pre-taper peak mileage so taper targets stay consistent
-- across messages. Without this, the taper protocol recalculates from
-- avgWeeklyMileage on every message — causing the targets to shift as new
-- activities sync (e.g. "36 miles this week" then "26 miles this week" same day).
--
-- Set once when the taper window first activates (≤21 days to race).
-- Cleared when a new plan is generated after the race (or on next initial_plan).

ALTER TABLE training_state
  ADD COLUMN IF NOT EXISTS taper_peak_miles float;
