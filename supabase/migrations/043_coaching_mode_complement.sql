-- Add 'complement' to the coaching_mode check constraint.
-- Previously only 'full_coach' and 'analyst' were allowed.
-- 'complement' = athlete follows their own external plan (Runna, TP, coach-written, etc.)

ALTER TABLE training_profiles DROP CONSTRAINT IF EXISTS training_profiles_coaching_mode_check;

ALTER TABLE training_profiles ADD CONSTRAINT training_profiles_coaching_mode_check
  CHECK (coaching_mode IN ('full_coach', 'analyst', 'complement'));

-- Backfill known complement users based on onboarding signals and mileage evidence.
-- Jb: has_existing_plan=true in onboarding_data
-- Jen: 50k goal, consistently running 33-45mi/wk against a 17mi plan target
UPDATE training_profiles SET coaching_mode = 'complement'
WHERE user_id IN (
  'cc39c804-cf86-4a94-b05f-711bbc46fa4e', -- Jb (has_existing_plan=true)
  '32d7510f-e774-4345-b758-4c48e916812f'  -- Jen (50k, doing 2x+ plan target consistently)
);
