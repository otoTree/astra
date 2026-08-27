import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { AdminManagementService, createDatabase, RequestCipher, type OciImageResolver } from "./index.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integrationTest = database ? test : test.skip;

afterAll(async () => {
  await database?.client.end();
});

describe("provider credential admin management", () => {
  integrationTest("rotates encrypted tokens and revokes with a version precondition", async () => {
    if (!database) throw new Error("test database unavailable");
    const suffix = randomUUID().replaceAll("-", "");
    const organizationId = `org_credential_${suffix}`;
    const projectId = `project_credential_${suffix}`;
    const sessionId = `session_credential_${suffix}`;
    const actorId = `admin_credential_${suffix}`;
    const provider = `gongji_test_${suffix}`;
    await database.client.begin(async (transaction) => {
      await transaction`INSERT INTO organizations (id, name, status) VALUES (${organizationId}, ${suffix}, 'active')`;
      await transaction`INSERT INTO projects (id, organization_id, name, status)
        VALUES (${projectId}, ${organizationId}, ${suffix}, 'active')`;
      await transaction`INSERT INTO admin_sessions (
          id, issuer, subject, oidc_groups, organization_id, project_id, token_hash, csrf_hash,
          oidc_token_hash, status, expires_at, created_at
        ) VALUES (
          ${sessionId}, 'local', ${actorId}, ARRAY[]::text[], ${organizationId}, ${projectId},
          ${createHash("sha256").update(`session:${suffix}`).digest("hex")},
          ${createHash("sha256").update(`csrf:${suffix}`).digest("hex")},
          ${createHash("sha256").update(`identity:${suffix}`).digest("hex")},
          'active', now() + interval '1 hour', now()
        )`;
    });
    const resolver: OciImageResolver = {
      resolve: async () => {
        throw new Error("unexpected image resolution");
      },
    };
    const service = new AdminManagementService(
      database.client,
      resolver,
      "provider-credential-audit-signing-key",
      undefined,
      new RequestCipher("provider-credential-encryption-key"),
    );
    const actor = { actorId, sessionId, organizationId, projectId };
    const request = { requestId: `req_credential_${suffix}` };
    const token = `gongji-token-${suffix}`;
    const rotated = await service.rotateProviderCredential(actor, request, `credential-rotate-${suffix}`, provider, {
      token,
      reason: "Configure encrypted provider credential",
    });
    expect(rotated.body).not.toHaveProperty("token");
    expect(rotated.body).toMatchObject({ configured: true, version: 1, status: "active" });
    const stored = await database.client`SELECT token_ciphertext, token_fingerprint, status
      FROM provider_credentials WHERE provider=${provider}`;
    expect(String(stored[0]?.token_ciphertext)).not.toContain(token);
    expect(stored[0]).toMatchObject({
      token_fingerprint: createHash("sha256").update(token).digest("hex"),
      status: "active",
    });
    const revoked = await service.revokeProviderCredential(actor, request, `credential-revoke-${suffix}`, provider, {
      expected_version: 1,
      reason: "Revoke encrypted provider credential",
    });
    expect(revoked.body).toMatchObject({ configured: false, version: 1, status: "revoked" });
    await expect(
      service.revokeProviderCredential(actor, request, `credential-revoke-again-${suffix}`, provider, {
        expected_version: 1,
        reason: "Reject stale provider credential revoke",
      }),
    ).rejects.toMatchObject({ code: "version_conflict", status: 409 });
  });
});
