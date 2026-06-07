-- Physio referral tracking: records when Dean referred the athlete to a professional,
-- whether they confirmed a visit, and what the physio prescribed.
-- Dean uses physio_notes + physio_prescribed_restrictions to coach within the
-- physio's constraints rather than generating its own competing assessment.

ALTER TABLE training_state ADD COLUMN IF NOT EXISTS physio_referral_sent_at timestamptz;
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS physio_visit_confirmed bool DEFAULT false;

ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS physio_notes text;
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS physio_prescribed_restrictions jsonb;

-- Return-to-run phase tracking: structured progression after injury_clear.
-- Phase 1 = walk/run (50% volume cap), Phase 2 = easy only (70% cap), Phase 3 = normal.
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS return_to_run_phase int;
ALTER TABLE training_state ADD COLUMN IF NOT EXISTS return_to_run_gate_date date;
