-- Allow activities to be stored from sources other than Strava (e.g. workout screenshots)
-- strava_activity_id is now optional; source column distinguishes the origin.

ALTER TABLE activities ALTER COLUMN strava_activity_id DROP NOT NULL;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'strava';

-- Update existing rows
UPDATE activities SET source = 'strava' WHERE source = 'strava';
