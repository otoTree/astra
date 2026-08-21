CREATE TABLE IF NOT EXISTS model_releases (
  id text PRIMARY KEY,
  alias text NOT NULL,
  image_digest text NOT NULL,
  workflow_hash text NOT NULL,
  manifest jsonb NOT NULL,
  accept_new_tasks boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('video', 'image')),
  operation text NOT NULL DEFAULT 'generation',
  status text NOT NULL,
  priority text NOT NULL DEFAULT 'online' CHECK (priority IN ('online', 'batch')),
  model_release_id text NOT NULL REFERENCES model_releases(id),
  request_ciphertext text NOT NULL,
  request_hash text NOT NULL,
  progress integer,
  output jsonb,
  error jsonb,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_status_created_idx ON tasks(status, created_at, id);
CREATE INDEX IF NOT EXISTS tasks_project_created_idx ON tasks(project_id, created_at, id);

CREATE TABLE IF NOT EXISTS files (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  filename text NOT NULL,
  purpose text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL UNIQUE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  endpoint text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  task_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, endpoint, key)
);

CREATE TABLE IF NOT EXISTS task_state_events (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  from_status text,
  to_status text NOT NULL,
  reason text,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_files (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  file_id text NOT NULL REFERENCES files(id),
  direction text NOT NULL CHECK (direction IN ('input', 'output')),
  role text NOT NULL,
  ordinal integer NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events(created_at, id) WHERE published_at IS NULL;

INSERT INTO model_releases (id, alias, image_digest, workflow_hash, manifest, accept_new_tasks)
VALUES (
  'release_local_reference',
  'local-reference-release',
  'sha256:local-reference',
  'local-reference-workflow',
  '{"modalities":["video","image"],"fps":[24],"max_concurrency":1,"capabilities":{"aspect_ratios":["16:9"],"resolutions":["0.2mp"],"resolution_matrix":{"16:9/0.2mp":{"width":608,"height":352}},"durations":[5,15],"input_types":["image","video","audio"],"input_roles":["reference_image","reference_video","reference_audio"],"audio_modes":["none","native","reference"]}}'::jsonb,
  true
)
ON CONFLICT (id) DO NOTHING;
