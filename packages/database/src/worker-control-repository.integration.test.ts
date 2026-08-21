import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { capabilitiesSchema, videoGenerationSchema } from "@astra/contracts";
import { createDatabase } from "./index.ts";
import { SchedulingRepository } from "./scheduling-repository.ts";
import { TaskService } from "./task-service.ts";
import { canonicalHash, WorkerControlError, WorkerControlRepository } from "./worker-control-repository.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integrationTest = database ? test : test.skip;

afterAll(async () => {
  await database?.client.end();
});

const requestKey = "worker-integration-encryption-key-at-least-32-bytes";
const capabilities = capabilitiesSchema.parse({
  contract_version: "1.0",
  app: { name: "contract-reference", version: "1.0.0", build: "integration" },
  model_release: "release_local_reference",
  modalities: ["video", "image"],
  operations: ["generation", "edit"],
  max_concurrency: 1,
  capabilities: {
    aspect_ratios: ["16:9"],
    resolutions: ["0.2mp"],
    resolution_matrix: { "16:9/0.2mp": { width: 608, height: 352 } },
    durations: [5, 15],
    fps: [24],
    input_types: ["image", "video", "audio"],
    input_roles: ["reference_image", "reference_video", "reference_audio"],
    audio_modes: ["none", "native", "reference"],
    supports_cancel: true,
    supports_progress: true,
    supports_resume: false,
  },
  artifacts: {
    output_artifacts: [{ role: "result", content_types: ["video/mp4", "image/png"] }],
    max_outputs: 1,
    sidecar_manifest_allowed: false,
    post_processing: "model_app_only",
  },
});

async function fixture(now: () => Date) {
  if (!database) throw new Error("test_database_unavailable");
  const suffix = randomUUID().replaceAll("-", "");
  const poolId = `pool_worker_${suffix}`;
  const apiKeyId = `key_worker_${suffix}`;
  const replicaId = `replica_worker_${suffix}`;
  const bootstrapHash = createHash("sha256").update(`bootstrap:${suffix}`).digest("hex");
  const sessionHash = createHash("sha256").update(`session:${suffix}`).digest("hex");
  await database.client.begin(async (transaction) => {
    await transaction`INSERT INTO api_keys (
      id, organization_id, default_project_id, name, key_prefix, key_last_four, secret_hash,
      scopes, status, created_at, updated_at
    ) VALUES (
      ${apiKeyId}, 'org_local', 'project_local', ${`worker-${suffix}`}, ${suffix.slice(0, 12)},
      ${suffix.slice(-4)}, ${`integration-secret-${suffix}`}, ARRAY['tasks:create']::text[], 'active',
      ${now().toISOString()}, ${now().toISOString()}
    )`;
    await transaction`INSERT INTO model_pools (
      id, project_id, release_id, provider, region_id, gpu_sku, execution_mode, status, version,
      created_by, created_at, updated_at
    ) VALUES (
      ${poolId}, 'project_local', 'release_local_reference', 'reference', 'region_local', 'reference-gpu',
      'deployment', 'active', 1, 'integration', ${now().toISOString()}, ${now().toISOString()}
    )`;
    await transaction`INSERT INTO policy_versions (
      id, project_id, pool_id, policy_type, version, status, configuration, validation,
      reason, created_by, created_at, published_at
    ) VALUES (
      ${`policy_retry_${suffix}`}, 'project_local', ${poolId}, 'retry', 1, 'published',
      ${JSON.stringify({
        max_attempts: 3,
        initial_backoff_seconds: 5,
        max_backoff_seconds: 60,
        retryable_codes: ["worker_lost", "provider_timeout"],
      })},
      ${JSON.stringify({ policy_type: "retry", valid: true, errors: [], warnings: [] })},
      'Integration retry policy', 'integration', ${now().toISOString()}, ${now().toISOString()}
    )`;
    await transaction`INSERT INTO replicas (
      id, pool_id, release_id, provider, provider_resource_id, region_id, gpu_sku, image_digest,
      desired_state, observed_state, rollout_reserved, version, last_observed_at, created_at, updated_at
    ) VALUES (
      ${replicaId}, ${poolId}, 'release_local_reference', 'reference', ${`instance_${suffix}`},
      'region_local', 'reference-gpu', 'sha256:local-reference', 'provisioning', 'provisioning', false, 0,
      ${now().toISOString()}, ${now().toISOString()}, ${now().toISOString()}
    )`;
  });
  await database.client`INSERT INTO worker_bootstrap_tokens (
    id, token_hash, replica_id, release_id, expires_at, created_at
  ) VALUES (
    ${`bootstrap_${suffix}`}, ${bootstrapHash}, ${replicaId}, 'release_local_reference',
    ${new Date(now().getTime() + 60_000).toISOString()}, ${now().toISOString()}
  )`;
  let sequence = 0;
  const repository = new WorkerControlRepository(
    database.client,
    requestKey,
    now,
    (prefix) => `${prefix}_${++sequence}_${suffix}`,
  );
  const registered = await repository.register(
    {
      provider: "reference",
      region: "region_local",
      provider_instance_id: `instance_${suffix}`,
      replica_id: replicaId,
      pool_id: poolId,
      release_id: "release_local_reference",
      instance_fingerprint: `fingerprint_${suffix}`,
      hardware: { gpu_sku: "reference-gpu", gpu_count: 1, gpu_memory_bytes: 34_359_738_368 },
      capabilities,
    },
    bootstrapHash,
    {
      id: `session_${suffix}`,
      tokenHash: sessionHash,
      expiresAt: new Date(now().getTime() + 30 * 60_000),
    },
  );
  const identity = await repository.authenticate(sessionHash, registered.workerId);
  return { suffix, poolId, replicaId, repository, identity, bootstrapHash, apiKeyId };
}

