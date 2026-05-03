-- Per-athlete narrative coaching threads.
-- A short, free-text list of 1–3 things Dean is "watching" on this athlete across
-- multiple runs — e.g. "cadence trending up from 168 to 174 spm; watching long-run
-- HR drift now that mileage is back over 30/wk; left achilles is recovering, OK to
-- progress easy effort". Updated by weekly_recap so the threads reflect recent
-- patterns, not stale onboarding data. Injected into post_run prompts so Dean
-- references the same evolving story across runs instead of treating each one
-- in isolation. This is the differentiator vs. Strava — Strava sees runs in
-- isolation; a coach sees a thread.
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS coaching_threads text;
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS coaching_threads_updated_at timestamptz;
