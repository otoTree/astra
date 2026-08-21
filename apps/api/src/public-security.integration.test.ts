import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ApiKeyManager } from "@astra/auth";
import { createDatabase, IdentityRepository } from "@astra/database";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const publicApiUrl = process.env.ASTRA_TEST_PUBLIC_API_URL;
const enabled = Boolean(databaseUrl && publicApiUrl);
const integrationTest = enabled ? test : test.skip;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const suffix = randomUUID().replaceAll("-", "");
const organizationId = `org_http_${suffix}`;
const projectId = `project_http_${suffix}`;
const foreignProjectId = `project_http_foreign_${suffix}`;
const limitedProjectId = `project_http_limited_${suffix}`;
let primary: { id: string; key: string } | undefined;
let limited: { id: string; key: string } | undefined;

const headers = (key: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${key}`,
  ...extra,
});

beforeAll(async () => {
  if (!database) return;
  await database.client.begin(async (transaction) => {
    await transaction`INSERT INTO organizations (id, name, status) VALUES (${organizationId}, ${suffix}, 'active')`;
    for (const [id, name] of [
      [projectId, "Primary"],
      [foreignProjectId, "Foreign"],
      [limitedProjectId, "Limited"],
    ] as const) {
      await transaction`INSERT INTO projects (id, organization_id, name, status)
        VALUES (${id}, ${organizationId}, ${`${name}-${suffix}`}, 'active')`;
    }
    await transaction`INSERT INTO project_quotas (
      project_id, request_rate_per_minute, request_burst, task_rate_per_minute, task_burst,
      queued_task_limit, online_reservation_limit, batch_reservation_limit,
      daily_gpu_seconds_limit, daily_cost_limit_minor,
      max_file_size_bytes, daily_upload_bytes_limit, active_file_bytes_limit
    ) VALUES
      (${projectId}, 600, 100, 600, 100, 100, 100, 100, 100000, 100000, 5368709120, 10737418240, 10737418240),
      (${foreignProjectId}, 600, 100, 600, 100, 100, 100, 100, 100000, 100000, 5368709120, 10737418240, 10737418240),
      (${limitedProjectId}, 1, 2, 60, 10, 100, 100, 100, 100000, 100000, 5368709120, 10737418240, 10737418240)`;
  });
  const manager = new ApiKeyManager(new IdentityRepository(database.client));
  primary = await manager.create({
    organizationId,
    defaultProjectId: projectId,
    projectIds: [projectId],
    name: "HTTP Contract",
    scopes: ["generations:create", "tasks:read", "tasks:cancel", "models:read"],
  });
  limited = await manager.create({
    organizationId,
    defaultProjectId: limitedProjectId,
    projectIds: [limitedProjectId],
    name: "Rate Contract",
    scopes: ["models:read"],
  });
});

afterAll(async () => {
  if (database) await database.client.end();
});

describe("Public API security HTTP contract", () => {
  integrationTest("rejects missing credentials and unauthorized project selection", async () => {
    if (!publicApiUrl || !primary) throw new Error("HTTP integration configuration unavailable");
    const missing = await fetch(`${publicApiUrl}/v1/models`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    const crossProject = await fetch(`${publicApiUrl}/v1/models`, {
      headers: headers(primary.key, { "x-project-id": foreignProjectId }),
    });
    expect(crossProject.status).toBe(403);
    expect(((await crossProject.json()) as { error: { code: string } }).error.code).toBe("project_access_denied");
  });

  integrationTest("replays an idempotent create without duplicate quota reservation", async () => {
    if (!publicApiUrl || !primary || !database) throw new Error("HTTP integration configuration unavailable");
    const primaryKey = primary.key;
    const idempotencyKey = `http-${randomUUID()}`;
    const body = JSON.stringify({
      model: "local-reference-release",
      prompt: "HTTP admission contract",
      aspect_ratio: "16:9",
      resolution: "0.2mp",
      duration: 5,
    });
    const create = () =>
      fetch(`${publicApiUrl}/v1/videos/generations`, {
        method: "POST",
        headers: headers(primaryKey, { "content-type": "application/json", "idempotency-key": idempotencyKey }),
        body,
      });
    const first = await create();
    const replay = await create();
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const firstTask = (await first.json()) as { id: string };
    expect((await replay.json()) as { id: string }).toEqual(expect.objectContaining({ id: firstTask.id }));
    const reservations = await database.client`SELECT count(*)::integer AS count FROM admission_reservations
      WHERE project_id=${projectId} AND resource_type='task' AND resource_id=${firstTask.id}`;
    expect(Number(reservations[0]?.count)).toBe(1);
    const canceled = await fetch(`${publicApiUrl}/v1/tasks/${firstTask.id}/cancel`, {
      method: "POST",
      headers: headers(primary.key, { "content-type": "application/json" }),
      body: "{}",
    });
    expect(canceled.status).toBe(200);
  });

  integrationTest("returns Retry-After when the Redis token bucket is exhausted", async () => {
    if (!publicApiUrl || !limited) throw new Error("HTTP integration configuration unavailable");
    const responses = [];
    for (let index = 0; index < 3; index += 1) {
      responses.push(await fetch(`${publicApiUrl}/v1/models`, { headers: headers(limited.key) }));
    }
    expect(responses.map((response) => response.status)).toEqual([200, 200, 429]);
    expect(Number(responses[2]?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  integrationTest("applies revocation immediately and records denied audit events", async () => {
    if (!publicApiUrl || !primary || !database) throw new Error("HTTP integration configuration unavailable");
    const manager = new ApiKeyManager(new IdentityRepository(database.client));
    expect(await manager.revoke(primary.id)).toBe(true);
    const response = await fetch(`${publicApiUrl}/v1/models`, { headers: headers(primary.key) });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("revoked_api_key");
    const audits = await database.client`SELECT reason_code FROM audit_events
      WHERE organization_id=${organizationId} AND outcome='denied' ORDER BY created_at`;
    expect(audits.map((row) => row.reason_code)).toEqual(
      expect.arrayContaining(["project_access_denied", "request_rate_exceeded", "revoked_api_key"]),
    );
  });
});
