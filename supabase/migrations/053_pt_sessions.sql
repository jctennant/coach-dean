-- Post-run protocol completion tracking.
-- One row per session link sent; exercises_done accumulates as the athlete taps through.
-- Feeds back into the coaching engine so Dean can reference PT compliance.

CREATE TABLE IF NOT EXISTS pt_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_key text NOT NULL,
  session_key text NOT NULL,          -- data portion of the signed token (unique per link sent)
  exercises_done text[] NOT NULL DEFAULT '{}',
  completed_at timestamptz,           -- set when all exercises in the routine are marked done
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_key)
);

CREATE INDEX IF NOT EXISTS pt_sessions_user_id_idx ON pt_sessions (user_id);
