-- Phase 10 image-driven rollout control. Binary model contents remain outside the control plane.

ALTER TABLE model_releases ADD COLUMN accept_existing_tasks boolean NOT NULL DEFAULT true;

CREATE TABLE rollout_impact_previews (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  pool_id text NOT NULL REFERENCES model_pools(id),
  source_release_id text NOT NULL REFERENCES model_releases(id),
  target_release_id text NOT NULL REFERENCES model_releases(id),
  pool_version integer NOT NULL CHECK (pool_version > 0),
  source_image_digest text NOT NULL CHECK (source_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_image_digest text NOT NULL CHECK (target_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  strategy jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  impact jsonb NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX rollout_impact_previews_project_created_idx
  ON rollout_impact_previews(project_id, created_at DESC, id DESC);

ALTER TABLE model_rollouts ADD COLUMN project_id text REFERENCES projects(id);
ALTER TABLE model_rollouts ADD COLUMN model_id text REFERENCES models(id);
ALTER TABLE model_rollouts ADD COLUMN alias text;
ALTER TABLE model_rollouts ADD COLUMN provider text;
ALTER TABLE model_rollouts ADD COLUMN region_id text REFERENCES provider_regions(id);
ALTER TABLE model_rollouts ADD COLUMN gpu_sku text;
ALTER TABLE model_rollouts ADD COLUMN preview_id text REFERENCES rollout_impact_previews(id);
ALTER TABLE model_rollouts ADD COLUMN strategy jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE model_rollouts ADD COLUMN source_image_digest text;
ALTER TABLE model_rollouts ADD COLUMN target_image_digest text;
ALTER TABLE model_rollouts ADD COLUMN direction text NOT NULL DEFAULT 'forward';
ALTER TABLE model_rollouts ADD COLUMN spent_extra_cost_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE model_rollouts ADD COLUMN currency char(3) NOT NULL DEFAULT 'CNY';
ALTER TABLE model_rollouts ADD COLUMN pause_code text;
ALTER TABLE model_rollouts ADD COLUMN created_by text;
ALTER TABLE model_rollouts ADD COLUMN started_at timestamptz;
ALTER TABLE model_rollouts ADD COLUMN paused_at timestamptz;
ALTER TABLE model_rollouts ADD COLUMN rollback_requested_at timestamptz;

UPDATE model_rollouts r SET
  project_id = p.project_id,
  model_id = target.model_id,
  alias = target.alias,
  provider = p.provider,
  region_id = p.region_id,
  gpu_sku = p.gpu_sku,
  source_image_digest = COALESCE(
    (SELECT source.image_digest FROM model_releases source WHERE source.id = r.source_release_id),
    target.image_digest
  ),
  target_image_digest = target.image_digest,
  created_by = 'migration'
FROM model_pools p
JOIN model_releases target ON true
WHERE p.id = r.pool_id AND target.id = r.target_release_id;

UPDATE model_rollouts SET source_image_digest = target_image_digest WHERE source_image_digest IS NULL;
ALTER TABLE model_rollouts ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE model_rollouts ALTER COLUMN model_id SET NOT NULL;
ALTER TABLE model_rollouts ALTER COLUMN alias SET NOT NULL;
ALTER TABLE model_rollouts ALTER COLUMN provider SET NOT NULL;
ALTER TABLE model_rollouts ALTER COLUMN region_id SET NOT NULL;
ALTER TABLE model_rollouts ALTER COLUMN gpu_sku SET NOT NULL;
ALTER TABLE model_rollouts ALTER COLUMN source_image_digest SET NOT NULL;
ALTER TABLE model_rollouts ALTER COLUMN target_image_digest SET NOT NULL;
ALTER TABLE model_rollouts ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE model_rollouts ADD CONSTRAINT model_rollouts_direction_v1_check
  CHECK (direction IN ('forward', 'rollback'));
ALTER TABLE model_rollouts ADD CONSTRAINT model_rollouts_cost_v1_check
  CHECK (spent_extra_cost_minor >= 0);
ALTER TABLE model_rollouts ADD CONSTRAINT model_rollouts_digest_v1_check
  CHECK (source_image_digest ~ '^sha256:[0-9a-f]{64}$' AND target_image_digest ~ '^sha256:[0-9a-f]{64}$');
CREATE UNIQUE INDEX model_rollouts_active_pool_v1_idx ON model_rollouts(pool_id)
  WHERE status IN ('pending', 'validating', 'rolling', 'paused', 'rolling_back');
CREATE INDEX model_rollouts_project_updated_v1_idx
  ON model_rollouts(project_id, updated_at DESC, id DESC);

CREATE TABLE rollout_steps (
  id text PRIMARY KEY,
  rollout_id text NOT NULL REFERENCES model_rollouts(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  direction text NOT NULL CHECK (direction IN ('forward', 'rollback')),
  source_replica_id text REFERENCES replicas(id),
  target_replica_id text REFERENCES replicas(id),
  prewarm_operation_id text REFERENCES provider_operations(id),
  terminate_operation_id text REFERENCES provider_operations(id),
  status text NOT NULL CHECK (status IN ('pending', 'provisioning', 'validating', 'target_ready', 'draining_old', 'replacing', 'completed', 'failed')),
  gates jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (rollout_id, direction, ordinal),
  UNIQUE (rollout_id, target_replica_id)
);
CREATE INDEX rollout_steps_rollout_status_idx ON rollout_steps(rollout_id, status, ordinal, id);

ALTER TABLE replicas ADD COLUMN rollout_id text REFERENCES model_rollouts(id);
ALTER TABLE replicas ADD COLUMN rollout_step_id text REFERENCES rollout_steps(id);
CREATE INDEX replicas_rollout_state_idx ON replicas(rollout_id, observed_state, id) WHERE rollout_id IS NOT NULL;

CREATE TABLE rollout_events (
  id text PRIMARY KEY,
  rollout_id text NOT NULL REFERENCES model_rollouts(id),
  rollout_version integer NOT NULL CHECK (rollout_version > 0),
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('oidc_user', 'controller', 'worker')),
  actor_id text NOT NULL,
  reason text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX rollout_events_rollout_created_idx ON rollout_events(rollout_id, created_at, id);

CREATE OR REPLACE FUNCTION astra_guard_rollout_history_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_rollout_history';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER rollout_impact_previews_immutable BEFORE UPDATE OR DELETE ON rollout_impact_previews
FOR EACH ROW EXECUTE FUNCTION astra_guard_rollout_history_immutable();
CREATE TRIGGER rollout_events_immutable BEFORE UPDATE OR DELETE ON rollout_events
FOR EACH ROW EXECUTE FUNCTION astra_guard_rollout_history_immutable();
