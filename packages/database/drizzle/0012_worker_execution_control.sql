-- Phase 7 Worker identity, execution control and byte-preserving output commit.

ALTER TABLE files ALTER COLUMN size_bytes TYPE bigint;

ALTER TABLE workers ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS region_id text REFERENCES provider_regions(id);
ALTER TABLE workers ADD COLUMN IF NOT EXISTS provider_instance_id text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS pool_id text REFERENCES model_pools(id);
ALTER TABLE workers ADD COLUMN IF NOT EXISTS instance_fingerprint text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS hardware jsonb;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS capabilities_hash text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS desired_state text NOT NULL DEFAULT 'run';
ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS unknown_since timestamptz;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS drained_at timestamptz;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS reclaim_token_hash text;
ALTER TABLE workers ADD CONSTRAINT workers_desired_state_v1_check
  CHECK (desired_state IN ('run', 'cancel', 'drain', 'shutdown')) NOT VALID;
ALTER TABLE workers ADD CONSTRAINT workers_capabilities_hash_v1_check
  CHECK (capabilities_hash IS NULL OR capabilities_hash ~ '^[0-9a-f]{64}$') NOT VALID;
CREATE INDEX IF NOT EXISTS workers_unknown_idx
  ON workers(unknown_since, id) WHERE status='unknown';

CREATE TABLE IF NOT EXISTS worker_bootstrap_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  replica_id text NOT NULL REFERENCES replicas(id),
  release_id text NOT NULL REFERENCES model_releases(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX IF NOT EXISTS worker_bootstrap_tokens_open_idx
  ON worker_bootstrap_tokens(expires_at, id) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS worker_sessions (
  id text PRIMARY KEY,
  worker_id text NOT NULL REFERENCES workers(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  instance_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'rotated', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  replaced_by_id text REFERENCES worker_sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CHECK ((status='active') = (ended_at IS NULL))
);
CREATE INDEX IF NOT EXISTS worker_sessions_worker_status_idx
  ON worker_sessions(worker_id, status, expires_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS worker_request_receipts (
  worker_id text NOT NULL REFERENCES workers(id),
  operation text NOT NULL CHECK (operation IN ('lease', 'heartbeat', 'drained')),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, operation, sequence)
);

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS progress integer;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS output_manifest jsonb;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS output_manifest_hash text;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS outputs_status text NOT NULL DEFAULT 'none';
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS usage jsonb;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS failure_code text;
ALTER TABLE attempts ADD CONSTRAINT attempts_progress_v1_check
  CHECK (progress IS NULL OR progress BETWEEN 0 AND 100) NOT VALID;
ALTER TABLE attempts ADD CONSTRAINT attempts_outputs_status_v1_check
  CHECK (outputs_status IN ('none', 'prepared', 'committed')) NOT VALID;
ALTER TABLE attempts ADD CONSTRAINT attempts_output_manifest_hash_v1_check
  CHECK (output_manifest_hash IS NULL OR output_manifest_hash ~ '^[0-9a-f]{64}$') NOT VALID;

CREATE TABLE IF NOT EXISTS attempt_output_files (
  attempt_id text NOT NULL REFERENCES attempts(id),
  output_index integer NOT NULL CHECK (output_index >= 0),
  file_id text NOT NULL UNIQUE REFERENCES files(id),
  role text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media jsonb NOT NULL,
  provenance jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared', 'committed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  PRIMARY KEY (attempt_id, output_index),
  CHECK ((status='committed') = (committed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS attempt_output_files_status_idx
  ON attempt_output_files(status, created_at, attempt_id);

CREATE OR REPLACE FUNCTION astra_guard_worker_receipt_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_worker_request_receipt';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS worker_request_receipts_immutable ON worker_request_receipts;
CREATE TRIGGER worker_request_receipts_immutable BEFORE UPDATE OR DELETE ON worker_request_receipts
FOR EACH ROW EXECUTE FUNCTION astra_guard_worker_receipt_immutable();
