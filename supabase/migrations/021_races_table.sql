-- races: normalized table for all of an athlete's races, with A/B/C priority.
-- The A race is the primary goal driving the training plan arc.
-- B races are tune-up events (short mini-taper, race at strong effort, resume training).
-- C races are treated as workouts (no taper, normal training week).
--
-- training_profiles.race_date and .goal remain as a denormalized A-race cache
-- so all existing coaching code continues to work without changes.

CREATE TABLE IF NOT EXISTS races (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  race_date date NOT NULL,
  race_name text,
  goal text NOT NULL,
  priority text NOT NULL DEFAULT 'A' CHECK (priority IN ('A', 'B', 'C')),
  goal_time_minutes float,
  goal_distance_miles float,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_races_user_date ON races (user_id, race_date ASC);

-- Backfill A races from existing training_profiles so existing athletes
-- have their primary race represented in the new table.
INSERT INTO races (user_id, race_date, race_name, goal, priority, goal_time_minutes, goal_distance_miles)
SELECT
  tp.user_id,
  tp.race_date,
  (u.onboarding_data->>'race_name'),
  tp.goal,
  'A',
  CASE
    WHEN (u.onboarding_data->>'goal_time_minutes') ~ '^[0-9]+(\.[0-9]+)?$'
    THEN (u.onboarding_data->>'goal_time_minutes')::float
    ELSE NULL
  END,
  tp.goal_distance_miles
FROM training_profiles tp
JOIN users u ON tp.user_id = u.id
WHERE tp.race_date IS NOT NULL
  AND tp.goal IS NOT NULL;
