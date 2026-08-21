import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import type { AuditEvent } from "./index.ts";

export const adminPermissions = [
  "tasks:read",
  "tasks:read_sensitive",
  "tasks:cancel",
  "resources:read",
  "workers:drain",
  "releases:write",
  "rollouts:write",
  "policies:write",
  "audit:read",
  "identity:admin",
] as const;

export type AdminPermission = (typeof adminPermissions)[number];
export type AdminRole = "viewer" | "operator" | "model_releaser" | "security_auditor" | "admin";

const permissionsByRole: Readonly<Record<AdminRole, readonly AdminPermission[]>> = {
  viewer: ["tasks:read", "resources:read"],
  operator: ["tasks:read", "tasks:cancel", "resources:read", "workers:drain"],
  model_releaser: ["tasks:read", "resources:read", "releases:write", "rollouts:write", "policies:write"],
  security_auditor: ["tasks:read", "tasks:read_sensitive", "resources:read", "audit:read"],
  admin: adminPermissions,
};

export function intersectRolePermissions(
  organizationRoles: readonly AdminRole[],
  projectRoles: readonly AdminRole[],
): AdminPermission[] {
  const organization = new Set(organizationRoles.flatMap((role) => permissionsByRole[role]));
  const project = new Set(projectRoles.flatMap((role) => permissionsByRole[role]));
  return adminPermissions.filter((permission) => organization.has(permission) && project.has(permission));
}

export type VerifiedOidcIdentity = Readonly<{
  issuer: string;
  subject: string;
  audience: readonly string[];
  groups: readonly string[];
  email: string | null;
  displayName: string | null;
  expiresAt: Date;
  tokenHash: string;
}>;

export interface OidcTokenVerifier {
  verify(idToken: string): Promise<VerifiedOidcIdentity>;
}

type OidcFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type JsonWebKey = Readonly<{
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}>;

type JwksDocument = Readonly<{ keys: readonly JsonWebKey[] }>;

const decodePart = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_oidc_token");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AdminAuthenticationError("invalid_oidc_token", 401);
  }
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === "string") ? value : [];

export class RemoteOidcTokenVerifier implements OidcTokenVerifier {
  private cached: Readonly<{ expiresAt: number; document: JwksDocument }> | undefined;

  constructor(
    private readonly options: Readonly<{
      issuer: string;
      audience: string;
      jwksUrl: string;
      clockSkewSeconds?: number;
      cacheSeconds?: number;
      now?: () => Date;
      fetch?: OidcFetch;
    }>,
  ) {}

  private async keys(forceRefresh: boolean): Promise<JwksDocument> {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    if (!forceRefresh && this.cached && this.cached.expiresAt > now) return this.cached.document;
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(this.options.jwksUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      throw new AdminAuthenticationError("oidc_verifier_unavailable", 503);
    }
    if (!response.ok) throw new AdminAuthenticationError("oidc_verifier_unavailable", 503);
    const payload = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(payload.keys) || payload.keys.length === 0 || payload.keys.length > 20) {
      throw new AdminAuthenticationError("oidc_verifier_unavailable", 503);
    }
    const document = { keys: payload.keys as JsonWebKey[] };
    this.cached = { expiresAt: now + (this.options.cacheSeconds ?? 300) * 1000, document };
    return document;
  }

  async verify(idToken: string): Promise<VerifiedOidcIdentity> {
    if (idToken.length > 16_384) throw new AdminAuthenticationError("invalid_oidc_token", 401);
    const parts = idToken.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new AdminAuthenticationError("invalid_oidc_token", 401);
    }
    const header = decodePart(parts[0]);
    const claims = decodePart(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256) {
      throw new AdminAuthenticationError("invalid_oidc_token", 401);
    }
    let document = await this.keys(false);
    let key = document.keys.find(
      (candidate) =>
        candidate.kid === header.kid && candidate.kty === "RSA" && candidate.use !== "enc" && candidate.alg !== "none",
    );
    if (!key) {
      document = await this.keys(true);
      key = document.keys.find(
        (candidate) =>
          candidate.kid === header.kid &&
          candidate.kty === "RSA" &&
          candidate.use !== "enc" &&
          candidate.alg !== "none",
      );
    }
    if (!key?.n || !key.e) throw new AdminAuthenticationError("invalid_oidc_token", 401);
    let valid = false;
    try {
      const publicKey = createPublicKey({ key: key as object, format: "jwk" });
      valid = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        publicKey,
        Buffer.from(parts[2], "base64url"),
      );
    } catch {
      throw new AdminAuthenticationError("invalid_oidc_token", 401);
    }
    if (!valid) throw new AdminAuthenticationError("invalid_oidc_token", 401);

    const now = Math.floor((this.options.now ?? (() => new Date()))().getTime() / 1000);
    const skew = this.options.clockSkewSeconds ?? 60;
    const audiences = typeof claims.aud === "string" ? [claims.aud] : stringArray(claims.aud);
    if (
      claims.iss !== this.options.issuer ||
      typeof claims.sub !== "string" ||
      claims.sub.length === 0 ||
      !audiences.includes(this.options.audience) ||
      typeof claims.exp !== "number" ||
      !Number.isInteger(claims.exp) ||
      claims.exp <= now - skew ||
      (typeof claims.nbf === "number" && claims.nbf > now + skew) ||
      (typeof claims.iat === "number" && claims.iat > now + skew)
    ) {
      throw new AdminAuthenticationError(
        typeof claims.exp === "number" && claims.exp <= now - skew ? "expired_oidc_token" : "invalid_oidc_token",
        401,
      );
    }
    const groups = claims.groups === undefined ? [] : stringArray(claims.groups);
    if (
      claims.groups !== undefined &&
      groups.length === 0 &&
      Array.isArray(claims.groups) &&
      claims.groups.length > 0
    ) {
      throw new AdminAuthenticationError("invalid_oidc_token", 401);
    }
    return {
      issuer: claims.iss,
      subject: claims.sub,
      audience: audiences,
      groups,
      email: typeof claims.email === "string" && claims.email.length <= 320 ? claims.email : null,
      displayName: typeof claims.name === "string" && claims.name.length <= 500 ? claims.name : null,
      expiresAt: new Date(claims.exp * 1000),
      tokenHash: createHash("sha256").update(idToken).digest("hex"),
    };
  }
}

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

