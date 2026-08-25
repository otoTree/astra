import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;
type TransactionClient = postgres.TransactionSql;

export type ApiKeyCandidate = Readonly<{
  id: string;
  organizationId: string;
  defaultProjectId: string;
  keyPrefix: string;
  secretHash: string;
  scopes: readonly string[];
  status: "active" | "revoked";
  expiresAt: Date | string | null;
  organizationStatus: "active" | "suspended";
  projectStatus: "active" | "suspended";
  grantedProjectIds: readonly string[];
}>;

export type ProjectRatePolicy = Readonly<{
  requestRatePerMinute: number;
  requestBurst: number;
  taskRatePerMinute: number;
  taskBurst: number;
}>;

export type AuditEventInput = Readonly<{
  id: string;
  actorType: "anonymous" | "api_key" | "admin_user" | "oidc_user" | "service";
  actorId?: string;
  apiKeyId?: string;
  organizationId?: string;
  projectId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  outcome: "success" | "denied" | "failure";
  reasonCode?: string;
  sourceIp?: string;
  userAgent?: string;
  requestId: string;
  traceId?: string;
  purpose?: string;
  details?: Readonly<Record<string, unknown>>;
  signature: string;
  createdAt: Date;
}>;

export type StoredApiKeyInput = Readonly<{
  id: string;
  organizationId: string;
  defaultProjectId: string;
  name: string;
  keyPrefix: string;
  keyLastFour: string;
  secretHash: string;
  scopes: readonly string[];
  projectIds: readonly string[];
  expiresAt?: Date;
  createdAt: Date;
}>;

export type AdminRole = "viewer" | "operator" | "model_releaser" | "security_auditor" | "admin";

export type LocalAdminUser = Readonly<{
  id: string;
  username: string;
  passwordHash: string;
  displayName: string | null;
  email: string | null;
  status: "active" | "disabled";
  organizationId: string;
  projectId: string;
  failedAttempts: number;
  lockedUntil: Date | string | null;
}>;

export type VerifiedOidcIdentityInput = Readonly<{
  issuer: string;
  subject: string;
  audience: readonly string[];
  groups: readonly string[];
  email: string | null;
  displayName: string | null;
  expiresAt: Date;
  tokenHash: string;
}>;

export type AdminSessionRecord = Readonly<{
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  organizationId: string;
  projectId: string;
  organizationRoles: readonly AdminRole[];
  projectRoles: readonly AdminRole[];
  csrfHash: string;
  status: "active" | "revoked";
  organizationStatus: "active" | "suspended";
  projectStatus: "active" | "suspended";
  createdAt: Date | string;
  expiresAt: Date | string;
}>;

const candidate = (row: Record<string, unknown>): ApiKeyCandidate => ({
  id: String(row.id),
  organizationId: String(row.organization_id),
  defaultProjectId: String(row.default_project_id),
  keyPrefix: String(row.key_prefix),
  secretHash: String(row.secret_hash),
  scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
  status: row.status as ApiKeyCandidate["status"],
  expiresAt: (row.expires_at as Date | string | null) ?? null,
  organizationStatus: row.organization_status as ApiKeyCandidate["organizationStatus"],
  projectStatus: row.project_status as ApiKeyCandidate["projectStatus"],
  grantedProjectIds: Array.isArray(row.granted_project_ids) ? row.granted_project_ids.map(String) : [],
});

const adminSession = (row: Record<string, unknown>): AdminSessionRecord => ({
  id: String(row.id),
  issuer: String(row.issuer),
  subject: String(row.subject),
  email: row.email === null || row.email === undefined ? null : String(row.email),
  displayName: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
  organizationId: String(row.organization_id),
  projectId: String(row.project_id),
  organizationRoles: (Array.isArray(row.organization_roles) ? row.organization_roles : []).map(String) as AdminRole[],
  projectRoles: (Array.isArray(row.project_roles) ? row.project_roles : []).map(String) as AdminRole[],
  csrfHash: String(row.csrf_hash),
  status: row.status as AdminSessionRecord["status"],
  organizationStatus: row.organization_status as AdminSessionRecord["organizationStatus"],
  projectStatus: row.project_status as AdminSessionRecord["projectStatus"],
  createdAt: row.created_at as Date | string,
  expiresAt: row.expires_at as Date | string,
});

const localAdminUser = (row: Record<string, unknown>): LocalAdminUser => ({
  id: String(row.id),
  username: String(row.username),
  passwordHash: String(row.password_hash),
  displayName: row.display_name == null ? null : String(row.display_name),
  email: row.email == null ? null : String(row.email),
  status: row.status as LocalAdminUser["status"],
  organizationId: String(row.organization_id),
  projectId: String(row.project_id),
  failedAttempts: Number(row.failed_attempts ?? 0),
  lockedUntil: (row.locked_until as Date | string | null) ?? null,
});

