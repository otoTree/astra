import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

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
  actorType: "anonymous" | "api_key" | "oidc_user" | "service";
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
}
