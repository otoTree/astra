-- Phase 6 deterministic scheduling. Existing pre-phase-6 attempts are retained;
-- new active reservations must carry the complete assignment identity.

CREATE TABLE IF NOT EXISTS scheduling_decisions (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  release_id text NOT NULL REFERENCES model_releases(id),
  pool_id text NOT NULL REFERENCES model_pools(id),
  replica_id text NOT NULL REFERENCES replicas(id),
  worker_id text NOT NULL REFERENCES workers(id),
  task_version integer NOT NULL CHECK (task_version >= 0),
  replica_version integer NOT NULL CHECK (replica_version >= 0),
  slot_index integer NOT NULL CHECK (slot_index >= 0),
  policy_version text NOT NULL,
  reason text NOT NULL,
  input_snapshot jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('reserved')),
  decided_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduling_decisions_task_created_idx
  ON scheduling_decisions(task_id, decided_at, id);
CREATE INDEX IF NOT EXISTS scheduling_decisions_replica_created_idx
  ON scheduling_decisions(replica_id, decided_at, id);

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS attempt_no integer;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS pool_id text REFERENCES model_pools(id);
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS replica_id text REFERENCES replicas(id);
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS slot_index integer;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS decision_id text REFERENCES scheduling_decisions(id);
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS task_version_at_assignment integer;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz;

ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_status_v1_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_status_v1_check
  CHECK (status IN ('reserved', 'leased', 'running', 'unknown', 'completed', 'failed', 'canceled', 'expired', 'abandoned'))
  NOT VALID;
ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_phase6_assignment_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_phase6_assignment_check CHECK (
  decision_id IS NULL OR
  (attempt_no IS NOT NULL AND attempt_no > 0 AND pool_id IS NOT NULL AND replica_id IS NOT NULL
    AND slot_index IS NOT NULL AND slot_index >= 0 AND decision_id IS NOT NULL
    AND task_version_at_assignment IS NOT NULL AND reservation_expires_at IS NOT NULL)
) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS attempts_active_task_idx
  ON attempts(task_id) WHERE status IN ('reserved', 'leased', 'running', 'unknown');
CREATE UNIQUE INDEX IF NOT EXISTS attempts_active_replica_slot_idx
  ON attempts(replica_id, slot_index)
  WHERE replica_id IS NOT NULL AND slot_index IS NOT NULL
    AND status IN ('reserved', 'leased', 'running', 'unknown');
CREATE UNIQUE INDEX IF NOT EXISTS attempts_task_number_idx
  ON attempts(task_id, attempt_no) WHERE attempt_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS attempts_reservation_expiry_idx
  ON attempts(reservation_expires_at, id) WHERE status = 'reserved';

ALTER TABLE leases ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'reserved';
ALTER TABLE leases ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE leases ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE leases ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_status_v1_check;
ALTER TABLE leases ADD CONSTRAINT leases_status_v1_check
  CHECK (status IN ('reserved', 'active', 'unknown', 'released', 'expired', 'canceled')) NOT VALID;
CREATE INDEX IF NOT EXISTS leases_status_expiry_idx ON leases(status, expires_at, id);

CREATE OR REPLACE FUNCTION astra_guard_scheduling_decision_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_scheduling_decision';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS scheduling_decisions_immutable ON scheduling_decisions;
CREATE TRIGGER scheduling_decisions_immutable BEFORE UPDATE OR DELETE ON scheduling_decisions
FOR EACH ROW EXECUTE FUNCTION astra_guard_scheduling_decision_immutable();
