import { createHash, createHmac, randomBytes } from "node:crypto";

export * from "./admin.ts";

export const publicApiScopes = [
  "generations:create",
  "tasks:read",
  "tasks:cancel",
  "tasks:read_sensitive",
  "files:write",
  "files:read",
  "models:read",
] as const;

export type PublicApiScope = (typeof publicApiScopes)[number];

export type ProjectRatePolicy = Readonly<{
  requestRatePerMinute: number;
  requestBurst: number;
  taskRatePerMinute: number;
  taskBurst: number;
}>;

export type ProjectContext = Readonly<{
  actorType: "api_key";
  actorId: string;
  apiKeyId: string;
  organizationId: string;
  projectId: string;
  scopes: readonly string[];
  ratePolicy: ProjectRatePolicy;
}>;

export type AdminRole = "viewer" | "operator" | "model_releaser" | "security_auditor" | "admin";

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

export type AuditEvent = Readonly<{
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

export interface IdentityStore {
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyCandidate | undefined>;
  getProjectRatePolicy(projectId: string): Promise<ProjectRatePolicy | undefined>;
  touchApiKey(apiKeyId: string, usedAt: Date): Promise<void>;
  insertAuditEvent(event: AuditEvent): Promise<void>;
  createApiKey(input: {
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
  }): Promise<void>;
  revokeApiKey(apiKeyId: string, revokedAt: Date): Promise<boolean>;
}

export interface PublicRequestAuthenticator {
  authenticate(request: Request, requestId: string): Promise<ProjectContext>;
  authorize(context: ProjectContext, scope: PublicApiScope, request: Request, requestId: string): Promise<void>;
  recordOutcome(
    context: ProjectContext,
    request: Request,
    requestId: string,
    outcome: Readonly<{ action: string; status: number; reasonCode: string }>,
  ): Promise<void>;
}

export class AuthenticationError extends Error {
  constructor(
    readonly code:
      | "invalid_api_key"
      | "expired_api_key"
      | "revoked_api_key"
      | "organization_suspended"
      | "project_suspended"
      | "project_access_denied"
      | "project_quota_not_configured"
      | "insufficient_scope",
    readonly status: 401 | 403,
  ) {
    super(code);
  }
}

const keyPattern = /^astra_sk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const authorizationPattern = /^Bearer ([^\s]+)$/;

const sourceIp = (request: Request): string | undefined =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || undefined;

const auditPayload = (event: Omit<AuditEvent, "signature">): string =>
  JSON.stringify({
    id: event.id,
    actor_type: event.actorType,
    actor_id: event.actorId ?? null,
    api_key_id: event.apiKeyId ?? null,
    organization_id: event.organizationId ?? null,
    project_id: event.projectId ?? null,
    action: event.action,
    resource_type: event.resourceType ?? null,
    resource_id: event.resourceId ?? null,
    outcome: event.outcome,
    reason_code: event.reasonCode ?? null,
    source_ip: event.sourceIp ?? null,
    user_agent: event.userAgent ?? null,
    request_id: event.requestId,
    trace_id: event.traceId ?? null,
    purpose: event.purpose ?? null,
    details: event.details ?? {},
    created_at: event.createdAt.toISOString(),
  });

export class PublicApiAuthenticator {
  private readonly auditKey: Buffer;
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly store: IdentityStore,
    options: Readonly<{ auditSigningKey: string; now?: () => Date; createId?: (prefix: string) => string }>,
  ) {
    this.auditKey = createHash("sha256").update(options.auditSigningKey).digest();
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${Bun.randomUUIDv7()}`);
  }

  private async audit(event: Omit<AuditEvent, "id" | "signature" | "createdAt">): Promise<void> {
    const unsigned = { ...event, id: this.createId("audit"), createdAt: this.now() };
    const signature = createHmac("sha256", this.auditKey).update(auditPayload(unsigned)).digest("base64url");
    await this.store.insertAuditEvent({ ...unsigned, signature });
  }

  private requestAudit(request: Request, requestId: string) {
    const ip = sourceIp(request);
    const userAgent = request.headers.get("user-agent");
    const traceId = request.headers.get("traceparent");
    return {
      action: "public_api.authenticate",
      requestId,
      ...(ip ? { sourceIp: ip } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(traceId ? { traceId } : {}),
    };
  }

  async authenticate(request: Request, requestId: string): Promise<ProjectContext> {
    const authorization = request.headers.get("authorization");
    const bearer = authorization?.match(authorizationPattern)?.[1];
    const parsed = bearer?.match(keyPattern);
    if (!bearer || !parsed?.[1]) {
      await this.audit({
        ...this.requestAudit(request, requestId),
        actorType: "anonymous",
        outcome: "denied",
        reasonCode: "invalid_api_key",
      });
      throw new AuthenticationError("invalid_api_key", 401);
    }
    const candidate = await this.store.findApiKeyByPrefix(parsed[1]);
    const verified = candidate ? await Bun.password.verify(bearer, candidate.secretHash, "argon2id") : false;
    if (!candidate || !verified) {
      await this.audit({
        ...this.requestAudit(request, requestId),
        actorType: "anonymous",
        outcome: "denied",
        reasonCode: "invalid_api_key",
        details: { key_prefix: parsed[1] },
      });
      throw new AuthenticationError("invalid_api_key", 401);
    }
    const base = {
      ...this.requestAudit(request, requestId),
      actorType: "api_key" as const,
      actorId: candidate.id,
      apiKeyId: candidate.id,
      organizationId: candidate.organizationId,
    };
    const deny = async (code: AuthenticationError["code"], status: 401 | 403): Promise<never> => {
      await this.audit({ ...base, outcome: "denied", reasonCode: code });
      throw new AuthenticationError(code, status);
    };
    if (candidate.status === "revoked") return deny("revoked_api_key", 401);
    if (candidate.expiresAt && new Date(candidate.expiresAt) <= this.now()) return deny("expired_api_key", 401);
    if (candidate.organizationStatus !== "active") return deny("organization_suspended", 403);
    if (candidate.projectStatus !== "active") return deny("project_suspended", 403);
    const requestedProject = request.headers.get("x-project-id") || candidate.defaultProjectId;
    if (!candidate.grantedProjectIds.includes(requestedProject)) return deny("project_access_denied", 403);
    const ratePolicy = await this.store.getProjectRatePolicy(requestedProject);
    if (!ratePolicy) return deny("project_quota_not_configured", 403);
    await this.store.touchApiKey(candidate.id, this.now());
    await this.audit({ ...base, projectId: requestedProject, outcome: "success" });
    return {
      actorType: "api_key",
      actorId: candidate.id,
      apiKeyId: candidate.id,
      organizationId: candidate.organizationId,
      projectId: requestedProject,
      scopes: candidate.scopes,
      ratePolicy,
    };
  }

  async authorize(context: ProjectContext, scope: PublicApiScope, request: Request, requestId: string): Promise<void> {
    if (context.scopes.includes(scope)) return;
    await this.audit({
      ...this.requestAudit(request, requestId),
      actorType: context.actorType,
      actorId: context.actorId,
      apiKeyId: context.apiKeyId,
      organizationId: context.organizationId,
      projectId: context.projectId,
      outcome: "denied",
      reasonCode: "insufficient_scope",
      details: { required_scope: scope },
    });
    throw new AuthenticationError("insufficient_scope", 403);
  }

  async recordOutcome(
    context: ProjectContext,
    request: Request,
    requestId: string,
    outcome: Readonly<{ action: string; status: number; reasonCode: string }>,
  ): Promise<void> {
    await this.audit({
      ...this.requestAudit(request, requestId),
      actorType: context.actorType,
      actorId: context.actorId,
      apiKeyId: context.apiKeyId,
      organizationId: context.organizationId,
      projectId: context.projectId,
      action: outcome.action,
      outcome: outcome.status >= 400 ? "denied" : "success",
      reasonCode: outcome.reasonCode,
      details: { method: request.method, path: new URL(request.url).pathname, status: outcome.status },
    });
  }
}

export function requireScope(context: ProjectContext, scope: PublicApiScope): void {
  if (!context.scopes.includes(scope)) throw new AuthenticationError("insufficient_scope", 403);
}

export class ApiKeyManager {
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly store: IdentityStore,
    options: Readonly<{ now?: () => Date; createId?: (prefix: string) => string }> = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${Bun.randomUUIDv7()}`);
  }

  async create(
    input: Readonly<{
      organizationId: string;
      defaultProjectId: string;
      projectIds: readonly string[];
      name: string;
      scopes: readonly PublicApiScope[];
      expiresAt?: Date;
    }>,
  ): Promise<{ id: string; key: string; prefix: string; lastFour: string }> {
    if (input.scopes.length === 0 || input.scopes.some((scope) => !publicApiScopes.includes(scope))) {
      throw new Error("invalid_api_key_scopes");
    }
    const prefix = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const key = `astra_sk_${prefix}_${secret}`;
    const id = this.createId("key");
    const secretHash = await Bun.password.hash(key, {
      algorithm: "argon2id",
      memoryCost: 65_536,
      timeCost: 3,
    });
    await this.store.createApiKey({
      id,
      organizationId: input.organizationId,
      defaultProjectId: input.defaultProjectId,
      name: input.name,
      keyPrefix: prefix,
      keyLastFour: secret.slice(-4),
      secretHash,
      scopes: [...new Set(input.scopes)],
      projectIds: [...new Set(input.projectIds)],
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      createdAt: this.now(),
    });
    return { id, key, prefix, lastFour: secret.slice(-4) };
  }

  revoke(apiKeyId: string): Promise<boolean> {
    return this.store.revokeApiKey(apiKeyId, this.now());
  }
}
