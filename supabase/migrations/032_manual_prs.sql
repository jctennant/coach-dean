-- Manual PR overrides: keyed by Strava best-effort name (e.g. "5K", "Half-Marathon")
-- Value: { time_seconds: number, date?: "YYYY-MM-DD" }
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS manual_prs jsonb;
