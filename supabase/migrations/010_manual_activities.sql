-- Allow manually-reported activities (no Strava ID).
-- strava_activity_id was NOT NULL — relax that constraint so we can insert
-- rows where the athlete reported the workout via SMS rather than Strava.

alter table activities
  alter column strava_activity_id drop not null;

-- Add a source column so we can distinguish Strava vs manual entries.
alter table activities
  add column if not exists source text default 'strava' check (source in ('strava', 'manual'));
