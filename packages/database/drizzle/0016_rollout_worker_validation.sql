-- Phase 10 Worker-originated rollout validation evidence.

ALTER TABLE worker_request_receipts DROP CONSTRAINT worker_request_receipts_operation_check;
ALTER TABLE worker_request_receipts ADD CONSTRAINT worker_request_receipts_operation_v2_check
  CHECK (operation IN ('lease', 'heartbeat', 'drained', 'rollout_validation'));

CREATE TABLE worker_rollout_validation_reports (
  id text PRIMARY KEY,
  rollout_id text NOT NULL REFERENCES model_rollouts(id),
  rollout_step_id text NOT NULL REFERENCES rollout_steps(id),
  replica_id text NOT NULL REFERENCES replicas(id),
  worker_id text NOT NULL REFERENCES workers(id),
  release_id text NOT NULL REFERENCES model_releases(id),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('passed', 'failed')),
  checks jsonb NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  failure_code text,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (worker_id, sequence),
  UNIQUE (rollout_step_id, worker_id)
);
CREATE INDEX worker_rollout_validation_rollout_idx
  ON worker_rollout_validation_reports(rollout_id, status, created_at, id);

CREATE TRIGGER worker_rollout_validation_reports_immutable
  BEFORE UPDATE OR DELETE ON worker_rollout_validation_reports
  FOR EACH ROW EXECUTE FUNCTION astra_guard_rollout_history_immutable();
