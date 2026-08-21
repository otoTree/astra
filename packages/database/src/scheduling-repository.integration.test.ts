import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { videoGenerationSchema } from "@astra/contracts";
import { EventRepository } from "./event-repository.ts";
import { createDatabase } from "./index.ts";
import { SchedulingRepository } from "./scheduling-repository.ts";
import { TaskService } from "./task-service.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

const profileHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

afterAll(async () => {
  await database?.client.end();
});

describe("SchedulingRepository PostgreSQL integration", () => {
  integrationTest("converges concurrent schedulers to one immutable reservation and requeues on expiry", async () => {
    if (!database) throw new Error("test_database_unavailable");
    const suffix = randomUUID().replaceAll("-", "");
    let clock = new Date("2026-08-21T08:00:00.000Z");
    const now = () => new Date(clock);
    const context = { organizationId: "org_local", projectId: "project_local" };
    const taskService = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
      now,
    });
    const task = await taskService.create(
      context,
      videoGenerationSchema.parse({
        model: "local-reference-release",
        prompt: `schedule-${suffix}`,
        aspect_ratio: "16:9",
        resolution: "0.2mp",
        duration: 15,
      }),
      "video",
      "generation",
      "/v1/videos/generations",
      `schedule-${suffix}`,
    );
    await database.client`UPDATE tasks SET scheduling_profile=${JSON.stringify({ test_marker: suffix })}
      WHERE id=${task.task.id}`;
    const replicaId = `replica_schedule_${suffix}`;
    const workerId = `worker_schedule_${suffix}`;
    await database.client`INSERT INTO replicas (
      id, pool_id, release_id, provider, provider_resource_id, region_id, gpu_sku, image_digest,
      desired_state, observed_state, rollout_reserved, version, last_observed_at, created_at, updated_at
    ) VALUES (
      ${replicaId}, 'pool_local_reference', 'release_local_reference', 'reference', ${`resource_${suffix}`},
      'region_local', 'reference-gpu', 'sha256:local-reference', 'ready', 'ready', false, 3,
      ${now().toISOString()}, ${now().toISOString()}, ${now().toISOString()}
    )`;
    await database.client`INSERT INTO workers (
      id, replica_id, release_id, contract_version, status, capabilities, last_heartbeat_at, created_at, updated_at
    ) VALUES (
      ${workerId}, ${replicaId}, 'release_local_reference', '1.0', 'ready',
      ${JSON.stringify({ max_concurrency: 4 })}, ${now().toISOString()}, ${now().toISOString()}, ${now().toISOString()}
    )`;

    let leftSequence = 0;
    let rightSequence = 0;
    const left = new SchedulingRepository(
      database.client,
      now,
      (prefix) => `${prefix}_left_${++leftSequence}_${suffix}`,
    );
    const right = new SchedulingRepository(
      database.client,
      now,
      (prefix) => `${prefix}_right_${++rightSequence}_${suffix}`,
    );
    const [leftSnapshot, rightSnapshot] = await Promise.all([left.snapshot(100, 60), right.snapshot(100, 60)]);
    const taskSnapshot = leftSnapshot.tasks.find((item) => item.taskId === task.task.id);
    const replicaSnapshot = leftSnapshot.replicas.find((item) => item.replicaId === replicaId);
    const rightTask = rightSnapshot.tasks.find((item) => item.taskId === task.task.id);
    const rightReplica = rightSnapshot.replicas.find((item) => item.replicaId === replicaId);
    if (!taskSnapshot || !replicaSnapshot || !rightTask || !rightReplica) throw new Error("snapshot_incomplete");
    expect(replicaSnapshot.maximumConcurrency).toBe(1);
    expect(taskSnapshot).toMatchObject({
      expectedGpuSeconds: 840,
      predictionP95Seconds: 840,
      predictionSource: "cold_baseline",
      projectWeight: 100,
    });

    const reserve = (
      repository: SchedulingRepository,
      side: string,
      currentTask: typeof taskSnapshot,
      currentReplica: typeof replicaSnapshot,
    ) =>
      repository.reserve({
        decisionId: `decision_${side}_${suffix}`,
        attemptId: `attempt_${side}_${suffix}`,
        leaseId: `lease_${side}_${suffix}`,
        executionKey: `execution_${side}_${suffix}`,
        traceId: `trace_${side}_${suffix}`,
        task: currentTask,
        replica: currentReplica,
        slotIndex: 0,
        reason: "online_priority",
        reservationSeconds: 30,
        workerFreshnessSeconds: 60,
        inputSnapshot: { observed_at: leftSnapshot.observedAt, task_id: task.task.id, replica_id: replicaId },
      });
    const results = await Promise.all([
      reserve(left, "left", taskSnapshot, replicaSnapshot),
      reserve(right, "right", rightTask, rightReplica),
    ]);
    const successful = results.filter((item) => item !== undefined);
    expect(successful).toHaveLength(1);
    const reservation = successful[0];
    if (!reservation) throw new Error("reservation_missing");

    const persisted = await database.client`SELECT
      (SELECT count(*)::int FROM scheduling_decisions WHERE task_id=${task.task.id}) AS decisions,
      (SELECT count(*)::int FROM attempts WHERE task_id=${task.task.id} AND status='reserved') AS attempts,
      (SELECT count(*)::int FROM leases l JOIN attempts a ON a.id=l.attempt_id
        WHERE a.task_id=${task.task.id} AND l.status='reserved') AS leases,
      (SELECT expected_gpu_seconds FROM attempts WHERE task_id=${task.task.id} AND status='reserved') AS expected_gpu_seconds,
      (SELECT prediction_source FROM attempts WHERE task_id=${task.task.id} AND status='reserved') AS prediction_source,
      (SELECT virtual_gpu_milliseconds FROM project_scheduling_accounts
        WHERE release_id='release_local_reference' AND project_id='project_local' AND lane='online') AS virtual_gpu_milliseconds,
      (SELECT assigned_gpu_seconds FROM scheduler_lane_accounts
        WHERE release_id='release_local_reference' AND lane='online') AS lane_gpu_seconds`;
    expect(persisted[0]).toMatchObject({
      decisions: 1,
      attempts: 1,
      leases: 1,
      expected_gpu_seconds: 840,
      prediction_source: "cold_baseline",
    });
    expect(Number(persisted[0]?.virtual_gpu_milliseconds)).toBeGreaterThanOrEqual(8_400);
    expect(Number(persisted[0]?.lane_gpu_seconds)).toBeGreaterThanOrEqual(840);
    const eventRepository = new EventRepository(database.client, now);
    expect((await eventRepository.taskQueueState(task.task.id))?.candidate).toBeUndefined();
    await expect(
      (async () => {
        await database.client`UPDATE scheduling_decisions SET reason='rewritten' WHERE id=${reservation.decisionId}`;
      })(),
    ).rejects.toThrow("immutable_scheduling_decision");

    clock = new Date(clock.getTime() + 31_000);
    expect(await left.expireReservations(100)).toBeGreaterThanOrEqual(1);
    const terminal = await database.client`SELECT a.status AS attempt_status, l.status AS lease_status,
        t.status AS task_status, t.version AS task_version
      FROM attempts a JOIN leases l ON l.attempt_id=a.id JOIN tasks t ON t.id=a.task_id
      WHERE a.id=${reservation.attemptId}`;
    expect(terminal[0]).toMatchObject({
      attempt_status: "expired",
      lease_status: "expired",
      task_status: "queued",
      task_version: 2,
    });
    expect((await eventRepository.taskQueueState(task.task.id))?.candidate?.taskId).toBe(task.task.id);
  });

  integrationTest(
    "uses a sufficiently sampled P75 and EWMA profile without crossing scheduling dimensions",
    async () => {
      if (!database) throw new Error("test_database_unavailable");
      const suffix = randomUUID().replaceAll("-", "");
      const now = () => new Date("2026-08-21T08:30:00.000Z");
      const service = new TaskService(database.client, {
        requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
        enforceAdmission: false,
        now,
      });
      const task = await service.create(
        { organizationId: "org_local", projectId: "project_local" },
        videoGenerationSchema.parse({
          model: "local-reference-release",
          prompt: `profile-${suffix}`,
          aspect_ratio: "16:9",
          resolution: "0.2mp",
          duration: 15,
        }),
        "video",
        "generation",
        "/v1/videos/generations",
        `profile-${suffix}`,
      );
      const dimensions = { test_marker: suffix };
      const dimensionsHash = profileHash(dimensions);
      await database.client.begin(async (transaction) => {
        await transaction`UPDATE tasks SET scheduling_profile=${JSON.stringify(dimensions)} WHERE id=${task.task.id}`;
        await transaction`INSERT INTO service_time_profiles (
        id, release_id, gpu_sku, dimensions_hash, dimensions, sample_count, p75_seconds, p95_seconds,
        ewma_seconds, last_service_seconds, last_sample_at, version, created_at, updated_at
      ) VALUES (
        ${`serviceprofile_${suffix}`}, 'release_local_reference', 'reference-gpu', ${dimensionsHash},
        ${JSON.stringify(dimensions)}, 30, 600, 900, 500, 500, ${now().toISOString()}, 1,
        ${now().toISOString()}, ${now().toISOString()}
      )`;
      });
      const replicaId = `replica_profile_${suffix}`;
      const workerId = `worker_profile_${suffix}`;
      await database.client`INSERT INTO replicas (
      id, pool_id, release_id, provider, provider_resource_id, region_id, gpu_sku, image_digest,
      desired_state, observed_state, rollout_reserved, version, last_observed_at, created_at, updated_at
    ) VALUES (
      ${replicaId}, 'pool_local_reference', 'release_local_reference', 'reference', ${`profile_resource_${suffix}`},
      'region_local', 'reference-gpu', 'sha256:local-reference', 'ready', 'ready', false, 1,
      ${now().toISOString()}, ${now().toISOString()}, ${now().toISOString()}
    )`;
      await database.client`INSERT INTO workers (
      id, replica_id, release_id, contract_version, status, capabilities, last_heartbeat_at, created_at, updated_at
    ) VALUES (
      ${workerId}, ${replicaId}, 'release_local_reference', '1.0', 'ready',
      ${JSON.stringify({ max_concurrency: 1 })}, ${now().toISOString()}, ${now().toISOString()}, ${now().toISOString()}
    )`;

      const snapshot = await new SchedulingRepository(database.client, now).snapshot(100, 60);
      expect(snapshot.tasks.find((candidate) => candidate.taskId === task.task.id)).toMatchObject({
        expectedGpuSeconds: 575,
        predictionP95Seconds: 900,
        predictionSource: "profile",
      });
    },
  );

  integrationTest("rejects stale replica and task versions without writing a decision", async () => {
    if (!database) throw new Error("test_database_unavailable");
    const suffix = randomUUID().replaceAll("-", "");
    const now = () => new Date("2026-08-21T09:00:00.000Z");
    const service = new TaskService(database.client, {
      requestEncryptionKey: "integration-encryption-key-at-least-32-bytes",
      enforceAdmission: false,
      now,
    });
    const task = await service.create(
      { organizationId: "org_local", projectId: "project_local" },
      videoGenerationSchema.parse({
        model: "local-reference-release",
        prompt: `stale-${suffix}`,
        aspect_ratio: "16:9",
        resolution: "0.2mp",
        duration: 15,
      }),
      "video",
      "generation",
      "/v1/videos/generations",
      `stale-${suffix}`,
    );
    const replicaId = `replica_stale_${suffix}`;
    const workerId = `worker_stale_${suffix}`;
    await database.client`INSERT INTO replicas (
      id, pool_id, release_id, provider, region_id, gpu_sku, image_digest, desired_state, observed_state,
      rollout_reserved, version, last_observed_at, created_at, updated_at
    ) VALUES (
      ${replicaId}, 'pool_local_reference', 'release_local_reference', 'reference', 'region_local',
      'reference-gpu', 'sha256:local-reference', 'ready', 'ready', false, 1, ${now().toISOString()},
      ${now().toISOString()}, ${now().toISOString()}
    )`;
    await database.client`INSERT INTO workers (
      id, replica_id, release_id, contract_version, status, capabilities, last_heartbeat_at, created_at, updated_at
    ) VALUES (
      ${workerId}, ${replicaId}, 'release_local_reference', '1.0', 'ready',
      ${JSON.stringify({ max_concurrency: 1 })}, ${now().toISOString()}, ${now().toISOString()}, ${now().toISOString()}
    )`;
    const repository = new SchedulingRepository(database.client, now);
    const snapshot = await repository.snapshot(100, 60);
    const taskSnapshot = snapshot.tasks.find((item) => item.taskId === task.task.id);
    const replicaSnapshot = snapshot.replicas.find((item) => item.replicaId === replicaId);
    if (!taskSnapshot || !replicaSnapshot) throw new Error("snapshot_incomplete");
    await database.client`UPDATE replicas SET version=version+1 WHERE id=${replicaId}`;
    const reservation = await repository.reserve({
      decisionId: `decision_stale_${suffix}`,
      attemptId: `attempt_stale_${suffix}`,
      leaseId: `lease_stale_${suffix}`,
      executionKey: `execution_stale_${suffix}`,
      traceId: `trace_stale_${suffix}`,
      task: taskSnapshot,
      replica: replicaSnapshot,
      slotIndex: 0,
      reason: "online_priority",
      reservationSeconds: 30,
      workerFreshnessSeconds: 60,
      inputSnapshot: { observed_at: snapshot.observedAt },
    });
    expect(reservation).toBeUndefined();
    expect(
      Number(
        (
          await database.client`SELECT count(*)::int AS count FROM scheduling_decisions WHERE id=${`decision_stale_${suffix}`}`
        )[0]?.count,
      ),
    ).toBe(0);
  });
});
