-- Phase 9 durable Provider operations and lease-based reconcile.

ALTER TABLE provider_operations ADD COLUMN desired_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE provider_operations ADD COLUMN provider_resource_id text;
ALTER TABLE provider_operations ADD COLUMN provider_state text;
ALTER TABLE provider_operations ADD COLUMN response_snapshot jsonb;
ALTER TABLE provider_operations ADD COLUMN lease_owner text;
ALTER TABLE provider_operations ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE provider_operations ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE provider_operations ADD COLUMN maximum_attempts integer NOT NULL DEFAULT 8;
ALTER TABLE provider_operations ADD COLUMN last_reconciled_at timestamptz;
ALTER TABLE provider_operations ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE provider_operations DROP CONSTRAINT IF EXISTS provider_operations_status_check;
ALTER TABLE provider_operations ADD CONSTRAINT provider_operations_status_v2_check
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'reconciling', 'suppressed'));
ALTER TABLE provider_operations ADD CONSTRAINT provider_operations_type_v2_check
  CHECK (operation_type IN ('prewarm', 'provision', 'drain', 'terminate')) NOT VALID;
ALTER TABLE provider_operations ADD CONSTRAINT provider_operations_attempts_v2_check
  CHECK (maximum_attempts BETWEEN 1 AND 100 AND retry_count BETWEEN 0 AND maximum_attempts);
ALTER TABLE provider_operations ADD CONSTRAINT provider_operations_lease_v2_check
  CHECK ((status IN ('running', 'reconciling')) = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)) NOT VALID;
ALTER TABLE provider_operations ADD CONSTRAINT provider_operations_version_v2_check CHECK (version > 0);
CREATE INDEX provider_operations_claim_v2_idx
  ON provider_operations(next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'running', 'reconciling');
CREATE INDEX provider_operations_resource_v2_idx
  ON provider_operations(provider, resource_type, resource_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION astra_guard_provider_operation_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.provider <> OLD.provider OR NEW.operation_key <> OLD.operation_key OR
     NEW.operation_type <> OLD.operation_type OR NEW.request_hash <> OLD.request_hash OR
     NEW.desired_payload <> OLD.desired_payload OR NEW.resource_type IS DISTINCT FROM OLD.resource_type OR
     NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'immutable_provider_operation_identity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER provider_operations_identity_immutable
  BEFORE UPDATE ON provider_operations
  FOR EACH ROW EXECUTE FUNCTION astra_guard_provider_operation_identity();
