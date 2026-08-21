-- Phase 10 encrypted, short-lived Provider operation environment material.

CREATE TABLE provider_operation_secrets (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  operation_key text NOT NULL UNIQUE,
  environment_ciphertext text NOT NULL,
  environment_hash text NOT NULL CHECK (environment_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX provider_operation_secrets_expiry_idx
  ON provider_operation_secrets(expires_at, id) WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION astra_guard_provider_operation_secret_identity() RETURNS trigger AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.operation_key IS DISTINCT FROM NEW.operation_key
    OR OLD.environment_ciphertext IS DISTINCT FROM NEW.environment_ciphertext
    OR OLD.environment_hash IS DISTINCT FROM NEW.environment_hash
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'immutable_provider_operation_secret';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND OLD.consumed_at IS DISTINCT FROM NEW.consumed_at THEN
    RAISE EXCEPTION 'provider_operation_secret_already_consumed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER provider_operation_secrets_identity_immutable
  BEFORE UPDATE ON provider_operation_secrets
  FOR EACH ROW EXECUTE FUNCTION astra_guard_provider_operation_secret_identity();
CREATE TRIGGER provider_operation_secrets_delete_forbidden
  BEFORE DELETE ON provider_operation_secrets
  FOR EACH ROW EXECUTE FUNCTION astra_guard_rollout_history_immutable();
