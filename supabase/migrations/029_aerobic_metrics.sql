-- Store computed aerobic metrics per activity so Dean can trend them over time.
-- aerobic_efficiency: speed-per-heartbeat in m/beat (grade-adjusted when available).
--   Higher = more economical. Trends upward as fitness improves.
-- cardiac_decoupling_pct: % drift in GAP:HR efficiency factor, first vs second half.
--   Lower = aerobic system held together. >10% indicates residual fatigue.

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS aerobic_efficiency float,
  ADD COLUMN IF NOT EXISTS cardiac_decoupling_pct float;
