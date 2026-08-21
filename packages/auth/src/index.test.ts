import { describe, expect, test } from "bun:test";
import {
  ApiKeyManager,
  AuthenticationError,
  PublicApiAuthenticator,
  type ApiKeyCandidate,
  type AuditEvent,
  type IdentityStore,
  type ProjectRatePolicy,
} from "./index.ts";

const ratePolicy: ProjectRatePolicy = {
  requestRatePerMinute: 60,
  requestBurst: 10,
  taskRatePerMinute: 30,
  taskBurst: 5,
};

class RecordingIdentityStore implements IdentityStore {
  readonly candidates = new Map<string, ApiKeyCandidate>();
  readonly audits: AuditEvent[] = [];

  async findApiKeyByPrefix(prefix: string) {
    return this.candidates.get(prefix);
  }
  async getProjectRatePolicy() {
    return ratePolicy;
  }
  async touchApiKey() {}
  async insertAuditEvent(event: AuditEvent) {
    this.audits.push(event);
  }
  async createApiKey(input: Parameters<IdentityStore["createApiKey"]>[0]) {
    this.candidates.set(input.keyPrefix, {
      id: input.id,
      organizationId: input.organizationId,
      defaultProjectId: input.defaultProjectId,
      keyPrefix: input.keyPrefix,
      secretHash: input.secretHash,
      scopes: input.scopes,
      status: "active",
      expiresAt: input.expiresAt ?? null,
      organizationStatus: "active",
      projectStatus: "active",
      grantedProjectIds: input.projectIds,
    });
  }
  async revokeApiKey(apiKeyId: string) {
    const entry = [...this.candidates.entries()].find(([, candidate]) => candidate.id === apiKeyId);
    if (!entry) return false;
    this.candidates.set(entry[0], { ...entry[1], status: "revoked" });
    return true;
  }
}

const request = (key: string, projectId?: string) =>
  new Request("http://localhost/v1/tasks", {
    headers: {
      authorization: `Bearer ${key}`,
      ...(projectId ? { "x-project-id": projectId } : {}),
    },
  });

describe("PublicApiAuthenticator", () => {
  test("supports overlapping rotation and immediate revocation", async () => {
    const store = new RecordingIdentityStore();
    let sequence = 0;
    const manager = new ApiKeyManager(store, { createId: () => `key_${++sequence}` });
    const input = {
      organizationId: "org_1",
      defaultProjectId: "project_1",
      projectIds: ["project_1"],
      name: "rotation",
      scopes: ["tasks:read" as const],
    };
    const first = await manager.create(input);
    const second = await manager.create(input);
    const authenticator = new PublicApiAuthenticator(store, { auditSigningKey: "a".repeat(32) });
    expect((await authenticator.authenticate(request(first.key), "req_1")).apiKeyId).toBe(first.id);
    expect((await authenticator.authenticate(request(second.key), "req_2")).apiKeyId).toBe(second.id);
    expect(await manager.revoke(first.id)).toBe(true);
    await expect(authenticator.authenticate(request(first.key), "req_3")).rejects.toMatchObject({
      code: "revoked_api_key",
      status: 401,
    });
    expect((await authenticator.authenticate(request(second.key), "req_4")).apiKeyId).toBe(second.id);
  });

  test("denies cross-project selection and missing scopes with signed audit records", async () => {
    const store = new RecordingIdentityStore();
    const manager = new ApiKeyManager(store);
    const issued = await manager.create({
      organizationId: "org_1",
      defaultProjectId: "project_1",
      projectIds: ["project_1"],
      name: "restricted",
      scopes: ["tasks:read"],
    });
    const authenticator = new PublicApiAuthenticator(store, { auditSigningKey: "b".repeat(32) });
    await expect(authenticator.authenticate(request(issued.key, "project_other"), "req_cross")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    const context = await authenticator.authenticate(request(issued.key), "req_scope");
    await expect(
      authenticator.authorize(context, "generations:create", request(issued.key), "req_scope"),
    ).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
    expect(store.audits.map((event) => event.reasonCode)).toContain("project_access_denied");
    const scopeAudit = store.audits.find((event) => event.reasonCode === "insufficient_scope");
    expect(scopeAudit?.signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(scopeAudit?.details).toEqual({ required_scope: "generations:create" });
  });

  test("does not accept malformed or query-string credentials", async () => {
    const store = new RecordingIdentityStore();
    const authenticator = new PublicApiAuthenticator(store, { auditSigningKey: "c".repeat(32) });
    const suppliedInQuery = new Request("http://localhost/v1/tasks?api_key=astra_sk_value");
    await expect(authenticator.authenticate(suppliedInQuery, "req_query")).rejects.toMatchObject({
      code: "invalid_api_key",
      status: 401,
    });
    expect(store.audits.at(-1)?.actorType).toBe("anonymous");
  });

  test("rejects an expired key even when its Argon2id hash is valid", async () => {
    const store = new RecordingIdentityStore();
    const manager = new ApiKeyManager(store, { now: () => new Date("2026-08-20T00:00:00.000Z") });
    const issued = await manager.create({
      organizationId: "org_1",
      defaultProjectId: "project_1",
      projectIds: ["project_1"],
      name: "expired",
      scopes: ["tasks:read"],
      expiresAt: new Date("2026-08-20T01:00:00.000Z"),
    });
    const authenticator = new PublicApiAuthenticator(store, {
      auditSigningKey: "d".repeat(32),
      now: () => new Date("2026-08-20T02:00:00.000Z"),
    });
    await expect(authenticator.authenticate(request(issued.key), "req_expired")).rejects.toMatchObject({
      code: "expired_api_key",
      status: 401,
    });
  });
});
