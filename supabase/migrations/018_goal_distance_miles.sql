-- Store the athlete's exact goal race distance in miles.
--
-- For standard distances (5K, marathon, etc.) this equals the canonical bucket distance.
-- For non-standard distances (e.g., a 25K, 9-mile trail race, 80K), the onboarding
-- classifier extracts the actual distance so pacing and long-run targets are accurate.
--
-- Used in coach/respond to compute goal pace (instead of the bucket lookup fallback)
-- and to display the exact distance when referencing a non-standard race.

ALTER TABLE training_profiles
  ADD COLUMN IF NOT EXISTS goal_distance_miles float;

-- Backfill existing rows using the standard bucket distances.
-- Non-standard races already in the system will remain NULL until the athlete re-onboards,
-- but the code falls back to the bucket lookup gracefully.
UPDATE training_profiles
SET goal_distance_miles = CASE goal
  WHEN '5k'            THEN 3.107
  WHEN '10k'           THEN 6.214
  WHEN 'half_marathon' THEN 13.109
  WHEN 'marathon'      THEN 26.219
  WHEN '30k'           THEN 18.641
  WHEN '50k'           THEN 31.069
  WHEN '50mi'          THEN 50.0
  WHEN '100k'          THEN 62.137
  WHEN '100mi'         THEN 100.0
  ELSE NULL
END
WHERE goal IS NOT NULL AND goal_distance_miles IS NULL;
