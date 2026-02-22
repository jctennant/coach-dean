-- Add injury notes to training profiles so Dean can reference them in coaching prompts
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS injury_notes text;