export interface AdminIdentityStore {
  createAdminSession(input: {
    id: string;
    identity: VerifiedOidcIdentity;
    organizationId: string;
    projectId: string;
    tokenHash: string;
    csrfHash: string;
    expiresAt: Date;
    createdAt: Date;
    auditEvent: AuditEvent;
  }): Promise<AdminSessionRecord>;
  findAdminSession(tokenHash: string): Promise<AdminSessionRecord | undefined>;
  touchAdminSession(sessionId: string, usedAt: Date): Promise<void>;
  revokeAdminSession(sessionId: string, revokedAt: Date, auditEvent: AuditEvent): Promise<boolean>;
  insertAuditEvent(event: AuditEvent): Promise<void>;
}

export type AdminContext = Readonly<{
  actorType: "oidc_user";
  actorId: string;
  sessionId: string;
  organizationId: string;
  projectId: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  organizationRoles: readonly AdminRole[];
  projectRoles: readonly AdminRole[];
  permissions: readonly AdminPermission[];
  csrfHash: string;
  createdAt: Date;
  expiresAt: Date;
}>;

export type AdminSessionView = Readonly<{
  id: string;
  object: "admin.session";
  organization_id: string;
  project_id: string;
  subject: string;
  display_name: string | null;
  email: string | null;
  organization_roles: readonly AdminRole[];
  project_roles: readonly AdminRole[];
  permissions: readonly AdminPermission[];
  csrf_token?: string;
  created_at: number;
  expires_at: number;
}>;

export class AdminAuthenticationError extends Error {
  constructor(
    readonly code:
      | "invalid_oidc_token"
      | "expired_oidc_token"
      | "oidc_verifier_unavailable"
      | "admin_membership_denied"
      | "invalid_admin_session"
      | "expired_admin_session"
      | "revoked_admin_session"
      | "organization_suspended"
      | "project_suspended"
      | "csrf_validation_failed"
      | "insufficient_admin_permission",
    readonly status: 401 | 403 | 503,
  ) {
    super(code);
  }
}

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

const parseCookie = (request: Request, name: string): string | undefined => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const unix = (value: Date): number => Math.floor(value.getTime() / 1000);

