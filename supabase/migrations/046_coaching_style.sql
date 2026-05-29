ALTER TABLE training_profiles
  ADD COLUMN IF NOT EXISTS coaching_style text NOT NULL DEFAULT 'standard';
