-- Phase 8 versioned Provider observation snapshots. PostgreSQL remains authoritative.

CREATE TABLE provider_snapshot_runs (
  id text PRIMARY KEY,
  provider text NOT NULL,
  contract_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('collecting', 'published', 'quarantined', 'failed')),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  object_count integer NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  quarantine_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK ((status='collecting') = (completed_at IS NULL))
);
CREATE INDEX provider_snapshot_runs_provider_observed_idx
  ON provider_snapshot_runs(provider, observed_at DESC, id DESC);
CREATE INDEX provider_snapshot_runs_attention_idx
  ON provider_snapshot_runs(status, observed_at DESC, id DESC)
  WHERE status IN ('quarantined', 'failed');

CREATE TABLE provider_snapshot_objects (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES provider_snapshot_runs(id),
  provider text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'resource', 'deployment', 'node', 'batch_job', 'image_prewarm_region', 'image_prewarm', 'billing'
  )),
  provider_resource_id text NOT NULL,
  normalized jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, kind, provider_resource_id)
);
CREATE INDEX provider_snapshot_objects_lookup_idx
  ON provider_snapshot_objects(provider, kind, provider_resource_id, observed_at DESC);

CREATE TABLE provider_snapshot_pages (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES provider_snapshot_runs(id),
  kind text NOT NULL,
  endpoint text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  redacted_payload jsonb NOT NULL,
  quarantine_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX provider_snapshot_pages_run_idx ON provider_snapshot_pages(run_id, kind, id);

CREATE TABLE provider_snapshot_state (
  provider text PRIMARY KEY,
  latest_attempt_run_id text NOT NULL REFERENCES provider_snapshot_runs(id),
  latest_published_run_id text REFERENCES provider_snapshot_runs(id),
  status text NOT NULL CHECK (status IN ('fresh', 'stale', 'quarantined', 'failed')),
  observed_at timestamptz,
  expires_at timestamptz,
  version integer NOT NULL CHECK (version > 0),
  last_error_code text,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX provider_inventory_provider_region_gpu_unique
  ON provider_inventory(provider, region_id, gpu_sku);

CREATE OR REPLACE FUNCTION astra_guard_provider_snapshot_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_provider_snapshot';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER provider_snapshot_objects_immutable
  BEFORE UPDATE OR DELETE ON provider_snapshot_objects
  FOR EACH ROW EXECUTE FUNCTION astra_guard_provider_snapshot_immutable();
CREATE TRIGGER provider_snapshot_pages_immutable
  BEFORE UPDATE OR DELETE ON provider_snapshot_pages
  FOR EACH ROW EXECUTE FUNCTION astra_guard_provider_snapshot_immutable();
