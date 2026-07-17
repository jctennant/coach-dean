-- Optional per-athlete cross-training day preference, distinct from running training_days.
-- Used by computeRecoveryWeekSkeleton() to place cross-training/strength slots during an
-- injury hold. NULL means "no preference stated" -- the skeleton defaults to mirroring the
-- athlete's normal training_days pattern (or a fixed 4x/week cadence if that's also empty).
-- No backfill needed: NULL correctly means "never stated" for every existing user too, not
-- a false first-timer signal.
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS crosstraining_days text[];
