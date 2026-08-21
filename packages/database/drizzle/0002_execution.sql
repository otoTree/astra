CREATE TABLE IF NOT EXISTS attempts (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  release_id text NOT NULL REFERENCES model_releases(id),
  status text NOT NULL,
  execution_key text NOT NULL UNIQUE,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS attempts_task_idx ON attempts(task_id, created_at);

CREATE TABLE IF NOT EXISTS leases (
  id text PRIMARY KEY,
  attempt_id text NOT NULL UNIQUE REFERENCES attempts(id),
  worker_id text NOT NULL,
  replica_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 0
);
