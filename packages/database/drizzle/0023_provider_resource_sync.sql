-- Operator-triggered Provider resource refreshes. The Admin API records intent;
-- only Provider Controller calls the external Provider and publishes snapshots.

CREATE TABLE provider_sync_requests (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  reason text NOT NULL,
  requested_by text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  snapshot_run_id text REFERENCES provider_snapshot_runs(id),
  error_code text,
  lease_owner text,
  lease_expires_at timestamptz,
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL))
);

CREATE INDEX provider_sync_requests_claim_idx
  ON provider_sync_requests(provider, status, requested_at, id)
  WHERE status IN ('pending', 'running');
CREATE INDEX provider_sync_requests_project_idx
  ON provider_sync_requests(project_id, created_at DESC, id DESC);
