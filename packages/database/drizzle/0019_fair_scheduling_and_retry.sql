-- Phase 11 service-time prediction, weighted fairness and bounded retry policy.

ALTER TABLE tasks ADD COLUMN scheduling_profile jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tasks ADD CONSTRAINT tasks_scheduling_profile_object_v1_check
  CHECK (jsonb_typeof(scheduling_profile) = 'object') NOT VALID;
ALTER TABLE tasks ADD COLUMN baseline_gpu_seconds integer NOT NULL DEFAULT 1 CHECK (baseline_gpu_seconds > 0);
ALTER TABLE tasks ADD COLUMN retry_not_before timestamptz;
ALTER TABLE tasks ADD COLUMN last_retry_reason text;
UPDATE tasks t SET baseline_gpu_seconds=GREATEST(1, LEAST(2147483647, reservation.estimated_gpu_seconds)::integer)
FROM admission_reservations reservation
WHERE reservation.resource_type='task' AND reservation.resource_id=t.id
  AND reservation.estimated_gpu_seconds > 0;
CREATE INDEX tasks_schedulable_retry_idx ON tasks(status, retry_not_before, created_at, id)
  WHERE status='queued';

ALTER TABLE attempts ADD COLUMN expected_gpu_seconds integer CHECK (expected_gpu_seconds IS NULL OR expected_gpu_seconds > 0);
ALTER TABLE attempts ADD COLUMN prediction_source text;
ALTER TABLE attempts ADD COLUMN retry_disposition text NOT NULL DEFAULT 'none';
ALTER TABLE attempts ADD COLUMN retry_not_before timestamptz;
ALTER TABLE attempts ADD CONSTRAINT attempts_retry_disposition_v1_check CHECK (retry_disposition IN (
  'none', 'scheduled', 'exhausted', 'not_retryable', 'asset_ttl', 'budget', 'canceled'
)) NOT VALID;
ALTER TABLE attempts ADD CONSTRAINT attempts_prediction_source_v1_check
  CHECK (prediction_source IS NULL OR prediction_source IN ('profile', 'cold_baseline')) NOT VALID;

ALTER TABLE project_quotas ADD COLUMN scheduling_weight integer NOT NULL DEFAULT 100
  CHECK (scheduling_weight BETWEEN 1 AND 10000);

CREATE TABLE service_time_samples (
  id text PRIMARY KEY,
  attempt_id text NOT NULL UNIQUE REFERENCES attempts(id),
  task_id text NOT NULL REFERENCES tasks(id),
  release_id text NOT NULL REFERENCES model_releases(id),
  pool_id text NOT NULL REFERENCES model_pools(id),
  gpu_sku text NOT NULL,
  dimensions_hash text NOT NULL CHECK (dimensions_hash ~ '^[0-9a-f]{64}$'),
  dimensions jsonb NOT NULL,
  service_seconds integer NOT NULL CHECK (service_seconds > 0),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'failed', 'canceled', 'abandoned')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (completed_at >= started_at)
);
CREATE INDEX service_time_samples_profile_idx
  ON service_time_samples(release_id, gpu_sku, dimensions_hash, completed_at DESC, id DESC);

CREATE TABLE service_time_profiles (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES model_releases(id),
  gpu_sku text NOT NULL,
  dimensions_hash text NOT NULL CHECK (dimensions_hash ~ '^[0-9a-f]{64}$'),
  dimensions jsonb NOT NULL,
  sample_count bigint NOT NULL CHECK (sample_count > 0),
  p75_seconds integer NOT NULL CHECK (p75_seconds > 0),
  p95_seconds integer NOT NULL CHECK (p95_seconds > 0),
  ewma_seconds integer NOT NULL CHECK (ewma_seconds > 0),
  last_service_seconds integer NOT NULL CHECK (last_service_seconds > 0),
  last_sample_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (release_id, gpu_sku, dimensions_hash)
);
CREATE INDEX service_time_profiles_release_gpu_idx
  ON service_time_profiles(release_id, gpu_sku, dimensions_hash);

CREATE TABLE project_scheduling_accounts (
  release_id text NOT NULL REFERENCES model_releases(id),
  project_id text NOT NULL REFERENCES projects(id),
  lane text NOT NULL CHECK (lane IN ('online', 'batch')),
  project_weight integer NOT NULL CHECK (project_weight BETWEEN 1 AND 10000),
  virtual_gpu_milliseconds bigint NOT NULL DEFAULT 0 CHECK (virtual_gpu_milliseconds >= 0),
  assigned_gpu_seconds bigint NOT NULL DEFAULT 0 CHECK (assigned_gpu_seconds >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (release_id, project_id, lane)
);

CREATE TABLE scheduler_lane_accounts (
  release_id text NOT NULL REFERENCES model_releases(id),
  lane text NOT NULL CHECK (lane IN ('online', 'batch')),
  window_started_at timestamptz NOT NULL,
  assigned_gpu_seconds bigint NOT NULL DEFAULT 0 CHECK (assigned_gpu_seconds >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (release_id, lane)
);

CREATE OR REPLACE FUNCTION astra_guard_service_time_sample_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_service_time_sample';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER service_time_samples_immutable BEFORE UPDATE OR DELETE ON service_time_samples
FOR EACH ROW EXECUTE FUNCTION astra_guard_service_time_sample_immutable();

ALTER TABLE tasks VALIDATE CONSTRAINT tasks_scheduling_profile_object_v1_check;
ALTER TABLE attempts VALIDATE CONSTRAINT attempts_retry_disposition_v1_check;
ALTER TABLE attempts VALIDATE CONSTRAINT attempts_prediction_source_v1_check;
