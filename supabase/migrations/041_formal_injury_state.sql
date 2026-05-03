-- Formal injury tracking state.
-- Replaces the freeform `injury_notes` text column as the source of truth for
-- "is the athlete actively injured right now and how should that change my coaching".
-- injury_notes is preserved for historical / nuance context.
--
-- active_injury: true while the athlete is managing an injury.
-- injury_severity: 'mild' (annoyance, can run modified) | 'moderate' (modified plan, may skip
--                  some sessions) | 'severe' (no running — should be on injury_hold in training_state)
-- injury_body_part: short label like 'left achilles', 'right knee', 'lower back'
-- injury_start_date: when the issue began (for tracking duration)
-- injury_return_protocol: free-text return-to-running protocol when applicable
--                         (e.g. "2 min run / 1 min walk x 6, easy effort, 3x/week")
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS active_injury boolean DEFAULT false;
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS injury_severity text;
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS injury_body_part text;
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS injury_start_date date;
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS injury_return_protocol text;

ALTER TABLE training_profiles
  DROP CONSTRAINT IF EXISTS training_profiles_injury_severity_check;
ALTER TABLE training_profiles
  ADD CONSTRAINT training_profiles_injury_severity_check
  CHECK (injury_severity IS NULL OR injury_severity IN ('mild', 'moderate', 'severe'));

-- Backfill: existing users with non-empty injury_notes are NOT auto-flagged as actively
-- injured. Many notes describe historical issues ("had IT band trouble in 2023"). active_injury
-- defaults to false; Dean will collect the structured state on the next conversation that
-- discusses injury. Migration intentionally leaves this column false for all existing rows.
