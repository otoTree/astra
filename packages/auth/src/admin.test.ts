import { describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import {
  AdminAuthenticationError,
  AdminSessionManager,
  type AdminSessionRecord,
  type AdminIdentityStore,
  RemoteOidcTokenVerifier,
  intersectRolePermissions,
} from "./admin.ts";
import type { AuditEvent } from "./index.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims: Record<string, unknown>): string => {
  const header = encode({ alg: "RS256", typ: "JWT", kid: "test-key" });
  const payload = encode(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
};

const now = new Date("2026-08-21T00:00:00.000Z");
const verifier = new RemoteOidcTokenVerifier({
  issuer: "https://identity.test",
  audience: "astra-admin",
  jwksUrl: "https://identity.test/jwks",
  now: () => now,
  fetch: async () => Response.json({ keys: [publicJwk] }),
});
const validToken = () =>
  token({
    iss: "https://identity.test",
    sub: "operator-1",
    aud: "astra-admin",
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(now.getTime() / 1000) + 900,
    groups: ["astra-operators"],
    email: "operator@example.test",
    name: "Operator",
  });

class RecordingAdminStore implements AdminIdentityStore {
  readonly audits: AuditEvent[] = [];
  session: AdminSessionRecord | undefined;
  tokenHash = "";
  localUser:
    | {
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
      }
    | undefined;

  async createAdminSession(input: Parameters<AdminIdentityStore["createAdminSession"]>[0]) {
    if (input.organizationId !== "org_1" || input.projectId !== "project_1") {
      throw new Error("admin_membership_denied");
    }
    this.tokenHash = input.tokenHash;
    this.session = {
      id: input.id,
      issuer: input.identity.issuer,
      subject: input.identity.subject,
      email: input.identity.email,
      displayName: input.identity.displayName,
      organizationId: input.organizationId,
      projectId: input.projectId,
      organizationRoles: ["admin"],
      projectRoles: ["security_auditor"],
      csrfHash: input.csrfHash,
      status: "active",
      organizationStatus: "active",
      projectStatus: "active",
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
    this.audits.push(input.auditEvent);
    return this.session;
  }
  async findAdminSession(tokenHash: string) {
    return tokenHash === this.tokenHash ? this.session : undefined;
  }
  async touchAdminSession() {}
  async revokeAdminSession(
    _sessionId: string,
    revokedAt: Date,
    auditEvent: Parameters<AdminIdentityStore["revokeAdminSession"]>[2],
  ) {
    if (!this.session || this.session.status === "revoked") return false;
    this.session = { ...this.session, status: "revoked", expiresAt: this.session.expiresAt };
    this.audits.push(auditEvent);
    expect(revokedAt).toEqual(now);
    return true;
  }
  async insertAuditEvent(event: AuditEvent) {
    this.audits.push(event);
  }
  async findLocalAdminUser(username: string) {
    return this.localUser?.username === username ? this.localUser : undefined;
  }
  async recordLocalAdminFailure(userId: string, failedAt: Date, lockSeconds: number, maxFailures: number) {
    if (!this.localUser || this.localUser.id !== userId) return;
    this.localUser = {
      ...this.localUser,
      failedAttempts: this.localUser.failedAttempts + 1,
      lockedUntil:
        this.localUser.failedAttempts + 1 >= maxFailures
          ? new Date(failedAt.getTime() + lockSeconds * 1000)
          : this.localUser.lockedUntil,
    };
  }
  async resetLocalAdminFailures(userId: string) {
    if (this.localUser?.id === userId) this.localUser = { ...this.localUser, failedAttempts: 0, lockedUntil: null };
  }
}

describe("RemoteOidcTokenVerifier", () => {
  test("verifies RS256 signature, issuer, audience and temporal claims", async () => {
    const identity = await verifier.verify(validToken());
    expect(identity).toEqual(
      expect.objectContaining({
        issuer: "https://identity.test",
        subject: "operator-1",
        groups: ["astra-operators"],
      }),
    );
    expect(identity.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects an expired token and an unsupported algorithm", async () => {
    await expect(
      verifier.verify(
        token({
          iss: "https://identity.test",
          sub: "operator-1",
          aud: "astra-admin",
          exp: Math.floor(now.getTime() / 1000) - 120,
        }),
      ),
    ).rejects.toMatchObject({ code: "expired_oidc_token", status: 401 });
    const unsigned = `${encode({ alg: "none", kid: "test-key" })}.${encode({})}.value`;
    await expect(verifier.verify(unsigned)).rejects.toBeInstanceOf(AdminAuthenticationError);
  });
});

describe("admin RBAC and sessions", () => {
  test("intersects organization and project permissions", () => {
    expect(intersectRolePermissions(["admin"], ["security_auditor"])).toEqual([
      "tasks:read",
      "tasks:read_sensitive",
      "resources:read",
      "audit:read",
    ]);
    expect(intersectRolePermissions(["viewer"], ["admin"])).toEqual(["tasks:read", "resources:read"]);
  });

  test("creates an opaque session, enforces double-submit CSRF and revokes immediately", async () => {
    const store = new RecordingAdminStore();
    const manager = new AdminSessionManager(store, verifier, {
      auditSigningKey: "a".repeat(32),
      cookieName: "astra_admin_session",
      csrfCookieName: "astra_admin_csrf",
      sessionTtlSeconds: 3600,
      now: () => now,
      createId: (prefix) => `${prefix}_1`,
    });
    const exchanged = await manager.exchange(
      validToken(),
      { organizationId: "org_1", projectId: "project_1" },
      new Request("https://admin.test/admin/v1/sessions/exchange"),
      "req_exchange",
    );
    expect(exchanged.sessionToken).toMatch(/^astra_as_[A-Za-z0-9_-]{43}$/);
    const authenticated = await manager.authenticate(
      new Request("https://admin.test/admin/v1/sessions/current", {
        headers: { cookie: `astra_admin_session=${exchanged.sessionToken}` },
      }),
      "req_current",
    );
    expect(authenticated.permissions).toContain("tasks:read_sensitive");
    await expect(
      manager.verifyCsrf(
        authenticated,
        new Request("https://admin.test/admin/v1/sessions/current", { method: "DELETE" }),
        "req_csrf",
      ),
    ).rejects.toMatchObject({ code: "csrf_validation_failed" });
    const revokeRequest = new Request("https://admin.test/admin/v1/sessions/current", {
      method: "DELETE",
      headers: {
        cookie: `astra_admin_session=${exchanged.sessionToken}; astra_admin_csrf=${exchanged.csrfToken}`,
        "x-csrf-token": exchanged.csrfToken,
      },
    });
    await manager.verifyCsrf(authenticated, revokeRequest, "req_revoke");
    await manager.revoke(authenticated, revokeRequest, "req_revoke");
    await expect(manager.authenticate(revokeRequest, "req_after_revoke")).rejects.toMatchObject({
      code: "revoked_admin_session",
    });
    expect(store.audits.every((event) => event.signature.length === 43)).toBe(true);
    expect(store.audits.map((event) => event.action)).toContain("admin_session.revoke");
  });

  test("logs in with the platform-managed password and locks repeated failures", async () => {
    const store = new RecordingAdminStore();
    store.localUser = {
      id: "admin_1",
      username: "admin",
      passwordHash: await Bun.password.hash("correct-password", {
        algorithm: "argon2id",
        memoryCost: 16_384,
        timeCost: 1,
      }),
      displayName: "Administrator",
      email: null,
      status: "active",
      organizationId: "org_1",
      projectId: "project_1",
      failedAttempts: 0,
      lockedUntil: null,
    };
    const manager = new AdminSessionManager(store, undefined, {
      auditSigningKey: "a".repeat(32),
      cookieName: "astra_admin_session",
      csrfCookieName: "astra_admin_csrf",
      sessionTtlSeconds: 3600,
      now: () => now,
      createId: (prefix) => `${prefix}_local`,
    });
    await expect(
      manager.login("admin", "wrong", new Request("https://admin.test/login"), "req_bad", {
        maxFailures: 2,
        lockSeconds: 900,
      }),
    ).rejects.toMatchObject({ code: "invalid_admin_credentials" });
    await expect(
      manager.login("admin", "wrong", new Request("https://admin.test/login"), "req_locked", {
        maxFailures: 2,
        lockSeconds: 900,
      }),
    ).rejects.toMatchObject({ code: "invalid_admin_credentials" });
    await expect(
      manager.login("admin", "wrong", new Request("https://admin.test/login"), "req_blocked", {
        maxFailures: 2,
        lockSeconds: 900,
      }),
    ).rejects.toMatchObject({ code: "admin_login_locked" });
    expect(store.localUser.lockedUntil).toBeTruthy();
  });
});
