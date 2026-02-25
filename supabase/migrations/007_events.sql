create table events (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  event_name text not null,
  properties jsonb default '{}',
  created_at timestamp with time zone default now()
);

create index idx_events_user_id on events (user_id);
create index idx_events_event_name on events (event_name);
create index idx_events_created_at on events (created_at desc);
