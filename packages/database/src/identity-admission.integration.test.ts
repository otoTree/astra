import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { videoGenerationSchema } from "@astra/contracts";
import { createDatabase, FileRepository } from "./index.ts";
import { TaskService } from "./task-service.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integrationTest = database ? test : test.skip;

async function identity(limit: { concurrency?: number; gpuSeconds?: number } = {}) {
  if (!database) throw new Error("test database unavailable");
  const suffix = randomUUID().replaceAll("-", "");
  const organizationId = `org_${suffix}`;
  const projectId = `project_${suffix}`;
  const apiKeyId = `key_${suffix}`;
  await database.client.begin(async (transaction) => {
    await transaction`INSERT INTO organizations (id, name, status) VALUES (${organizationId}, ${suffix}, 'active')`;
    await transaction`INSERT INTO projects (id, organization_id, name, status)
      VALUES (${projectId}, ${organizationId}, ${suffix}, 'active')`;
    await transaction`INSERT INTO project_quotas (
      project_id, request_rate_per_minute, request_burst, task_rate_per_minute, task_burst,
      queued_task_limit, online_reservation_limit, batch_reservation_limit,
      daily_gpu_seconds_limit, daily_cost_limit_minor,
      max_file_size_bytes, daily_upload_bytes_limit, active_file_bytes_limit
    ) VALUES (
      ${projectId}, 100, 20, 100, 20, 10, ${limit.concurrency ?? 10}, 10,
      ${limit.gpuSeconds ?? 10000}, 100000, 5368709120, 10737418240, 10737418240
    )`;
    await transaction`INSERT INTO api_keys (
      id, organization_id, default_project_id, name, key_prefix, key_last_four,
      secret_hash, scopes, status, created_at, updated_at
    ) VALUES (
      ${apiKeyId}, ${organizationId}, ${projectId}, 'Integration', ${suffix.slice(0, 12)},
      ${suffix.slice(-4)}, 'integration-only-hash', ARRAY['generations:create','tasks:read','tasks:cancel'], 'active', now(), now()
    )`;
    await transaction`INSERT INTO api_key_project_grants (api_key_id, project_id) VALUES (${apiKeyId}, ${projectId})`;
  });
  return { organizationId, projectId, apiKeyId };
}

const request = videoGenerationSchema.parse({
  model: "local-reference-release",
  prompt: "admission contract",
  aspect_ratio: "16:9",
  resolution: "0.2mp",
  duration: 5,
});

afterAll(async () => {
  if (database) await database.client.end();
});

describe("identity and admission PostgreSQL contract", () => {
  integrationTest("does not reserve twice for idempotent replay and releases a canceled queued task", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await identity({ concurrency: 1 });
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: true,
    });
    const key = `idem-${randomUUID()}`;
    const first = await service.create(context, request, "video", "generation", "/v1/videos/generations", key);
    const replay = await service.create(context, request, "video", "generation", "/v1/videos/generations", key);
    expect(replay.replayed).toBe(true);
    expect(replay.task.id).toBe(first.task.id);
    const held = await database.client`SELECT count(*)::integer AS count FROM admission_reservations
      WHERE project_id=${context.projectId} AND status='held'`;
    expect(Number(held[0]?.count)).toBe(1);
    await expect(
      service.create(context, request, "video", "generation", "/v1/videos/generations", `idem-${randomUUID()}`),
    ).rejects.toThrow("project_concurrency_exceeded");
    expect((await service.cancel(context, first.task.id))?.status).toBe("canceled");
    const replacement = await service.create(
      context,
      request,
      "video",
      "generation",
      "/v1/videos/generations",
      `idem-${randomUUID()}`,
    );
    expect(replacement.task.status).toBe("queued");
  });

  integrationTest("rejects estimated GPU usage atomically without leaving a reservation", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await identity({ gpuSeconds: 1 });
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: true,
    });
    await expect(
      service.create(context, request, "video", "generation", "/v1/videos/generations", `idem-${randomUUID()}`),
    ).rejects.toThrow("daily_gpu_quota_exceeded");
    const rows = await database.client`SELECT count(*)::integer AS count FROM admission_reservations
      WHERE project_id=${context.projectId}`;
    expect(Number(rows[0]?.count)).toBe(0);
    const tasks =
      await database.client`SELECT count(*)::integer AS count FROM tasks WHERE project_id=${context.projectId}`;
    expect(Number(tasks[0]?.count)).toBe(0);
  });

  integrationTest("prevents audit and usage history mutation at the database boundary", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await identity();
    const auditId = `audit_${randomUUID()}`;
    await database.client`INSERT INTO audit_events (
      id, actor_type, actor_id, api_key_id, organization_id, project_id,
      action, outcome, request_id, details, signature, created_at
    ) VALUES (
      ${auditId}, 'api_key', ${context.apiKeyId}, ${context.apiKeyId}, ${context.organizationId},
      ${context.projectId}, 'contract.test', 'success', ${`req_${randomUUID()}`}, '{}', 'signed', now()
    )`;
    for (const operation of ["update", "delete"] as const) {
      let rejected: unknown;
      try {
        if (operation === "update") {
          await database.client`UPDATE audit_events SET outcome='failure' WHERE id=${auditId}`;
        } else {
          await database.client`DELETE FROM audit_events WHERE id=${auditId}`;
        }
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).message).toContain("append_only_table");
    }
  });

  integrationTest("rejects an oversized file without persisting a file or reservation", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await identity();
    await database.client`UPDATE project_quotas SET max_file_size_bytes=10 WHERE project_id=${context.projectId}`;
    const repository = new FileRepository(database.client);
    await expect(
      repository.createPendingAuthorized(context, {
        filename: "oversized.png",
        content_type: "image/png",
        size_bytes: 11,
        sha256: "a".repeat(64),
        purpose: "generation_input",
      }),
    ).rejects.toThrow("file_too_large");
    const files =
      await database.client`SELECT count(*)::integer AS count FROM files WHERE project_id=${context.projectId}`;
    const reservations = await database.client`SELECT count(*)::integer AS count FROM admission_reservations
      WHERE project_id=${context.projectId}`;
    expect(Number(files[0]?.count)).toBe(0);
    expect(Number(reservations[0]?.count)).toBe(0);
  });
});
