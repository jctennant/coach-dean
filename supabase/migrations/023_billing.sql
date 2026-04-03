-- Stripe subscription billing columns.
-- billing_enabled is a per-user feature flag (default false = grandfathered/free).
-- Set to true for new signups once billing is live, or manually per user for testing.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS billing_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text,         -- 'trialing' | 'active' | 'past_due' | 'canceled'
  ADD COLUMN IF NOT EXISTS dunning_sent_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_dunning_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_link_sent_at timestamptz; -- set when awaiting_payment SMS is sent; cleared on subscribe
