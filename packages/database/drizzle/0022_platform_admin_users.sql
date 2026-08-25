CREATE TABLE IF NOT EXISTS admin_users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text,
  email text,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(username) BETWEEN 3 AND 128),
  CHECK (length(password_hash) >= 20)
);
CREATE INDEX IF NOT EXISTS admin_users_status_idx ON admin_users(status, username);

ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS organization_memberships_subject_type_check;
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_subject_type_check
  CHECK (subject_type IN ('local_user', 'oidc_user', 'oidc_group'));
ALTER TABLE project_memberships DROP CONSTRAINT IF EXISTS project_memberships_subject_type_check;
ALTER TABLE project_memberships ADD CONSTRAINT project_memberships_subject_type_check
  CHECK (subject_type IN ('local_user', 'oidc_user', 'oidc_group'));

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_type_check
  CHECK (actor_type IN ('anonymous', 'api_key', 'admin_user', 'oidc_user', 'service'));

ALTER TABLE rollout_events DROP CONSTRAINT IF EXISTS rollout_events_actor_type_check;
ALTER TABLE rollout_events ADD CONSTRAINT rollout_events_actor_type_check
  CHECK (actor_type IN ('admin_user', 'oidc_user', 'controller', 'worker'));
