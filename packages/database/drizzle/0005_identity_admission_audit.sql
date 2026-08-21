CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS projects_organization_idx ON projects(organization_id, id);

CREATE TABLE IF NOT EXISTS project_memberships (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  subject_type text NOT NULL CHECK (subject_type IN ('oidc_user', 'oidc_group')),
  subject_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'operator', 'model_releaser', 'security_auditor', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, subject_type, subject_id, role)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  default_project_id text NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  key_prefix text NOT NULL UNIQUE CHECK (key_prefix ~ '^[0-9a-f]{12}$'),
  key_last_four text NOT NULL CHECK (length(key_last_four) = 4),
  secret_hash text NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (cardinality(scopes) > 0)
);
CREATE INDEX IF NOT EXISTS api_keys_organization_idx ON api_keys(organization_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS api_key_project_grants (
  api_key_id text NOT NULL REFERENCES api_keys(id),
  project_id text NOT NULL REFERENCES projects(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, project_id)
);

CREATE TABLE IF NOT EXISTS project_quotas (
  project_id text PRIMARY KEY REFERENCES projects(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  request_rate_per_minute integer NOT NULL CHECK (request_rate_per_minute > 0),
  request_burst integer NOT NULL CHECK (request_burst > 0),
  task_rate_per_minute integer NOT NULL CHECK (task_rate_per_minute > 0),
  task_burst integer NOT NULL CHECK (task_burst > 0),
  queued_task_limit integer NOT NULL CHECK (queued_task_limit >= 0),
  online_reservation_limit integer NOT NULL CHECK (online_reservation_limit >= 0),
  batch_reservation_limit integer NOT NULL CHECK (batch_reservation_limit >= 0),
  daily_gpu_seconds_limit bigint CHECK (daily_gpu_seconds_limit IS NULL OR daily_gpu_seconds_limit >= 0),
  daily_cost_limit_minor bigint CHECK (daily_cost_limit_minor IS NULL OR daily_cost_limit_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  max_file_size_bytes bigint NOT NULL CHECK (max_file_size_bytes > 0),
  daily_upload_bytes_limit bigint NOT NULL CHECK (daily_upload_bytes_limit >= 0),
  active_file_bytes_limit bigint NOT NULL CHECK (active_file_bytes_limit >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admission_reservations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  api_key_id text NOT NULL REFERENCES api_keys(id),
  resource_type text NOT NULL CHECK (resource_type IN ('task', 'file_upload')),
  resource_id text NOT NULL,
  lane text CHECK (lane IN ('online', 'batch')),
  status text NOT NULL CHECK (status IN ('held', 'released')),
  estimated_gpu_seconds bigint NOT NULL DEFAULT 0 CHECK (estimated_gpu_seconds >= 0),
  estimated_cost_minor bigint NOT NULL DEFAULT 0 CHECK (estimated_cost_minor >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (project_id, resource_type, resource_id),
  CHECK ((status = 'released') = (released_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS admission_held_project_lane_idx
  ON admission_reservations(project_id, resource_type, lane, created_at, id) WHERE status = 'held';

CREATE TABLE IF NOT EXISTS usage_ledger (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  task_id text,
  reservation_id text REFERENCES admission_reservations(id),
  source_type text NOT NULL,
  source_id text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('gpu_seconds', 'cost_minor', 'upload_bytes', 'storage_byte_seconds')),
  quantity bigint NOT NULL CHECK (quantity >= 0),
  currency char(3),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, metric)
);
CREATE INDEX IF NOT EXISTS usage_ledger_project_day_idx ON usage_ledger(project_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('anonymous', 'api_key', 'oidc_user', 'service')),
  actor_id text,
  api_key_id text,
  organization_id text,
  project_id text,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  reason_code text,
  source_ip text,
  user_agent text,
  request_id text NOT NULL,
  trace_id text,
  purpose text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_org_created_idx ON audit_events(organization_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_project_created_idx ON audit_events(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_created_idx ON audit_events(actor_type, actor_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION astra_reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table';
END;
$$;

DROP TRIGGER IF EXISTS usage_ledger_append_only ON usage_ledger;
CREATE TRIGGER usage_ledger_append_only BEFORE UPDATE OR DELETE ON usage_ledger
FOR EACH ROW EXECUTE FUNCTION astra_reject_append_only_mutation();

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION astra_reject_append_only_mutation();

INSERT INTO organizations (id, name, status)
VALUES ('org_local', 'Astra Local', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects (id, organization_id, name, status)
VALUES ('project_local', 'org_local', 'Local Development', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO project_quotas (
  project_id, request_rate_per_minute, request_burst, task_rate_per_minute, task_burst,
  queued_task_limit, online_reservation_limit, batch_reservation_limit,
  daily_gpu_seconds_limit, daily_cost_limit_minor, currency,
  max_file_size_bytes, daily_upload_bytes_limit, active_file_bytes_limit
)
VALUES (
  'project_local', 600, 100, 120, 40,
  1000, 500, 500,
  864000, 10000000, 'CNY',
  5368709120, 53687091200, 107374182400
)
ON CONFLICT (project_id) DO NOTHING;

UPDATE model_releases
SET manifest = jsonb_set(
  manifest,
  '{admission_estimates}',
  '{"video":{"base_gpu_seconds":30,"per_output_second_gpu_seconds":54},"image":{"per_output_gpu_seconds":30},"cost_minor_per_gpu_second":0}'::jsonb,
  true
)
WHERE id = 'release_local_reference';
