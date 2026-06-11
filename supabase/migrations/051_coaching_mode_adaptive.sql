-- Add 'adaptive' to the coaching_mode check constraint.
-- All new users are onboarded with coaching_mode = 'adaptive' (single responsive mode that
-- coaches toward the race — see completeOnboarding in onboarding/handle/route.ts). The
-- constraint from migration 043 only allowed ('full_coach', 'analyst', 'complement'), so
-- every new-user training_profiles upsert failed with SQLSTATE 23514
-- ("training_profiles_coaching_mode_check"), silently dropping the athlete's profile.
-- Keep the legacy values so existing rows stay valid.

ALTER TABLE training_profiles DROP CONSTRAINT IF EXISTS training_profiles_coaching_mode_check;

ALTER TABLE training_profiles ADD CONSTRAINT training_profiles_coaching_mode_check
  CHECK (coaching_mode IN ('full_coach', 'analyst', 'complement', 'adaptive'));
