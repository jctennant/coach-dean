-- Store Strava best efforts (PR segments) and activity name per activity.
-- best_efforts: raw Strava best_efforts array (name, elapsed_time, distance, start_date, pr_rank)
-- activity_name: e.g. "Morning Run", "Bay to Breakers 12K", "Afternoon Run"
ALTER TABLE activities ADD COLUMN IF NOT EXISTS best_efforts jsonb;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_name text;
