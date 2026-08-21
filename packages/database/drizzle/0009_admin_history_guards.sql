CREATE OR REPLACE FUNCTION astra_guard_model_release_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.model_id IS DISTINCT FROM NEW.model_id
    OR OLD.alias IS DISTINCT FROM NEW.alias
    OR OLD.source_image IS DISTINCT FROM NEW.source_image
    OR OLD.image_digest IS DISTINCT FROM NEW.image_digest
    OR OLD.workflow_hash IS DISTINCT FROM NEW.workflow_hash
    OR OLD.manifest IS DISTINCT FROM NEW.manifest
    OR OLD.manifest_digest IS DISTINCT FROM NEW.manifest_digest
    OR OLD.manifest_media_type IS DISTINCT FROM NEW.manifest_media_type
    OR OLD.config_digest IS DISTINCT FROM NEW.config_digest
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'immutable_model_release_metadata';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS model_release_metadata_guard ON model_releases;
CREATE TRIGGER model_release_metadata_guard BEFORE UPDATE ON model_releases
FOR EACH ROW EXECUTE FUNCTION astra_guard_model_release_immutable();

CREATE OR REPLACE FUNCTION astra_guard_policy_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.pool_id IS DISTINCT FROM NEW.pool_id
    OR OLD.policy_type IS DISTINCT FROM NEW.policy_type
    OR OLD.version IS DISTINCT FROM NEW.version
    OR OLD.configuration IS DISTINCT FROM NEW.configuration
    OR OLD.validation IS DISTINCT FROM NEW.validation
    OR OLD.reason IS DISTINCT FROM NEW.reason
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'immutable_policy_version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS policy_version_guard ON policy_versions;
CREATE TRIGGER policy_version_guard BEFORE UPDATE ON policy_versions
FOR EACH ROW EXECUTE FUNCTION astra_guard_policy_version_immutable();

CREATE OR REPLACE FUNCTION astra_guard_alias_version_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable_alias_version'; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.alias IS DISTINCT FROM NEW.alias
    OR OLD.model_id IS DISTINCT FROM NEW.model_id
    OR OLD.release_id IS DISTINCT FROM NEW.release_id
    OR OLD.version IS DISTINCT FROM NEW.version
    OR OLD.reason IS DISTINCT FROM NEW.reason
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR NOT (OLD.status = 'active' AND NEW.status = 'superseded')
  THEN
    RAISE EXCEPTION 'immutable_alias_version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS alias_version_history_guard ON model_alias_versions;
CREATE TRIGGER alias_version_history_guard BEFORE UPDATE OR DELETE ON model_alias_versions
FOR EACH ROW EXECUTE FUNCTION astra_guard_alias_version_history();

DROP TRIGGER IF EXISTS admin_idempotency_append_only ON admin_idempotency_records;
CREATE TRIGGER admin_idempotency_append_only BEFORE UPDATE OR DELETE ON admin_idempotency_records
FOR EACH ROW EXECUTE FUNCTION astra_immutable_admin_history();

DROP TRIGGER IF EXISTS policy_versions_no_delete ON policy_versions;
CREATE TRIGGER policy_versions_no_delete BEFORE DELETE ON policy_versions
FOR EACH ROW EXECUTE FUNCTION astra_immutable_admin_history();
