ALTER TABLE models ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id);
ALTER TABLE models ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE models ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK (version > 0);
UPDATE models SET project_id = 'project_local' WHERE project_id IS NULL;
ALTER TABLE models ALTER COLUMN project_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS models_project_alias_idx ON models(project_id, alias);

ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id);
ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS source_image text;
ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS manifest_digest text;
ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS manifest_media_type text;
ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS config_digest text;
ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved';
ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS created_by text;
UPDATE model_releases SET
  project_id = 'project_local',
  source_image = 'registry-reference:5000/astra/model-app@' || image_digest,
  manifest_digest = image_digest,
  manifest_media_type = 'application/vnd.oci.image.manifest.v1+json',
  config_digest = image_digest
WHERE project_id IS NULL;
ALTER TABLE model_releases ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE model_releases ALTER COLUMN source_image SET NOT NULL;
ALTER TABLE model_releases ALTER COLUMN manifest_digest SET NOT NULL;
ALTER TABLE model_releases ALTER COLUMN manifest_media_type SET NOT NULL;
ALTER TABLE model_releases ALTER COLUMN config_digest SET NOT NULL;
ALTER TABLE model_releases ADD CONSTRAINT model_releases_status_v1_check CHECK (status IN ('draft', 'approved', 'rejected', 'disabled'));
CREATE INDEX IF NOT EXISTS model_releases_project_created_idx ON model_releases(project_id, created_at DESC, id DESC);

ALTER TABLE model_pools ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id);
ALTER TABLE model_pools ADD COLUMN IF NOT EXISTS created_by text;
UPDATE model_pools SET project_id = 'project_local' WHERE project_id IS NULL;
ALTER TABLE model_pools ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS model_pools_project_created_idx ON model_pools(project_id, created_at DESC, id DESC);

ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id);
UPDATE provider_operations SET project_id = 'project_local' WHERE project_id IS NULL;
ALTER TABLE provider_operations ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS provider_operations_project_created_idx
  ON provider_operations(project_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS admin_idempotency_records (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  session_id text NOT NULL REFERENCES admin_sessions(id),
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, endpoint, idempotency_key)
);

CREATE TABLE IF NOT EXISTS model_alias_versions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  alias text NOT NULL,
  model_id text NOT NULL REFERENCES models(id),
  release_id text NOT NULL REFERENCES model_releases(id),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('active', 'superseded')),
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, alias, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS model_alias_versions_active_idx
  ON model_alias_versions(project_id, alias) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS release_approvals (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  release_id text NOT NULL REFERENCES model_releases(id),
  release_version integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, release_version)
);

CREATE TABLE IF NOT EXISTS policy_versions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  pool_id text NOT NULL REFERENCES model_pools(id),
  policy_type text NOT NULL CHECK (policy_type IN ('capacity', 'budget', 'region', 'retry')),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('validated', 'published', 'superseded')),
  configuration jsonb NOT NULL,
  validation jsonb NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (pool_id, policy_type, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS policy_versions_published_idx
  ON policy_versions(pool_id, policy_type) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS policy_impact_previews (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  policy_version_id text NOT NULL REFERENCES policy_versions(id),
  policy_version integer NOT NULL,
  snapshot jsonb NOT NULL,
  impact jsonb NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION astra_immutable_admin_history() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_admin_history';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS release_approvals_immutable ON release_approvals;
CREATE TRIGGER release_approvals_immutable BEFORE UPDATE OR DELETE ON release_approvals
FOR EACH ROW EXECUTE FUNCTION astra_immutable_admin_history();
DROP TRIGGER IF EXISTS policy_impact_previews_immutable ON policy_impact_previews;
CREATE TRIGGER policy_impact_previews_immutable BEFORE UPDATE OR DELETE ON policy_impact_previews
FOR EACH ROW EXECUTE FUNCTION astra_immutable_admin_history();

CREATE INDEX IF NOT EXISTS policy_versions_pool_created_idx ON policy_versions(pool_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS policy_previews_policy_created_idx ON policy_impact_previews(policy_version_id, created_at DESC, id DESC);
