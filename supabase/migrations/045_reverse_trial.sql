-- 045_reverse_trial.sql
-- Adds a per-user flag for the "reverse free trial" flow: complete onboarding
-- straight into full coaching, then gate access after 7 days unless the user
-- has subscribed via Stripe.
--
-- Default false so existing users and new signups remain on the upfront-payment
-- flow until REVERSE_TRIAL_ENABLED=true is set in the signup env. The column is
-- stamped at user creation and never re-evaluated, so flipping the env var only
-- affects brand-new signups.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reverse_trial_enabled boolean NOT NULL DEFAULT false;
