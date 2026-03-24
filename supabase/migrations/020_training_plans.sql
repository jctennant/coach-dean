-- training_plans: stores the full pre-generated multi-week training arc.
-- Generated at signup (initial_plan trigger) and referenced each week by
-- weekly_recap so Dean has a structured plan to reflect on rather than
-- inventing a new one from scratch.
CREATE TABLE IF NOT EXISTS training_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  race_date date,
  goal text,
  total_weeks int NOT NULL,
  weeks jsonb NOT NULL DEFAULT '[]'
  -- weeks is an array of objects:
  -- {
  --   week_number: int,        -- 1-indexed
  --   phase: string,           -- "base" | "build" | "peak" | "taper"
  --   mileage_target: number,  -- weekly mileage
  --   long_run_target: number, -- long run distance for the week
  --   key_workout: string,     -- one-line workout description, e.g. "4x1mi @ threshold pace"
  --   notes: string            -- brief coaching note for this week
  -- }
);

-- dashboard_token: a secret URL token for the athlete to view their plan
-- at coachdean.ai/dashboard?token=xxx (generated at initial_plan time).
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_token text UNIQUE;

-- trial_started_at: when the athlete's free trial period began.
-- Dashboard shows full plan within 7 days; future weeks blur after that.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
