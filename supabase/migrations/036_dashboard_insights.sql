-- Stores the Haiku-generated dashboard insights (summary + 3 focus areas) for each athlete.
-- Generated async after post_run, weekly_recap, and initial_plan — never at dashboard render time.
-- NULL = not yet generated (new users). Dashboard falls back gracefully.
ALTER TABLE training_profiles
  ADD COLUMN IF NOT EXISTS dashboard_insights jsonb;