async function reserveTask(context: Awaited<ReturnType<typeof fixture>>, now: () => Date, name: string) {
  if (!database) throw new Error("test_database_unavailable");
  await database.client`UPDATE replicas SET desired_state='ready', version=version+1 WHERE id=${context.replicaId}`;
  const task = await new TaskService(database.client, {
    requestEncryptionKey: requestKey,
    enforceAdmission: false,
    now,
  }).create(
    { organizationId: "org_local", projectId: "project_local" },
    videoGenerationSchema.parse({
      model: "local-reference-release",
      prompt: name,
      aspect_ratio: "16:9",
      resolution: "0.2mp",
      duration: 15,
    }),
    "video",
    "generation",
    "/v1/videos/generations",
    `${name}-${context.suffix}`,
  );
  await database.client`UPDATE tasks SET scheduling_profile=${JSON.stringify({
    integration_case: name,
    fixture: context.suffix,
  })} WHERE id=${task.task.id}`;
  await database.client`INSERT INTO admission_reservations (
      id, project_id, api_key_id, resource_type, resource_id, lane, status,
      estimated_gpu_seconds, estimated_cost_minor, reserved_bytes, created_at
    ) VALUES (
      ${`reservation_worker_${context.suffix}_${name}`}, 'project_local', ${context.apiKeyId}, 'task',
      ${task.task.id}, 'online', 'held', 840, 0, 0, ${now().toISOString()}
    )`;
  const scheduling = new SchedulingRepository(database.client, now);
  const snapshot = await scheduling.snapshot(100, 60);
  const taskSnapshot = snapshot.tasks.find((item) => item.taskId === task.task.id);
  const replica = snapshot.replicas.find((item) => item.replicaId === context.replicaId);
  if (!taskSnapshot || !replica) throw new Error("worker_scheduling_snapshot_incomplete");
  const reservation = await scheduling.reserve({
    decisionId: `decision_${name}_${context.suffix}`,
    attemptId: `attempt_${name}_${context.suffix}`,
    leaseId: `lease_${name}_${context.suffix}`,
    executionKey: `execution_${name}_${context.suffix}`,
    traceId: `trace_${name}_${context.suffix}`,
    task: taskSnapshot,
    replica,
    slotIndex: 0,
    reason: "integration",
    reservationSeconds: 30,
    workerFreshnessSeconds: 60,
    inputSnapshot: { test: name },
  });
  if (!reservation) throw new Error("worker_reservation_failed");
  const leased = await context.repository.lease(
    context.identity,
    {
      sequence: 1,
      max_concurrency: 1,
      running_slots: 0,
      reserved_slots: 0,
      available_slots: 1,
      capabilities_hash: canonicalHash(capabilities),
    },
    canonicalHash({ name, sequence: 1 }),
    30,
  );
  if (!leased) throw new Error("worker_lease_missing");
  return { task, leased };
}

