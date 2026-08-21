CREATE TABLE IF NOT EXISTS models (
  id text PRIMARY KEY,
  alias text NOT NULL UNIQUE,
  modality text NOT NULL CHECK (modality IN ('video', 'image')),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_regions (
  id text PRIMARY KEY,
  provider text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'unavailable', 'unknown')),
  snapshot_version text,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, id)
);

CREATE TABLE IF NOT EXISTS provider_inventory (
  id text PRIMARY KEY,
  provider text NOT NULL,
  region_id text NOT NULL REFERENCES provider_regions(id),
  gpu_sku text NOT NULL,
  gpu_memory_bytes bigint NOT NULL CHECK (gpu_memory_bytes >= 0),
  available_replicas integer NOT NULL CHECK (available_replicas >= 0),
  price_per_gpu_hour_minor bigint NOT NULL CHECK (price_per_gpu_hour_minor >= 0),
  currency char(3) NOT NULL,
  snapshot_version text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, region_id, gpu_sku, snapshot_version)
);
CREATE INDEX IF NOT EXISTS provider_inventory_observed_idx ON provider_inventory(observed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS model_pools (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES model_releases(id),
  provider text NOT NULL,
  region_id text NOT NULL REFERENCES provider_regions(id),
  gpu_sku text NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('deployment', 'batch')),
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'degraded')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_pools_release_idx ON model_pools(release_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS replicas (
  id text PRIMARY KEY,
  pool_id text NOT NULL REFERENCES model_pools(id),
  release_id text NOT NULL REFERENCES model_releases(id),
  provider text NOT NULL,
  provider_resource_id text,
  region_id text NOT NULL REFERENCES provider_regions(id),
  gpu_sku text NOT NULL,
  image_digest text NOT NULL,
  desired_state text NOT NULL CHECK (desired_state IN ('provisioning', 'ready', 'draining', 'terminated')),
  observed_state text NOT NULL CHECK (observed_state IN ('provisioning', 'ready', 'busy', 'unknown', 'draining', 'drained', 'terminated', 'failed')),
  rollout_reserved boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replicas_pool_state_idx ON replicas(pool_id, observed_state, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS workers (
  id text PRIMARY KEY,
  replica_id text NOT NULL UNIQUE REFERENCES replicas(id),
  release_id text NOT NULL REFERENCES model_releases(id),
  contract_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('registering', 'ready', 'busy', 'unknown', 'draining', 'drained', 'offline')),
  capabilities jsonb NOT NULL,
  current_attempt_id text REFERENCES attempts(id),
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workers_status_heartbeat_idx ON workers(status, last_heartbeat_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS provider_operations (
  id text PRIMARY KEY,
  provider text NOT NULL,
  operation_key text NOT NULL UNIQUE,
  operation_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'reconciling', 'suppressed')),
  resource_type text,
  resource_id text,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  cost_minor bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS provider_operations_status_created_idx
  ON provider_operations(status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS model_rollouts (
  id text PRIMARY KEY,
  pool_id text NOT NULL REFERENCES model_pools(id),
  source_release_id text REFERENCES model_releases(id),
  target_release_id text NOT NULL REFERENCES model_releases(id),
  status text NOT NULL CHECK (status IN ('pending', 'validating', 'rolling', 'paused', 'completed', 'failed', 'rolling_back', 'rolled_back', 'canceled')),
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS model_rollouts_pool_created_idx ON model_rollouts(pool_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS attempts_status_created_idx ON attempts(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS leases_expiry_idx ON leases(expires_at, id);
CREATE INDEX IF NOT EXISTS task_state_events_task_created_idx ON task_state_events(task_id, created_at, id);

INSERT INTO models (id, alias, modality, status)
VALUES
  ('model_local_video', 'local-reference-video', 'video', 'active'),
  ('model_local_image', 'local-reference-image', 'image', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider_regions (id, provider, name, status, snapshot_version, observed_at)
VALUES ('region_local', 'reference', 'Local Contract Region', 'healthy', 'local-bootstrap', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider_inventory (
  id, provider, region_id, gpu_sku, gpu_memory_bytes, available_replicas,
  price_per_gpu_hour_minor, currency, snapshot_version, observed_at
)
VALUES (
  'inventory_local_reference', 'reference', 'region_local', 'reference-gpu', 34359738368, 100,
  300, 'CNY', 'local-bootstrap', now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO model_pools (id, release_id, provider, region_id, gpu_sku, execution_mode, status)
VALUES (
  'pool_local_reference', 'release_local_reference', 'reference', 'region_local',
  'reference-gpu', 'deployment', 'active'
)
ON CONFLICT (id) DO NOTHING;
