-- Add strava_write_enabled flag to users.
-- When true, Coach Dean will annotate qualifying Strava activities
-- with a brief training note in the activity description.
ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_write_enabled boolean DEFAULT false;