export class AdminSessionManager {
  private readonly auditKey: Buffer;
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly store: AdminIdentityStore,
    private readonly verifier: OidcTokenVerifier,
    private readonly options: Readonly<{
      auditSigningKey: string;
      cookieName: string;
      csrfCookieName: string;
      sessionTtlSeconds: number;
      now?: () => Date;
      createId?: (prefix: string) => string;
    }>,
  ) {
    this.auditKey = createHash("sha256").update(`astra-admin-audit-v1:${options.auditSigningKey}`).digest();
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${Bun.randomUUIDv7()}`);
  }

  private async audit(event: Omit<AuditEvent, "id" | "signature" | "createdAt">): Promise<void> {
    await this.store.insertAuditEvent(this.signedAudit(event));
  }

  private signedAudit(event: Omit<AuditEvent, "id" | "signature" | "createdAt">): AuditEvent {
    const unsigned = { ...event, id: this.createId("audit"), createdAt: this.now() };
    const signature = createHmac("sha256", this.auditKey).update(auditPayload(unsigned)).digest("base64url");
    return { ...unsigned, signature };
  }

  private requestAudit(request: Request, requestId: string) {
    const ip = sourceIp(request);
    const userAgent = request.headers.get("user-agent");
    const traceId = request.headers.get("traceparent");
    return {
      requestId,
      ...(ip ? { sourceIp: ip } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(traceId ? { traceId } : {}),
    };
  }

  private context(record: AdminSessionRecord): AdminContext {
    return {
      actorType: "oidc_user",
      actorId: record.subject,
      sessionId: record.id,
      organizationId: record.organizationId,
      projectId: record.projectId,
      subject: record.subject,
      email: record.email,
      displayName: record.displayName,
      organizationRoles: record.organizationRoles,
      projectRoles: record.projectRoles,
      permissions: intersectRolePermissions(record.organizationRoles, record.projectRoles),
      csrfHash: record.csrfHash,
      createdAt: new Date(record.createdAt),
      expiresAt: new Date(record.expiresAt),
    };
  }

  view(context: AdminContext, csrfToken?: string): AdminSessionView {
    return {
      id: context.sessionId,
      object: "admin.session",
      organization_id: context.organizationId,
      project_id: context.projectId,
      subject: context.subject,
      display_name: context.displayName,
      email: context.email,
      organization_roles: context.organizationRoles,
      project_roles: context.projectRoles,
      permissions: context.permissions,
      ...(csrfToken ? { csrf_token: csrfToken } : {}),
      created_at: unix(context.createdAt),
      expires_at: unix(context.expiresAt),
    };
  }

  async exchange(
    idToken: string,
    selection: Readonly<{ organizationId: string; projectId: string }>,
    request: Request,
    requestId: string,
  ): Promise<Readonly<{ context: AdminContext; sessionToken: string; csrfToken: string }>> {
    let identity: VerifiedOidcIdentity;
    try {
      identity = await this.verifier.verify(idToken);
    } catch (error) {
      const candidate =
        error instanceof AdminAuthenticationError ? error : new AdminAuthenticationError("invalid_oidc_token", 401);
      await this.audit({
        ...this.requestAudit(request, requestId),
        actorType: "anonymous",
        action: "admin_session.exchange",
        outcome: "denied",
        reasonCode: candidate.code,
      });
      throw candidate;
    }
    const now = this.now();
    const expiresAt = new Date(
      Math.min(identity.expiresAt.getTime(), now.getTime() + this.options.sessionTtlSeconds * 1000),
    );
    if (expiresAt <= now) throw new AdminAuthenticationError("expired_oidc_token", 401);
    const sessionToken = `astra_as_${randomBytes(32).toString("base64url")}`;
    const csrfToken = randomBytes(32).toString("base64url");
    const sessionId = this.createId("session");
    const successAudit = this.signedAudit({
      ...this.requestAudit(request, requestId),
      actorType: "oidc_user",
      actorId: identity.subject,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
      action: "admin_session.exchange",
      resourceType: "admin_session",
      resourceId: sessionId,
      outcome: "success",
    });
    let record: AdminSessionRecord;
    try {
      record = await this.store.createAdminSession({
        id: sessionId,
        identity,
        organizationId: selection.organizationId,
        projectId: selection.projectId,
        tokenHash: sha256(sessionToken),
        csrfHash: sha256(csrfToken),
        expiresAt,
        createdAt: now,
        auditEvent: successAudit,
      });
    } catch (error) {
      const code =
        error instanceof Error && error.message === "oidc_token_already_exchanged"
          ? "invalid_oidc_token"
          : "admin_membership_denied";
      await this.audit({
        ...this.requestAudit(request, requestId),
        actorType: "oidc_user",
        actorId: identity.subject,
        organizationId: selection.organizationId,
        projectId: selection.projectId,
        action: "admin_session.exchange",
        outcome: "denied",
        reasonCode: code,
      });
      throw new AdminAuthenticationError(code, code === "invalid_oidc_token" ? 401 : 403);
    }
    return { context: this.context(record), sessionToken, csrfToken };
  }

  async authenticate(request: Request, requestId: string): Promise<AdminContext> {
    const token = parseCookie(request, this.options.cookieName);
    const record = token ? await this.store.findAdminSession(sha256(token)) : undefined;
    const base = {
      ...this.requestAudit(request, requestId),
      actorType: record ? ("oidc_user" as const) : ("anonymous" as const),
      ...(record
        ? { actorId: record.subject, organizationId: record.organizationId, projectId: record.projectId }
        : {}),
      action: "admin_session.authenticate",
    };
    const deny = async (code: AdminAuthenticationError["code"], status: 401 | 403): Promise<never> => {
      await this.audit({ ...base, outcome: "denied", reasonCode: code });
      throw new AdminAuthenticationError(code, status);
    };
    if (!record) return deny("invalid_admin_session", 401);
    if (record.status === "revoked") return deny("revoked_admin_session", 401);
    if (new Date(record.expiresAt) <= this.now()) return deny("expired_admin_session", 401);
    if (record.organizationStatus !== "active") return deny("organization_suspended", 403);
    if (record.projectStatus !== "active") return deny("project_suspended", 403);
    const context = this.context(record);
    if (context.permissions.length === 0) return deny("admin_membership_denied", 403);
    await this.store.touchAdminSession(record.id, this.now());
    return context;
  }

  async authorize(
    context: AdminContext,
    permission: AdminPermission,
    request: Request,
    requestId: string,
  ): Promise<void> {
    if (context.permissions.includes(permission)) return;
    await this.audit({
      ...this.requestAudit(request, requestId),
      actorType: "oidc_user",
      actorId: context.actorId,
      organizationId: context.organizationId,
      projectId: context.projectId,
      action: "admin_api.authorize",
      outcome: "denied",
      reasonCode: "insufficient_admin_permission",
      details: { required_permission: permission },
    });
    throw new AdminAuthenticationError("insufficient_admin_permission", 403);
  }

  async verifyCsrf(context: AdminContext, request: Request, requestId: string): Promise<void> {
    const header = request.headers.get("x-csrf-token");
    const cookie = parseCookie(request, this.options.csrfCookieName);
    const headerHash = header ? Buffer.from(sha256(header), "hex") : Buffer.alloc(0);
    const cookieHash = cookie ? Buffer.from(sha256(cookie), "hex") : Buffer.alloc(0);
    const expected = Buffer.from(context.csrfHash, "hex");
    const valid =
      headerHash.length === expected.length &&
      cookieHash.length === expected.length &&
      timingSafeEqual(headerHash, expected) &&
      timingSafeEqual(cookieHash, expected);
    if (valid) return;
    await this.audit({
      ...this.requestAudit(request, requestId),
      actorType: "oidc_user",
      actorId: context.actorId,
      organizationId: context.organizationId,
      projectId: context.projectId,
      action: "admin_api.csrf",
      outcome: "denied",
      reasonCode: "csrf_validation_failed",
    });
    throw new AdminAuthenticationError("csrf_validation_failed", 403);
  }

  async revoke(context: AdminContext, request: Request, requestId: string): Promise<void> {
    const auditEvent = this.signedAudit({
      ...this.requestAudit(request, requestId),
      actorType: "oidc_user",
      actorId: context.actorId,
      organizationId: context.organizationId,
      projectId: context.projectId,
      action: "admin_session.revoke",
      resourceType: "admin_session",
      resourceId: context.sessionId,
      outcome: "success",
    });
    await this.store.revokeAdminSession(context.sessionId, this.now(), auditEvent);
  }

  async recordSensitiveRead(
    context: AdminContext,
    taskId: string,
    purpose: string,
    request: Request,
    requestId: string,
    outcome: "success" | "failure",
  ): Promise<void> {
    await this.audit({
      ...this.requestAudit(request, requestId),
      actorType: "oidc_user",
      actorId: context.actorId,
      organizationId: context.organizationId,
      projectId: context.projectId,
      action: "task.sensitive_request.read",
      resourceType: "task",
      resourceId: taskId,
      outcome,
      reasonCode: outcome === "success" ? "authorized_sensitive_read" : "sensitive_read_failed",
      purpose,
    });
  }
}
