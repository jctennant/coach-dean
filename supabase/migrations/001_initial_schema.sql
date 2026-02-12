-- Coach Dean: Initial Schema
-- Run this in the Supabase SQL Editor to set up all tables.

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ============================================================
-- USERS
-- ============================================================
create table users (
  id              uuid primary key default uuid_generate_v4(),
  phone_number    text unique not null,
  strava_athlete_id bigint unique,
  strava_access_token text,
  strava_refresh_token text,
  strava_token_expires_at timestamptz,
  name            text,
  timezone        text default 'America/New_York',
  created_at      timestamptz default now()
);

create index idx_users_phone on users (phone_number);
create index idx_users_strava_athlete on users (strava_athlete_id);

-- ============================================================
-- TRAINING PROFILES
-- ============================================================
create table training_profiles (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references users(id) on delete cascade not null,
  goal            text,
  race_date       date,
  fitness_level   text check (fitness_level in ('beginner', 'intermediate', 'advanced')),
  days_per_week   int check (days_per_week between 1 and 7),
  constraints     text,
  current_easy_pace text,
  current_tempo_pace text,
  current_interval_pace text,
  updated_at      timestamptz default now()
);

create unique index idx_training_profiles_user on training_profiles (user_id);

-- ============================================================
-- TRAINING STATE
-- ============================================================
create table training_state (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references users(id) on delete cascade not null,
  current_week    int default 1,
  current_phase   text default 'base' check (current_phase in ('base', 'build', 'peak', 'taper')),
  weekly_mileage_target float,
  long_run_target float,
  week_mileage_so_far float default 0,
  last_activity_date date,
  last_activity_summary jsonb,
  plan_adjustments text,
  updated_at      timestamptz default now()
);

create unique index idx_training_state_user on training_state (user_id);

-- ============================================================
-- CONVERSATIONS
-- ============================================================
create table conversations (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references users(id) on delete cascade not null,
  role            text not null check (role in ('user', 'assistant', 'system')),
  content         text not null,
  message_type    text check (message_type in ('morning_plan', 'post_run', 'user_message', 'coach_response')),
  strava_activity_id bigint,
  created_at      timestamptz default now()
);

create index idx_conversations_user_date on conversations (user_id, created_at desc);

-- ============================================================
-- ACTIVITIES
-- ============================================================
create table activities (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references users(id) on delete cascade not null,
  strava_activity_id bigint unique not null,
  activity_type   text,
  distance_meters float,
  moving_time_seconds int,
  elapsed_time_seconds int,
  average_heartrate float,
  max_heartrate   float,
  average_cadence float,
  average_pace    text,
  elevation_gain  float,
  suffer_score    int,
  gear_id         text,
  gear_name       text,
  start_date      timestamptz,
  summary         jsonb,
  created_at      timestamptz default now()
);

create index idx_activities_user_date on activities (user_id, start_date desc);
create index idx_activities_strava_id on activities (strava_activity_id);
