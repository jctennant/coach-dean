-- SMS-based onboarding: add step tracking and training days

ALTER TABLE users ADD COLUMN onboarding_step TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN onboarding_data JSONB DEFAULT '{}';
ALTER TABLE training_profiles ADD COLUMN training_days TEXT[] DEFAULT '{}';
