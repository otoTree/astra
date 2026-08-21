import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  imageEditSchema,
  imageGenerationSchema,
  modelSchema,
  taskSchema,
  videoEditSchema,
  videoGenerationSchema,
} from "@astra/contracts";
import { AssetExpirationRepository, createDatabase, FileRepository } from "./index.ts";
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
      enforceAdmission: false,
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
    const first = await service.create(context, request, "video", "generation", "/v1/videos/generations", key);
    const replay = await service.create(context, request, "video", "generation", "/v1/videos/generations", key);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.task.id).toBe(first.task.id);
    expect(first.task.status).toBe("queued");
    expect(first.task.resolved_parameters).toEqual({ width: 608, height: 352, fps: 24 });
    expect(first.task.resolved_parameters).toEqual(replay.task.resolved_parameters);
    expect(first.task.resolved_parameters).not.toHaveProperty("seed");
    expect(taskSchema.safeParse(first.task).success).toBe(true);
    await expect(
      service.create(
        context,
        { ...request, prompt: "different" },
        "video",
        "generation",
        "/v1/videos/generations",
        key,
      ),
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

  integrationTest("converges concurrent idempotent creates to one task", async () => {
    if (!database) throw new Error("test database unavailable");
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
    });
    const suffix = randomUUID();
    const context = { organizationId: "org_integration", projectId: `project_${suffix}` };
    const request = videoGenerationSchema.parse({
      model: "local-reference-release",
      prompt: "concurrent idempotency",
      aspect_ratio: "16:9",
      resolution: "0.2mp",
      duration: 15,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.create(context, request, "video", "generation", "/v1/videos/generations", `concurrent-${suffix}`),
      ),
    );
    expect(new Set(results.map((result) => result.task.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
  });

  integrationTest("lists each enabled model modality with contract-valid capabilities", async () => {
    if (!database) throw new Error("test database unavailable");
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
    });
    const context = { organizationId: "org_integration", projectId: `project_${randomUUID()}` };
    const models = await service.listModels(context);
    expect(models.data.some((model) => model.type === "video")).toBe(true);
    expect(models.data.some((model) => model.type === "image")).toBe(true);
    for (const model of models.data) expect(modelSchema.safeParse(model).success).toBe(true);
    expect((await service.listModels(context, "image")).data.every((model) => model.type === "image")).toBe(true);
  });

  integrationTest("creates image and video edit operations against release capabilities", async () => {
    if (!database) throw new Error("test database unavailable");
    const now = () => new Date("2026-08-21T01:00:00.000Z");
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
      now,
    });
    const files = new FileRepository(database.client);
    const context = { organizationId: "org_integration", projectId: `project_${randomUUID()}` };
    const image = await files.createPending(
      context.projectId,
      {
        filename: "reference.png",
        content_type: "image/png",
        size_bytes: 68,
        sha256: "3".repeat(64),
        purpose: "generation_input",
      },
      now(),
    );
    await files.markValidating(context.projectId, image.id, now());
    await files.markAvailable(
      context.projectId,
      image.id,
      { media_type: "image", container: "png", width: 1, height: 1 },
      now(),
    );
    const video = await files.createPending(
      context.projectId,
      {
        filename: "source.mp4",
        content_type: "video/mp4",
        size_bytes: 1024,
        sha256: "4".repeat(64),
        purpose: "generation_input",
      },
      now(),
    );
    await files.markValidating(context.projectId, video.id, now());
    await files.markAvailable(
      context.projectId,
      video.id,
      {
        media_type: "video",
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        width: 320,
        height: 180,
        duration_seconds: 1,
        fps: 24,
        video_codec: "h264",
      },
      now(),
    );

    const imageGeneration = imageGenerationSchema.parse({
      model: "local-reference-release",
      prompt: "image generation",
      size: "608x352",
    });
    const generated = await service.create(context, imageGeneration, "image", "generation", "/v1/images/generations");
    expect(generated.task.operation).toBe("generation");
    expect(generated.task.type).toBe("image");
    expect(generated.task.resolved_parameters).toEqual({ width: 608, height: 352 });

    const imageEdit = imageEditSchema.parse({
      model: "local-reference-release",
      prompt: "image edit",
      size: "608x352",
      input_files: [{ file_id: image.id, type: "image", role: "reference_image" }],
    });
    const editedImage = await service.create(context, imageEdit, "image", "edit", "/v1/images/edits");
    expect(editedImage.task.operation).toBe("edit");

    const videoEdit = videoEditSchema.parse({
      model: "local-reference-release",
      prompt: "video edit",
      aspect_ratio: "16:9",
      resolution: "0.2mp",
      duration: 15,
      input_files: [{ file_id: video.id, type: "video", role: "source_video" }],
    });
    const editedVideo = await service.create(context, videoEdit, "video", "edit", "/v1/videos/edits");
    expect(editedVideo.task.operation).toBe("edit");
    expect(taskSchema.safeParse(editedVideo.task).success).toBe(true);

    const unsupported = imageGenerationSchema.parse({
      model: "local-reference-release",
      prompt: "unsupported size",
      size: "1024x1024",
    });
    await expect(service.create(context, unsupported, "image", "generation", "/v1/images/generations")).rejects.toThrow(
      "model_capability_mismatch",
    );
  });

  integrationTest("enforces file ownership, decoded media type and remaining TTL", async () => {
    if (!database) throw new Error("test database unavailable");
    let clock = new Date("2026-08-21T02:00:00.000Z");
    const now = () => new Date(clock);
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
      now,
    });
    const files = new FileRepository(database.client);
    const ownerProject = `project_${randomUUID()}`;
    const context = { organizationId: "org_integration", projectId: `project_${randomUUID()}` };
    const file = await files.createPending(
      ownerProject,
      {
        filename: "foreign.png",
        content_type: "image/png",
        size_bytes: 68,
        sha256: "5".repeat(64),
        purpose: "generation_input",
      },
      now(),
    );
    await files.markValidating(ownerProject, file.id, now());
    await files.markAvailable(
      ownerProject,
      file.id,
      { media_type: "image", container: "png", width: 1, height: 1 },
      now(),
    );
    const foreignRequest = videoGenerationSchema.parse({
      model: "local-reference-release",
      prompt: "foreign input",
      aspect_ratio: "16:9",
      resolution: "0.2mp",
      duration: 15,
      input_files: [{ file_id: file.id, type: "image", role: "reference_image" }],
    });
    await expect(
      service.create(context, foreignRequest, "video", "generation", "/v1/videos/generations"),
    ).rejects.toThrow("invalid_input_media");

    clock = new Date(clock.getTime() + 23 * 60 * 60 * 1000 + 1);
    await expect(
      service.create(
        { ...context, projectId: ownerProject },
        foreignRequest,
        "video",
        "generation",
        "/v1/videos/generations",
      ),
    ).rejects.toThrow("input_ttl_too_short");
  });

  integrationTest("filters tasks by type, status, model, priority and creation time", async () => {
    if (!database) throw new Error("test database unavailable");
    let clock = new Date("2026-08-21T04:00:00.000Z");
    const now = () => new Date(clock);
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
      now,
    });
    const context = { organizationId: "org_integration", projectId: `project_${randomUUID()}` };
    const video = videoGenerationSchema.parse({
      model: "local-reference-release",
      prompt: "online video",
      aspect_ratio: "16:9",
      resolution: "0.2mp",
      duration: 15,
    });
    const first = await service.create(context, video, "video", "generation", "/v1/videos/generations");
    await service.cancel(context, first.task.id);
    clock = new Date(clock.getTime() + 1000);
    const image = imageGenerationSchema.parse({
      model: "local-reference-release",
      prompt: "batch image",
      size: "608x352",
      priority: "batch",
    });
    const second = await service.create(context, image, "image", "generation", "/v1/images/generations");

    const filtered = await service.list(context, {
      limit: 50,
      type: "image",
      statuses: ["queued"],
      model: "local-reference-release",
      priority: "batch",
      createdAfter: new Date("2026-08-21T04:00:00.500Z"),
      createdBefore: new Date("2026-08-21T04:00:01.500Z"),
    });
    expect(filtered.data.map((task) => task.id)).toEqual([second.task.id]);
    expect((await service.list(context, { limit: 50, statuses: ["canceled"] })).data.map((task) => task.id)).toEqual([
      first.task.id,
    ]);
  });

  integrationTest("uses signed filter-bound cursor pagination", async () => {
    if (!database) throw new Error("test database unavailable");
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
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
      await service.create(context, request, "video", "generation", "/v1/videos/generations", `page-${randomUUID()}`);
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

  integrationTest("expires input assets and fails unleased tasks atomically", async () => {
    if (!database) throw new Error("test database unavailable");
    let clock = new Date("2026-08-21T00:00:00.000Z");
    const now = () => new Date(clock);
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
      now,
    });
    const files = new FileRepository(database.client);
    const context = { organizationId: "org_integration", projectId: `project_${randomUUID()}` };
    const file = await files.createPending(
      context.projectId,
      {
        filename: "reference.png",
        content_type: "image/png",
        size_bytes: 68,
        sha256: "0".repeat(64),
        purpose: "generation_input",
      },
      now(),
    );
    await files.markValidating(context.projectId, file.id, now());
    await files.markAvailable(
      context.projectId,
      file.id,
      { media_type: "image", container: "png", width: 1, height: 1 },
      now(),
    );
    const request = videoGenerationSchema.parse({
      model: "local-reference-release",
      prompt: "asset expiration",
      aspect_ratio: "16:9",
      resolution: "0.2mp",
      duration: 15,
      input_files: [{ file_id: file.id, type: "image", role: "reference_image" }],
    });
    const created = await service.create(
      context,
      request,
      "video",
      "generation",
      "/v1/videos/generations",
      `expire-${randomUUID()}`,
    );
    clock = new Date(clock.getTime() + 25 * 60 * 60 * 1000);
    const expiration = new AssetExpirationRepository(database.client, { now });
    const claimed = await expiration.claim(10);
    expect(claimed.map((asset) => asset.id)).toContain(file.id);
    await expiration.complete(file.id);
    expect((await files.get(context.projectId, file.id))?.status).toBe("expired");
    const task = await service.get(context, created.task.id);
    expect(task?.status).toBe("failed");
    const rows = await database.client`SELECT error FROM tasks WHERE id=${created.task.id}`;
    expect(rows[0]?.error).toEqual(expect.objectContaining({ code: "input_asset_expired", retryable: false }));
    const eventCounts = await database.client`SELECT
      (SELECT count(*)::int FROM task_state_events WHERE task_id=${created.task.id} AND reason='input_asset_expired') AS state_events,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=${created.task.id} AND event_type='task.failed') AS outbox_events`;
    expect(eventCounts[0]?.state_events).toBe(1);
    expect(eventCounts[0]?.outbox_events).toBe(1);
  });

  integrationTest("reclaims expired uploads and interrupted media validation", async () => {
    if (!database) throw new Error("test database unavailable");
    let clock = new Date("2026-08-21T03:00:00.000Z");
    const now = () => new Date(clock);
    const files = new FileRepository(database.client);
    const projectId = `project_${randomUUID()}`;
    const input = {
      filename: "pending.png",
      content_type: "image/png" as const,
      size_bytes: 68,
      sha256: "1".repeat(64),
      purpose: "generation_input" as const,
    };
    const pending = await files.createPending(projectId, input, now());
    const validating = await files.createPending(projectId, { ...input, filename: "validating.png" }, now());
    await files.markValidating(projectId, validating.id, now());
    clock = new Date(clock.getTime() + 16 * 60 * 1000);

    const expiration = new AssetExpirationRepository(database.client, {
      now,
      reclaimAfterMilliseconds: 5 * 60 * 1000,
      validatingReclaimAfterMilliseconds: 15 * 60 * 1000,
    });
    const firstClaim = await expiration.claim(100);
    expect(firstClaim.map((asset) => asset.id)).toEqual(expect.arrayContaining([pending.id, validating.id]));

    clock = new Date(clock.getTime() + 6 * 60 * 1000);
    const reclaimed = await expiration.claim(100);
    expect(reclaimed.map((asset) => asset.id)).toEqual(expect.arrayContaining([pending.id, validating.id]));
    await expiration.complete(pending.id);
    await expiration.complete(validating.id);
    expect((await files.get(projectId, pending.id))?.status).toBe("expired");
    expect((await files.get(projectId, validating.id))?.status).toBe("expired");
  });

  integrationTest("defers input expiration while an execution lease is valid", async () => {
    if (!database) throw new Error("test database unavailable");
    let clock = new Date("2026-08-21T06:00:00.000Z");
    const now = () => new Date(clock);
    const files = new FileRepository(database.client);
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
      now,
    });
    const context = { organizationId: "org_integration", projectId: `project_${randomUUID()}` };
    const file = await files.createPending(
      context.projectId,
      {
        filename: "leased.png",
        content_type: "image/png",
        size_bytes: 68,
        sha256: "2".repeat(64),
        purpose: "generation_input",
      },
      now(),
    );
    await files.markValidating(context.projectId, file.id, now());
    await files.markAvailable(
      context.projectId,
      file.id,
      { media_type: "image", container: "png", width: 1, height: 1 },
      now(),
    );
    const request = videoGenerationSchema.parse({
      model: "local-reference-release",
      prompt: "leased input",
      aspect_ratio: "16:9",
      resolution: "0.2mp",
      duration: 15,
      input_files: [{ file_id: file.id, type: "image", role: "reference_image" }],
    });
    const created = await service.create(
      context,
      request,
      "video",
      "generation",
      "/v1/videos/generations",
      `lease-${randomUUID()}`,
    );
    const attemptId = `attempt_${randomUUID()}`;
    const leaseId = `lease_${randomUUID()}`;
    await database.client`INSERT INTO attempts (id, task_id, release_id, status, execution_key, created_at, updated_at)
      VALUES (${attemptId}, ${created.task.id}, 'release_local_reference', 'reserved', ${`execution_${randomUUID()}`}, ${now().toISOString()}, ${now().toISOString()})`;
    clock = new Date(clock.getTime() + 25 * 60 * 60 * 1000);
    const leaseExpiresAt = new Date(clock.getTime() + 10 * 60 * 1000);
    await database.client`INSERT INTO leases (id, attempt_id, worker_id, replica_id, expires_at, version)
      VALUES (${leaseId}, ${attemptId}, 'worker_integration', 'replica_integration', ${leaseExpiresAt.toISOString()}, 0)`;
    const expiration = new AssetExpirationRepository(database.client, { now });
    expect((await expiration.claim(100)).map((asset) => asset.id)).not.toContain(file.id);

    await database.client`UPDATE leases SET expires_at=${new Date(clock.getTime() - 1000).toISOString()} WHERE id=${leaseId}`;
    expect((await expiration.claim(100)).map((asset) => asset.id)).toContain(file.id);
  });
});
