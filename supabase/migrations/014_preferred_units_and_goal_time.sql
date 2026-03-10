-- preferred_units: "imperial" (miles/min-per-mile) or "metric" (km/min-per-km).
-- Captured from Strava athlete.measurement_preference at OAuth connect time.
-- Used throughout the system prompt and display logic to avoid unit confusion.
ALTER TABLE training_profiles
  ADD COLUMN IF NOT EXISTS preferred_units text NOT NULL DEFAULT 'imperial';

-- goal_time_minutes: the athlete's race goal in total minutes (e.g. 210 = 3:30 marathon).
-- Previously only stored in users.onboarding_data — moving to training_profiles so
-- extractAndPersistProfileUpdates can update it mid-season from chat.
ALTER TABLE training_profiles
  ADD COLUMN IF NOT EXISTS goal_time_minutes integer;