export class IdentityRepository {
  constructor(private readonly sql: SqlClient) {}

  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyCandidate | undefined> {
    const rows = await this.sql`SELECT k.*, o.status AS organization_status, p.status AS project_status,
      ARRAY(
        SELECT g.project_id FROM api_key_project_grants g
        JOIN projects gp ON gp.id=g.project_id
        WHERE g.api_key_id=k.id AND gp.organization_id=k.organization_id AND gp.status='active'
        ORDER BY g.project_id
      ) AS granted_project_ids
      FROM api_keys k
      JOIN organizations o ON o.id=k.organization_id
      JOIN projects p ON p.id=k.default_project_id AND p.organization_id=k.organization_id
      WHERE k.key_prefix=${prefix}
      LIMIT 1`;
    return rows[0] ? candidate(rows[0] as Record<string, unknown>) : undefined;
  }

  async getProjectRatePolicy(projectId: string): Promise<ProjectRatePolicy | undefined> {
    const rows = await this.sql`SELECT request_rate_per_minute, request_burst, task_rate_per_minute, task_burst
      FROM project_quotas WHERE project_id=${projectId}`;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      requestRatePerMinute: Number(row.request_rate_per_minute),
      requestBurst: Number(row.request_burst),
      taskRatePerMinute: Number(row.task_rate_per_minute),
      taskBurst: Number(row.task_burst),
    };
  }

  async touchApiKey(apiKeyId: string, usedAt: Date): Promise<void> {
    await this.sql`UPDATE api_keys SET last_used_at=${usedAt.toISOString()}, updated_at=${usedAt.toISOString()}
      WHERE id=${apiKeyId}
        AND (last_used_at IS NULL OR last_used_at < ${new Date(usedAt.getTime() - 5 * 60 * 1000).toISOString()})`;
  }

  async insertAuditEvent(event: AuditEventInput): Promise<void> {
    await this.sql`INSERT INTO audit_events (
      id, actor_type, actor_id, api_key_id, organization_id, project_id, action,
      resource_type, resource_id, outcome, reason_code, source_ip, user_agent,
      request_id, trace_id, purpose, details, signature, created_at
    ) VALUES (
      ${event.id}, ${event.actorType}, ${event.actorId ?? null}, ${event.apiKeyId ?? null},
      ${event.organizationId ?? null}, ${event.projectId ?? null}, ${event.action},
      ${event.resourceType ?? null}, ${event.resourceId ?? null}, ${event.outcome},
      ${event.reasonCode ?? null}, ${event.sourceIp ?? null}, ${event.userAgent ?? null},
      ${event.requestId}, ${event.traceId ?? null}, ${event.purpose ?? null},
      ${JSON.stringify(event.details ?? {})}, ${event.signature}, ${event.createdAt.toISOString()}
    )`;
  }

  async ensureLocalAdminUser(input: {
    id: string;
    username: string;
    passwordHash: string;
    displayName: string;
    organizationId: string;
    projectId: string;
    createdAt: Date;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`SELECT id FROM organizations WHERE id=${input.organizationId} AND status='active' FOR SHARE`;
      await transaction`SELECT id FROM projects WHERE id=${input.projectId} AND organization_id=${input.organizationId} AND status='active' FOR SHARE`;
      await transaction`INSERT INTO admin_users (
        id, username, password_hash, display_name, status, organization_id, project_id, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.username}, ${input.passwordHash}, ${input.displayName}, 'active',
        ${input.organizationId}, ${input.projectId}, ${input.createdAt.toISOString()}, ${input.createdAt.toISOString()}
      ) ON CONFLICT (username) DO NOTHING`;
      await transaction`INSERT INTO organization_memberships
        (id, organization_id, subject_type, subject_id, role, created_at)
        VALUES (${`orgmem_local_${input.username}`}, ${input.organizationId}, 'local_user', ${input.username}, 'admin', now())
        ON CONFLICT (organization_id, subject_type, subject_id, role) DO NOTHING`;
      await transaction`INSERT INTO project_memberships
        (id, organization_id, project_id, subject_type, subject_id, role, created_at)
        VALUES (${`projmem_local_${input.username}`}, ${input.organizationId}, ${input.projectId}, 'local_user', ${input.username}, 'admin', now())
        ON CONFLICT (project_id, subject_type, subject_id, role) DO NOTHING`;
    });
  }

  async findLocalAdminUser(username: string): Promise<LocalAdminUser | undefined> {
    const rows = await this.sql`SELECT * FROM admin_users WHERE username=${username} LIMIT 1`;
    return rows[0] ? localAdminUser(rows[0] as Record<string, unknown>) : undefined;
  }

  async recordLocalAdminFailure(userId: string, now: Date, lockSeconds: number, maxFailures: number): Promise<void> {
    await this.sql`UPDATE admin_users
      SET failed_attempts = failed_attempts + 1,
          locked_until = CASE WHEN failed_attempts + 1 >= ${maxFailures}
            THEN ${new Date(now.getTime() + lockSeconds * 1000).toISOString()} ELSE locked_until END,
          updated_at=${now.toISOString()}
      WHERE id=${userId} AND status='active'`;
  }

  async resetLocalAdminFailures(userId: string, now: Date): Promise<void> {
    await this.sql`UPDATE admin_users
      SET failed_attempts=0, locked_until=NULL, last_login_at=${now.toISOString()}, updated_at=${now.toISOString()}
      WHERE id=${userId} AND status='active'`;
  }

  async createApiKey(input: StoredApiKeyInput): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const uniqueProjects = [...new Set(input.projectIds)];
      const projects = await transaction`SELECT id FROM projects
        WHERE organization_id=${input.organizationId} AND id=ANY(${this.sql.array(uniqueProjects)}::text[])
        ORDER BY id FOR SHARE`;
      if (projects.length !== uniqueProjects.length) throw new Error("project_access_denied");
      if (!uniqueProjects.includes(input.defaultProjectId)) throw new Error("default_project_not_granted");
      await transaction`INSERT INTO api_keys (
        id, organization_id, default_project_id, name, key_prefix, key_last_four,
        secret_hash, scopes, status, expires_at, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.organizationId}, ${input.defaultProjectId}, ${input.name},
        ${input.keyPrefix}, ${input.keyLastFour}, ${input.secretHash}, ${this.sql.array([...input.scopes])},
        'active', ${input.expiresAt?.toISOString() ?? null}, ${input.createdAt.toISOString()}, ${input.createdAt.toISOString()}
      )`;
      for (const projectId of uniqueProjects) {
        await transaction`INSERT INTO api_key_project_grants (api_key_id, project_id, created_at)
          VALUES (${input.id}, ${projectId}, ${input.createdAt.toISOString()})`;
      }
    });
  }

  async revokeApiKey(apiKeyId: string, revokedAt: Date): Promise<boolean> {
    const rows = await this.sql`UPDATE api_keys
      SET status='revoked', revoked_at=${revokedAt.toISOString()}, updated_at=${revokedAt.toISOString()}
      WHERE id=${apiKeyId} AND status='active' RETURNING id`;
    return rows.length === 1;
  }

  async createAdminSession(input: {
    id: string;
    identity: VerifiedOidcIdentityInput;
    organizationId: string;
    projectId: string;
    tokenHash: string;
    csrfHash: string;
    expiresAt: Date;
    createdAt: Date;
    auditEvent: AuditEventInput;
  }): Promise<AdminSessionRecord> {
    return this.sql.begin(async (transaction) => {
      const exchanged = await transaction`SELECT id FROM admin_sessions
        WHERE oidc_token_hash=${input.identity.tokenHash} FOR SHARE`;
      if (exchanged.length > 0) throw new Error("oidc_token_already_exchanged");
      const groups = [...new Set(input.identity.groups)];
      const access = await transaction`SELECT o.status AS organization_status, p.status AS project_status,
        ARRAY(
          SELECT DISTINCT om.role FROM organization_memberships om
          WHERE om.organization_id=o.id AND (
            (om.subject_type IN ('local_user', 'oidc_user') AND om.subject_id=${input.identity.subject}) OR
            (om.subject_type='oidc_group' AND om.subject_id=ANY(${this.sql.array(groups)}::text[]))
          ) ORDER BY om.role
        ) AS organization_roles,
        ARRAY(
          SELECT DISTINCT pm.role FROM project_memberships pm
          WHERE pm.organization_id=o.id AND pm.project_id=p.id AND (
            (pm.subject_type IN ('local_user', 'oidc_user') AND pm.subject_id=${input.identity.subject}) OR
            (pm.subject_type='oidc_group' AND pm.subject_id=ANY(${this.sql.array(groups)}::text[]))
          ) ORDER BY pm.role
        ) AS project_roles
        FROM organizations o
        JOIN projects p ON p.id=${input.projectId} AND p.organization_id=o.id
        WHERE o.id=${input.organizationId}
        FOR SHARE OF o, p`;
      const selected = access[0] as Record<string, unknown> | undefined;
      const organizationRoles = Array.isArray(selected?.organization_roles) ? selected.organization_roles : [];
      const projectRoles = Array.isArray(selected?.project_roles) ? selected.project_roles : [];
      if (
        selected?.organization_status !== "active" ||
        selected.project_status !== "active" ||
        organizationRoles.length === 0 ||
        projectRoles.length === 0
      ) {
        throw new Error("admin_membership_denied");
      }
      try {
        await transaction`INSERT INTO admin_sessions (
          id, issuer, subject, email, display_name, oidc_groups, organization_id, project_id,
          token_hash, csrf_hash, oidc_token_hash, status, expires_at, created_at
        ) VALUES (
          ${input.id}, ${input.identity.issuer}, ${input.identity.subject}, ${input.identity.email},
          ${input.identity.displayName}, ${this.sql.array(groups)}, ${input.organizationId}, ${input.projectId},
          ${input.tokenHash}, ${input.csrfHash}, ${input.identity.tokenHash}, 'active',
          ${input.expiresAt.toISOString()}, ${input.createdAt.toISOString()}
        )`;
        await this.insertAuditEventWith(transaction, input.auditEvent);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") {
          throw new Error("oidc_token_already_exchanged");
        }
        throw error;
      }
      return adminSession({
        id: input.id,
        issuer: input.identity.issuer,
        subject: input.identity.subject,
        email: input.identity.email,
        display_name: input.identity.displayName,
        organization_id: input.organizationId,
        project_id: input.projectId,
        organization_roles: organizationRoles,
        project_roles: projectRoles,
        csrf_hash: input.csrfHash,
        status: "active",
        organization_status: selected.organization_status,
        project_status: selected.project_status,
        created_at: input.createdAt,
        expires_at: input.expiresAt,
      });
    });
  }

  async findAdminSession(tokenHash: string): Promise<AdminSessionRecord | undefined> {
    const rows = await this.sql`SELECT s.*, o.status AS organization_status, p.status AS project_status,
      ARRAY(
        SELECT DISTINCT om.role FROM organization_memberships om
        WHERE om.organization_id=s.organization_id AND (
          (om.subject_type IN ('local_user', 'oidc_user') AND om.subject_id=s.subject) OR
          (om.subject_type='oidc_group' AND om.subject_id=ANY(s.oidc_groups))
        ) ORDER BY om.role
      ) AS organization_roles,
      ARRAY(
        SELECT DISTINCT pm.role FROM project_memberships pm
        WHERE pm.organization_id=s.organization_id AND pm.project_id=s.project_id AND (
          (pm.subject_type IN ('local_user', 'oidc_user') AND pm.subject_id=s.subject) OR
          (pm.subject_type='oidc_group' AND pm.subject_id=ANY(s.oidc_groups))
        ) ORDER BY pm.role
      ) AS project_roles
      FROM admin_sessions s
      JOIN organizations o ON o.id=s.organization_id
      JOIN projects p ON p.id=s.project_id AND p.organization_id=s.organization_id
      WHERE s.token_hash=${tokenHash}
      LIMIT 1`;
    return rows[0] ? adminSession(rows[0] as Record<string, unknown>) : undefined;
  }

  async touchAdminSession(sessionId: string, usedAt: Date): Promise<void> {
    await this.sql`UPDATE admin_sessions SET last_seen_at=${usedAt.toISOString()}
      WHERE id=${sessionId} AND status='active'
        AND (last_seen_at IS NULL OR last_seen_at < ${new Date(usedAt.getTime() - 5 * 60 * 1000).toISOString()})`;
  }

  async revokeAdminSession(sessionId: string, revokedAt: Date, auditEvent: AuditEventInput): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`UPDATE admin_sessions
        SET status='revoked', revoked_at=${revokedAt.toISOString()}
        WHERE id=${sessionId} AND status='active' RETURNING id`;
      if (rows.length === 0) return false;
      await this.insertAuditEventWith(transaction, auditEvent);
      return true;
    });
  }

  private async insertAuditEventWith(sql: SqlClient | TransactionClient, event: AuditEventInput): Promise<void> {
    await sql`INSERT INTO audit_events (
      id, actor_type, actor_id, api_key_id, organization_id, project_id, action,
      resource_type, resource_id, outcome, reason_code, source_ip, user_agent,
      request_id, trace_id, purpose, details, signature, created_at
    ) VALUES (
      ${event.id}, ${event.actorType}, ${event.actorId ?? null}, ${event.apiKeyId ?? null},
      ${event.organizationId ?? null}, ${event.projectId ?? null}, ${event.action},
      ${event.resourceType ?? null}, ${event.resourceId ?? null}, ${event.outcome},
      ${event.reasonCode ?? null}, ${event.sourceIp ?? null}, ${event.userAgent ?? null},
      ${event.requestId}, ${event.traceId ?? null}, ${event.purpose ?? null},
      ${JSON.stringify(event.details ?? {})}, ${event.signature}, ${event.createdAt.toISOString()}
    )`;
  }
}
