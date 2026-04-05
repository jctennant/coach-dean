-- Add average_watts to activities for athletes with power meters (Zwift, Wahoo, Garmin).
-- Strava returns average_watts when the device records power data.
-- Stored as float (can be null for non-power activities).

ALTER TABLE activities ADD COLUMN IF NOT EXISTS average_watts float;
