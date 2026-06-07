-- Load scoring columns for injury prediction and coaching context.
-- running_impact_load: mechanical stress (runs only) — used for spike detection.
-- activity_fatigue_load: systemic fatigue (all activities) — used for coaching context.
-- grade_modifier_source: how treadmill incline was determined (since Strava often omits it).

ALTER TABLE activities ADD COLUMN IF NOT EXISTS running_impact_load float;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_fatigue_load float;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS grade_modifier_source text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS user_confirmed_incline bool;

-- training_state columns for spike detection, symptom check-in, and leg-day context.
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS rolling_30d_max_running_load float;
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS race_peak_load_flag bool DEFAULT false;
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS pending_symptom_checkin bool DEFAULT false;
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS leg_day_flag bool DEFAULT false;
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS leg_day_flag_expires_at timestamptz;
