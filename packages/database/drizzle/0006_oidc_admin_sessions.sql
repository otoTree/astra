CREATE TABLE IF NOT EXISTS organization_memberships (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  subject_type text NOT NULL CHECK (subject_type IN ('oidc_user', 'oidc_group')),
  subject_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'operator', 'model_releaser', 'security_auditor', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, subject_type, subject_id, role)
);
CREATE INDEX IF NOT EXISTS organization_memberships_subject_idx
  ON organization_memberships(subject_type, subject_id, organization_id);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text,
  display_name text,
  oidc_groups text[] NOT NULL DEFAULT '{}',
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  oidc_token_hash text NOT NULL UNIQUE CHECK (oidc_token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS admin_sessions_subject_idx
  ON admin_sessions(issuer, subject, created_at DESC, id);
CREATE INDEX IF NOT EXISTS admin_sessions_active_expiry_idx
  ON admin_sessions(expires_at, id) WHERE status = 'active';

CREATE OR REPLACE FUNCTION astra_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'deletion_prohibited';
END;
$$;

DROP TRIGGER IF EXISTS admin_sessions_no_delete ON admin_sessions;
CREATE TRIGGER admin_sessions_no_delete BEFORE DELETE ON admin_sessions
FOR EACH ROW EXECUTE FUNCTION astra_reject_delete();

INSERT INTO organization_memberships (id, organization_id, subject_type, subject_id, role)
VALUES ('orgmem_local_admin_group', 'org_local', 'oidc_group', 'astra-local-admins', 'admin')
ON CONFLICT (organization_id, subject_type, subject_id, role) DO NOTHING;

INSERT INTO project_memberships (id, organization_id, project_id, subject_type, subject_id, role)
VALUES ('projmem_local_admin_group', 'org_local', 'project_local', 'oidc_group', 'astra-local-admins', 'admin')
ON CONFLICT (project_id, subject_type, subject_id, role) DO NOTHING;
