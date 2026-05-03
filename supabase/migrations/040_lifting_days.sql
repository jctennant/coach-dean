-- Track which days of the week the athlete lifts (especially leg-heavy lifts).
-- Used so Dean can avoid scheduling hard runs within 24h of a leg day, and can
-- proactively note leg-day proximity in post-run / morning messages.
-- Stored as lowercase 3-letter day abbreviations: mon, tue, wed, thu, fri, sat, sun.
-- Empty array = athlete does not lift on a fixed schedule (or doesn't lift at all).
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS lifting_days text[] DEFAULT ARRAY[]::text[];

-- Optional: which days are LEG-focused (subset of lifting_days). Squat/deadlift days
-- are the ones that meaningfully degrade run quality. If empty, treat all lifting_days
-- as potentially leg-impacting (conservative default).
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS leg_lift_days text[] DEFAULT ARRAY[]::text[];
