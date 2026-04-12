-- Track when an athlete is on an injury hold (cannot run this week).
-- injury_hold_since: date the hold was set; null = not on hold.
-- pre_injury_mileage_target: weekly mileage target before the hold, stored so we
--   can compute the return-to-running ramp (60-70% of pre-injury base) on clearance.
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS injury_hold_since date;
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS pre_injury_mileage_target numeric;
