import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase, IdentityRepository } from "./index.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integrationTest = database ? test : test.skip;

const audit = (id: string) => ({
  id: `audit_${id}`,
  actorType: "oidc_user" as const,
  actorId: "integration-user",
  action: "admin_session.integration",
  outcome: "success" as const,
  requestId: `req_${id}`,
  signature: "integration-signature",
  createdAt: new Date(),
});

afterAll(async () => {
  if (database) await database.client.end();
});

async function membershipFixture() {
  if (!database) throw new Error("test database unavailable");
  const suffix = randomUUID().replaceAll("-", "");
  const organizationId = `org_${suffix}`;
  const projectId = `project_${suffix}`;
  const subject = `user_${suffix}`;
  await database.client.begin(async (transaction) => {
    await transaction`INSERT INTO organizations (id, name, status) VALUES (${organizationId}, ${suffix}, 'active')`;
    await transaction`INSERT INTO projects (id, organization_id, name, status)
      VALUES (${projectId}, ${organizationId}, ${suffix}, 'active')`;
    await transaction`INSERT INTO organization_memberships (
      id, organization_id, subject_type, subject_id, role
    ) VALUES (${`orgmem_${suffix}`}, ${organizationId}, 'oidc_user', ${subject}, 'admin')`;
    await transaction`INSERT INTO project_memberships (
      id, organization_id, project_id, subject_type, subject_id, role
    ) VALUES (${`projmem_${suffix}`}, ${organizationId}, ${projectId}, 'oidc_user', ${subject}, 'security_auditor')`;
  });
  return { organizationId, projectId, subject, suffix };
}

describe("admin identity PostgreSQL contract", () => {
  integrationTest("creates a session only when organization and project memberships intersect", async () => {
    if (!database) throw new Error("test database unavailable");
    const fixture = await membershipFixture();
    const repository = new IdentityRepository(database.client);
    const createdAt = new Date();
    const record = await repository.createAdminSession({
      id: `session_${fixture.suffix}`,
      identity: {
        issuer: "https://identity.test",
        subject: fixture.subject,
        audience: ["astra-admin"],
        groups: [],
        email: "auditor@example.test",
        displayName: "Security Auditor",
        expiresAt: new Date(createdAt.getTime() + 900_000),
        tokenHash: createHash("sha256").update(`token-${fixture.suffix}`).digest("hex"),
      },
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      tokenHash: createHash("sha256").update(`session-${fixture.suffix}`).digest("hex"),
      csrfHash: createHash("sha256").update(`csrf-${fixture.suffix}`).digest("hex"),
      expiresAt: new Date(createdAt.getTime() + 900_000),
      createdAt,
      auditEvent: audit(fixture.suffix),
    });
    expect(record.organizationRoles).toEqual(["admin"]);
    expect(record.projectRoles).toEqual(["security_auditor"]);
    await database.client`DELETE FROM project_memberships WHERE project_id=${fixture.projectId}`;
    const refreshed = await repository.findAdminSession(
      createHash("sha256").update(`session-${fixture.suffix}`).digest("hex"),
    );
    expect(refreshed?.projectRoles).toEqual([]);
  });

  integrationTest("rejects cross-organization selection and OIDC token replay", async () => {
    if (!database) throw new Error("test database unavailable");
    const fixture = await membershipFixture();
    const repository = new IdentityRepository(database.client);
    const createdAt = new Date();
    const identity = {
      issuer: "https://identity.test",
      subject: fixture.subject,
      audience: ["astra-admin"],
      groups: [],
      email: null,
      displayName: null,
      expiresAt: new Date(createdAt.getTime() + 900_000),
      tokenHash: createHash("sha256").update(`token-${fixture.suffix}`).digest("hex"),
    };
    const base = {
      identity,
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      csrfHash: createHash("sha256").update(`csrf-${fixture.suffix}`).digest("hex"),
      expiresAt: new Date(createdAt.getTime() + 900_000),
      createdAt,
      auditEvent: audit(`a_${fixture.suffix}`),
    };
    await repository.createAdminSession({
      ...base,
      id: `session_a_${fixture.suffix}`,
      tokenHash: createHash("sha256").update(`session-a-${fixture.suffix}`).digest("hex"),
    });
    await expect(
      repository.createAdminSession({
        ...base,
        id: `session_b_${fixture.suffix}`,
        tokenHash: createHash("sha256").update(`session-b-${fixture.suffix}`).digest("hex"),
        auditEvent: audit(`b_${fixture.suffix}`),
      }),
    ).rejects.toThrow("oidc_token_already_exchanged");
    await expect(
      repository.createAdminSession({
        ...base,
        id: `session_c_${fixture.suffix}`,
        organizationId: "org_local",
        tokenHash: createHash("sha256").update(`session-c-${fixture.suffix}`).digest("hex"),
        identity: { ...identity, tokenHash: createHash("sha256").update(`new-${fixture.suffix}`).digest("hex") },
        auditEvent: audit(`c_${fixture.suffix}`),
      }),
    ).rejects.toThrow("admin_membership_denied");
  });

  integrationTest("allows only status revocation and prohibits deleting session security history", async () => {
    if (!database) throw new Error("test database unavailable");
    const fixture = await membershipFixture();
    const repository = new IdentityRepository(database.client);
    const createdAt = new Date();
    const sessionId = `session_${fixture.suffix}`;
    await repository.createAdminSession({
      id: sessionId,
      identity: {
        issuer: "https://identity.test",
        subject: fixture.subject,
        audience: ["astra-admin"],
        groups: [],
        email: null,
        displayName: null,
        expiresAt: new Date(createdAt.getTime() + 900_000),
        tokenHash: createHash("sha256").update(`token-${fixture.suffix}`).digest("hex"),
      },
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      tokenHash: createHash("sha256").update(`session-${fixture.suffix}`).digest("hex"),
      csrfHash: createHash("sha256").update(`csrf-${fixture.suffix}`).digest("hex"),
      expiresAt: new Date(createdAt.getTime() + 900_000),
      createdAt,
      auditEvent: audit(fixture.suffix),
    });
    await expect(repository.revokeAdminSession(sessionId, new Date(), audit(fixture.suffix))).rejects.toBeInstanceOf(
      Error,
    );
    const afterAuditFailure =
      await database.client`SELECT status, revoked_at FROM admin_sessions WHERE id=${sessionId}`;
    expect(afterAuditFailure[0]).toEqual(expect.objectContaining({ status: "active", revoked_at: null }));
    expect(await repository.revokeAdminSession(sessionId, new Date(), audit(`revoke_${fixture.suffix}`))).toBe(true);
    expect(await repository.revokeAdminSession(sessionId, new Date(), audit(`revoke_again_${fixture.suffix}`))).toBe(
      false,
    );
    let rejected: unknown;
    try {
      await database.client`DELETE FROM admin_sessions WHERE id=${sessionId}`;
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain("deletion_prohibited");
  });
});
