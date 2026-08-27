import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { ProviderSyncRequestRepository } from "./provider-sync-request-repository.ts";

const databaseUrl = process.env.DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const sql = databaseUrl ? postgres(databaseUrl, { prepare: false }) : undefined;
const suffix = Bun.randomUUIDv7().replaceAll("-", "");
const projectId = `project_sync_${suffix}`;
const organizationId = `org_sync_${suffix}`;

describe("ProviderSyncRequestRepository", () => {
  beforeAll(async () => {
    if (!sql) return;
    const now = new Date().toISOString();
    await sql`INSERT INTO provider_sync_requests (
        id, organization_id, project_id, provider, status, reason, requested_by,
        requested_at, created_at, updated_at, version
      ) VALUES (
        ${`provider_sync_${suffix}`}, ${organizationId}, ${projectId}, 'gongji', 'pending',
        'Integration test provider synchronization', 'admin_test', ${now}, ${now}, ${now}, 1
      )`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM provider_sync_requests WHERE project_id=${projectId}`;
    await sql.end();
  });

  integrationTest("claims once and records the published snapshot", async () => {
    if (!sql) return;
    const repository = new ProviderSyncRequestRepository(sql, () => new Date("2026-08-27T10:00:00Z"));
    const claim = await repository.claim("gongji", "controller_test", 120);
    expect(claim?.id).toBe(`provider_sync_${suffix}`);
    expect(await repository.claim("gongji", "controller_other", 120)).toBeUndefined();

    const snapshotId = `provider_snapshot_sync_${suffix}`;
    await sql`INSERT INTO provider_snapshot_runs (
        id, provider, contract_version, status, observed_at, expires_at, object_count,
        quarantine_reasons, started_at, completed_at
      ) VALUES (
        ${snapshotId}, 'gongji', 'test', 'published', '2026-08-27T10:00:00Z', '2026-08-27T10:05:00Z',
        1, '[]'::jsonb, '2026-08-27T10:00:00Z', '2026-08-27T10:00:01Z'
      )`;
    if (!claim) throw new Error("claim_missing");
    await repository.complete(claim, "controller_test", { snapshotRunId: snapshotId });
    const rows = await sql`SELECT status, snapshot_run_id, completed_at FROM provider_sync_requests
      WHERE id=${claim.id}`;
    expect(rows[0]?.status).toBe("succeeded");
    expect(rows[0]?.snapshot_run_id).toBe(snapshotId);
    expect(rows[0]?.completed_at).not.toBeNull();
    await sql`DELETE FROM provider_sync_requests WHERE id=${claim.id}`;
    await sql`DELETE FROM provider_snapshot_runs WHERE id=${snapshotId}`;
  });
});