describe("WorkerControlRepository PostgreSQL contract", () => {
  integrationTest("rotates a worker session atomically and rejects a concurrent stale rotation", async () => {
    if (!database) throw new Error("test_database_unavailable");
    const clock = new Date("2026-08-22T00:30:00.000Z");
    const context = await fixture(() => new Date(clock));
    const candidates = ["left", "right"].map((side) => ({
      id: `session_${side}_${context.suffix}`,
      tokenHash: createHash("sha256").update(`session:${side}:${context.suffix}`).digest("hex"),
      expiresAt: new Date(clock.getTime() + 30 * 60_000),
    }));

    const outcomes = await Promise.allSettled(
      candidates.map((candidate) => context.repository.rotateSession(context.identity, candidate)),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);

    const sessions = await database.client`SELECT id, status, replaced_by_id FROM worker_sessions
      WHERE worker_id=${context.identity.workerId} ORDER BY created_at, id`;
    const oldSession = sessions.find((row) => String(row.id) === context.identity.sessionId);
    const activeSessions = sessions.filter((row) => row.status === "active");
    expect(oldSession?.status).toBe("rotated");
    expect(activeSessions).toHaveLength(1);
    expect(oldSession?.replaced_by_id).toBe(activeSessions[0]?.id);
  });

  integrationTest(
    "binds one-time identity, leases only preassigned work and commits byte-preserving output",
    async () => {
      if (!database) throw new Error("test_database_unavailable");
      const clock = new Date("2026-08-22T01:00:00.000Z");
      const now = () => new Date(clock);
      const context = await fixture(now);
      const replica =
        await database.client`SELECT desired_state, observed_state FROM replicas WHERE id=${context.replicaId}`;
      expect(replica[0]).toMatchObject({ desired_state: "provisioning", observed_state: "ready" });
      await expect(
        context.repository.register(
          {
            provider: "reference",
            region: "region_local",
            provider_instance_id: `instance_${context.suffix}`,
            replica_id: context.replicaId,
            pool_id: "pool_local_reference",
            release_id: "release_local_reference",
            instance_fingerprint: `fingerprint_${context.suffix}`,
            hardware: { gpu_sku: "reference-gpu", gpu_count: 1, gpu_memory_bytes: 34_359_738_368 },
            capabilities,
          },
          context.bootstrapHash,
          {
            id: `session_replay_${context.suffix}`,
            tokenHash: "c".repeat(64),
            expiresAt: new Date(clock.getTime() + 60_000),
          },
        ),
      ).rejects.toEqual(expect.objectContaining({ code: "invalid_bootstrap_token" }));

      const { task, leased } = await reserveTask(context, now, "complete");
      const heartbeatInput = {
        sequence: 1,
        observed_at: now().toISOString(),
        running_slots: 1,
        reserved_slots: 0,
        executions: [
          {
            attempt_id: leased.attemptId,
            lease_id: leased.leaseId,
            lease_version: leased.leaseVersion,
            status: "running" as const,
            progress: 25,
          },
        ],
        health: { model_app_ready: true, disk_available_bytes: 1_000_000, gpu_memory_used_bytes: 1 },
      };
      const heartbeat = await context.repository.heartbeat(
        context.identity,
        heartbeatInput,
        canonicalHash(heartbeatInput),
        30,
      );
      expect(heartbeat.leases[0]).toMatchObject({ lease_version: leased.leaseVersion + 1, cancel_requested: false });
      const replay = await context.repository.heartbeat(
        context.identity,
        heartbeatInput,
        canonicalHash(heartbeatInput),
        30,
      );
      expect(replay).toEqual(heartbeat);
      const leaseVersion = heartbeat.leases[0]?.lease_version;
      if (leaseVersion === undefined) throw new Error("renewed_lease_missing");
      const heartbeatExecution = heartbeatInput.executions[0];
      if (!heartbeatExecution) throw new Error("heartbeat_execution_missing");
      const secondHeartbeatInput = {
        ...heartbeatInput,
        sequence: 2,
        executions: [{ ...heartbeatExecution, lease_version: leaseVersion, progress: 50 }],
      };
      const secondHeartbeat = await context.repository.heartbeat(
        context.identity,
        secondHeartbeatInput,
        canonicalHash(secondHeartbeatInput),
        30,
      );
      expect(secondHeartbeat.leases[0]?.lease_version).toBe(leaseVersion + 1);
      const manifest = {
        execution_id: leased.executionKey,
        status: "completed" as const,
        outputs: [
          {
            role: "result",
            path: `/work/tasks/${leased.attemptId}/outputs/result.png`,
            content_type: "image/png" as const,
            sha256: "d".repeat(64),
            size_bytes: 68,
            media: { media_type: "image" as const, container: "png_pipe", width: 1, height: 1, video_codec: "png" },
            provenance: { producer: "model_app" as const, transformations: [] },
          },
        ],
        usage: { gpu_seconds: 1 },
      };
      const prepared = await context.repository.prepareOutputs(context.identity, leased.attemptId, {
        lease_id: leased.leaseId,
        lease_version: leaseVersion,
        manifest,
      });
      const completeFiles = {
        lease_id: leased.leaseId,
        lease_version: leaseVersion,
        files: prepared.map((file) => ({ file_id: file.fileId, sha256: file.sha256, size_bytes: file.sizeBytes })),
      };
      await context.repository.preparedOutputs(context.identity, leased.attemptId, completeFiles);
      const committed = await context.repository.commitOutputs(
        context.identity,
        leased.attemptId,
        completeFiles,
        new Map(prepared.map((file) => [file.fileId, file.declaredMedia])),
      );
      const completed = await context.repository.complete(context.identity, leased.attemptId, {
        lease_id: leased.leaseId,
        lease_version: committed.leaseVersion,
        execution_id: leased.executionKey,
        completed_at: now().toISOString(),
        usage: manifest.usage,
      });
      expect(completed).toMatchObject({ attempt_status: "completed", task_status: "completed" });
      const rows = await database.client`SELECT t.status, a.status AS attempt_status, l.status AS lease_status,
        f.status AS file_status FROM tasks t JOIN attempts a ON a.task_id=t.id JOIN leases l ON l.attempt_id=a.id
        JOIN attempt_output_files aof ON aof.attempt_id=a.id JOIN files f ON f.id=aof.file_id
      WHERE t.id=${task.task.id}`;
      expect(rows[0]).toMatchObject({
        status: "completed",
        attempt_status: "completed",
        lease_status: "released",
        file_status: "available",
      });
      const serviceTime = await database.client`SELECT s.outcome, s.service_seconds, p.sample_count,
          p.p75_seconds, p.p95_seconds, p.ewma_seconds
        FROM service_time_samples s JOIN service_time_profiles p ON p.release_id=s.release_id
          AND p.gpu_sku=s.gpu_sku AND p.dimensions_hash=s.dimensions_hash
        WHERE s.attempt_id=${leased.attemptId}`;
      expect({ ...serviceTime[0], sample_count: Number(serviceTime[0]?.sample_count) }).toMatchObject({
        outcome: "completed",
        service_seconds: 1,
        sample_count: 1,
        p75_seconds: 1,
        p95_seconds: 1,
        ewma_seconds: 1,
      });
    },
  );

  integrationTest("requeues a declared retryable failure once and keeps the task reservation held", async () => {
    if (!database) throw new Error("test_database_unavailable");
    const clock = new Date("2026-08-22T01:30:00.000Z");
    const now = () => new Date(clock);
    const context = await fixture(now);
    const { task, leased } = await reserveTask(context, now, "retryable");
    const failure = {
      lease_id: leased.leaseId,
      lease_version: leased.leaseVersion,
      execution_id: leased.executionKey,
      failed_at: now().toISOString(),
      error: { code: "worker_lost", message: "worker connection lost", retryable: true },
      usage: { gpu_seconds: 2 },
    };
    const failed = await context.repository.fail(context.identity, leased.attemptId, failure);
    expect(failed).toMatchObject({ attempt_status: "failed", task_status: "queued" });
    expect(await context.repository.fail(context.identity, leased.attemptId, failure)).toEqual(failed);
    const rows = await database.client`SELECT t.status, t.retry_not_before, t.last_retry_reason,
        a.retry_disposition, a.retry_not_before AS attempt_retry_not_before,
        ar.status AS reservation_status,
        (SELECT count(*)::int FROM usage_ledger u WHERE u.source_type='attempt'
          AND u.source_id=a.id AND u.metric='gpu_seconds') AS usage_entries,
        (SELECT count(*)::int FROM service_time_samples s WHERE s.attempt_id=a.id) AS service_samples
      FROM tasks t JOIN attempts a ON a.task_id=t.id
      LEFT JOIN admission_reservations ar ON ar.resource_type='task' AND ar.resource_id=t.id
      WHERE t.id=${task.task.id}`;
    expect(rows[0]).toMatchObject({
      status: "queued",
      last_retry_reason: "worker_lost",
      retry_disposition: "scheduled",
      reservation_status: "held",
      usage_entries: 1,
      service_samples: 0,
    });
    expect(new Date(rows[0]?.retry_not_before as Date).toISOString()).toBe("2026-08-22T01:30:05.000Z");
    expect(new Date(rows[0]?.attempt_retry_not_before as Date).toISOString()).toBe("2026-08-22T01:30:05.000Z");
  });

  integrationTest("terminates an undeclared failure without scheduling another attempt", async () => {
    if (!database) throw new Error("test_database_unavailable");
    const clock = new Date("2026-08-22T01:45:00.000Z");
    const now = () => new Date(clock);
    const context = await fixture(now);
    const { task, leased } = await reserveTask(context, now, "terminal");
    const failed = await context.repository.fail(context.identity, leased.attemptId, {
      lease_id: leased.leaseId,
      lease_version: leased.leaseVersion,
      execution_id: leased.executionKey,
      failed_at: now().toISOString(),
      error: { code: "invalid_output", message: "output contract rejected", retryable: true },
      usage: {},
    });
    expect(failed).toMatchObject({ attempt_status: "failed", task_status: "failed" });
    const rows = await database.client`SELECT t.status, a.retry_disposition, ar.status AS reservation_status
      FROM tasks t JOIN attempts a ON a.task_id=t.id
      LEFT JOIN admission_reservations ar ON ar.resource_type='task' AND ar.resource_id=t.id
      WHERE t.id=${task.task.id}`;
    expect(rows[0]).toMatchObject({
      status: "failed",
      retry_disposition: "not_retryable",
      reservation_status: "released",
    });
  });

  integrationTest("recovers unknown leases inside grace and rejects them after orphan requeue", async () => {
    if (!database) throw new Error("test_database_unavailable");
    let clock = new Date("2026-08-22T02:00:00.000Z");
    const now = () => new Date(clock);
    const context = await fixture(now);
    const { task, leased } = await reserveTask(context, now, "orphan");
    clock = new Date(clock.getTime() + 46_000);
    const missing = await context.repository.reconcileLiveness(45, 180, 100);
    expect(missing.unknown).toBeGreaterThanOrEqual(1);
    expect(missing.orphaned).toBe(0);
    expect((await database.client`SELECT status FROM workers WHERE id=${context.identity.workerId}`)[0]?.status).toBe(
      "unknown",
    );
    const recoveredLease = await context.repository.lease(
      context.identity,
      {
        sequence: 2,
        max_concurrency: 1,
        running_slots: 0,
        reserved_slots: 0,
        available_slots: 1,
        capabilities_hash: canonicalHash(capabilities),
      },
      canonicalHash({ recovery: true, sequence: 2 }),
      30,
    );
    if (!recoveredLease) throw new Error("recovered_lease_missing");
    expect(recoveredLease.attemptId).toBe(leased.attemptId);
    expect(recoveredLease.leaseVersion).toBe(leased.leaseVersion + 1);
    const recoveredInput = {
      sequence: 3,
      observed_at: now().toISOString(),
      running_slots: 1,
      reserved_slots: 0,
      executions: [
        {
          attempt_id: leased.attemptId,
          lease_id: leased.leaseId,
          lease_version: recoveredLease.leaseVersion,
          status: "running" as const,
          progress: 50,
        },
      ],
      health: { model_app_ready: true, disk_available_bytes: 1, gpu_memory_used_bytes: 1 },
    };
    const recovered = await context.repository.heartbeat(
      context.identity,
      recoveredInput,
      canonicalHash(recoveredInput),
      30,
    );
    expect(recovered.leases[0]?.lease_version).toBe(recoveredLease.leaseVersion + 1);
    clock = new Date(clock.getTime() + 46_000);
    await context.repository.reconcileLiveness(45, 180, 100);
    clock = new Date(clock.getTime() + 181_000);
    expect((await context.repository.reconcileLiveness(45, 180, 100)).orphaned).toBeGreaterThanOrEqual(1);
    const rows = await database.client`SELECT t.status, a.status AS attempt_status, l.status AS lease_status
      FROM tasks t JOIN attempts a ON a.task_id=t.id JOIN leases l ON l.attempt_id=a.id WHERE t.id=${task.task.id}`;
    expect(rows[0]).toMatchObject({ status: "queued", attempt_status: "abandoned", lease_status: "expired" });
    const recoveredExecution = recoveredInput.executions[0];
    if (!recoveredExecution) throw new Error("recovered_execution_missing");
    await expect(
      context.repository.heartbeat(
        context.identity,
        {
          ...recoveredInput,
          sequence: 4,
          executions: [{ ...recoveredExecution, lease_version: recovered.leases[0]?.lease_version ?? 0 }],
        },
        canonicalHash({ late: true }),
        30,
      ),
    ).rejects.toBeInstanceOf(WorkerControlError);
  });
});
