-- Per-day pain level log during injury hold.
-- One row per athlete per day; upserted when Haiku extracts a pain_level from their reply.
-- Powers the pain timeline visualization on the recovery dashboard.

CREATE TABLE IF NOT EXISTS pain_checkins (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  date date NOT NULL,
  pain_level smallint NOT NULL CHECK (pain_level >= 0 AND pain_level <= 10),
  created_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE (user_id, date)
);
