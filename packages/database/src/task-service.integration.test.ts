import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { videoGenerationSchema } from "@astra/contracts";
import { createDatabase } from "./index.ts";
import { TaskService } from "./task-service.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;

afterAll(async () => {
  await database?.client.end();
});

describe("TaskService PostgreSQL integration", () => {
  integrationTest("commits task, state, outbox and idempotency atomically", async () => {
    if (!database) throw new Error("test database unavailable");
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
    });
    const suffix = randomUUID();
    const context = { organizationId: "org_integration", projectId: `project_${suffix}` };
    const request = videoGenerationSchema.parse({
      model: "local-reference-release",
      prompt: `integration-${suffix}`,
      aspect_ratio: "16:9",
      resolution: "0.2mp",
      duration: 15,
    });
    const key = `idempotency-${suffix}`;
    const first = await service.create(context, request, "video", "/v1/videos/generations", key);
    const replay = await service.create(context, request, "video", "/v1/videos/generations", key);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.task.id).toBe(first.task.id);
    expect(first.task.status).toBe("queued");
    await expect(
      service.create(context, { ...request, prompt: "different" }, "video", "/v1/videos/generations", key),
    ).rejects.toThrow("idempotency_conflict");

    const rows = await database.client`SELECT t.request_ciphertext,
      (SELECT count(*)::int FROM task_state_events WHERE task_id=t.id) AS state_events,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=t.id) AS outbox_events,
      (SELECT count(*)::int FROM idempotency_records WHERE task_id=t.id) AS idempotency_records
      FROM tasks t WHERE t.id=${first.task.id}`;
    expect(String(rows[0]?.request_ciphertext).startsWith("v1.")).toBe(true);
    expect(String(rows[0]?.request_ciphertext)).not.toContain(request.prompt);
    expect(rows[0]?.state_events).toBe(1);
    expect(rows[0]?.outbox_events).toBe(1);
    expect(rows[0]?.idempotency_records).toBe(1);

    const canceled = await service.cancel(context, first.task.id);
    expect(canceled?.status).toBe("canceled");
    const canceledAgain = await service.cancel(context, first.task.id);
    expect(canceledAgain?.status).toBe("canceled");
  });

  integrationTest("uses signed filter-bound cursor pagination", async () => {
    if (!database) throw new Error("test database unavailable");
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
    });
    const context = { organizationId: "org_integration", projectId: `project_${randomUUID()}` };
    for (let index = 0; index < 2; index += 1) {
      const request = videoGenerationSchema.parse({
        model: "local-reference-release",
        prompt: `page-${index}`,
        aspect_ratio: "16:9",
        resolution: "0.2mp",
        duration: 15,
      });
      await service.create(context, request, "video", "/v1/videos/generations", `page-${randomUUID()}`);
    }
    const first = await service.list(context, { limit: 1 });
    expect(first.data).toHaveLength(1);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();
    if (!first.next_cursor) throw new Error("expected next cursor");
    const second = await service.list(context, { limit: 1, after: first.next_cursor });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
    await expect(service.list(context, { limit: 1, after: first.next_cursor, type: "image" })).rejects.toThrow(
      "invalid_cursor",
    );
  });
});
