import { afterAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { capabilitiesSchema } from "@astra/contracts";
import { canonicalHash, createDatabase, ProviderOperationRepository, WorkerControlRepository } from "@astra/database";
import { ReferenceProviderOperator } from "@astra/provider-reference";
import { ProviderOperationReconciler } from "./reconciler.ts";
import { RolloutController } from "./rollout-controller.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integrationTest = database ? test : test.skip;

afterAll(async () => {
  await database?.client.end();
});

describe("RolloutController PostgreSQL contract", () => {
  integrationTest("prewarms, validates, drains and replaces without exposing bootstrap material", async () => {
    if (!database) throw new Error("test database unavailable");
    const suffix = randomUUID().replaceAll("-", "");
    const ids = {
      organization: `org_rollout_${suffix}`,
      project: `project_rollout_${suffix}`,
      model: `model_rollout_${suffix}`,
      sourceRelease: `release_source_${suffix}`,
      targetRelease: `release_target_${suffix}`,
      region: `region_rollout_${suffix}`,
      pool: `pool_rollout_${suffix}`,
      sourceReplica: `replica_source_${suffix}`,
      sourceWorker: `worker_source_${suffix}`,
      rollout: `rollout_${suffix}`,
      snapshot: `snapshot_${suffix}`,
    };
    const provider = `reference_rollout_${suffix}`;
    const sourceDigest = `sha256:${"1".repeat(64)}`;
    const targetDigest = `sha256:${"2".repeat(64)}`;
    const manifest = {
      max_concurrency: 1,
      resource_requirements: { gpu_skus: ["rtx5090"], gpu_memory_bytes: 34359738368, concurrency: 1 },
    };
    const strategy = {
      max_surge: 1,
      max_unavailable: 0,
      batch_size: 1,
      readiness_timeout_seconds: 1800,
      readiness_stability_seconds: 60,
      progress_deadline_seconds: 7200,
      pause_on_failure: true,
      maximum_failure_rate_basis_points: 500,
      maximum_duration_regression_basis_points: 2500,
      maximum_extra_cost_minor: 600,
      currency: "CNY",
      rollback_retention_seconds: 604800,
    };
    const startedAt = new Date("2026-08-22T00:00:00.000Z");
    let current = startedAt;
    const now = () => current;
    await database.client.begin(async (transaction) => {
      await transaction`INSERT INTO organizations (id, name, status) VALUES (${ids.organization}, ${suffix}, 'active')`;
      await transaction`INSERT INTO projects (id, organization_id, name, status)
        VALUES (${ids.project}, ${ids.organization}, ${suffix}, 'active')`;
      await transaction`INSERT INTO models (
          id, project_id, alias, modality, description, status, version, created_at, updated_at
        ) VALUES (
          ${ids.model}, ${ids.project}, ${`rollout-${suffix}`}, 'video', '', 'active', 1,
          ${startedAt.toISOString()}, ${startedAt.toISOString()}
        )`;
      for (const release of [
        {
          id: ids.sourceRelease,
          alias: `source-${suffix}`,
          digest: sourceDigest,
          maturity: "stable",
          image: "registry.test/astra/source:stable",
        },
        {
          id: ids.targetRelease,
          alias: `target-${suffix}`,
          digest: targetDigest,
          maturity: "candidate",
          image: "registry.test/astra/target:candidate",
        },
      ]) {
        await transaction`INSERT INTO model_releases (
            id, project_id, model_id, alias, maturity, source_image, image_digest, workflow_hash,
            manifest, manifest_digest, manifest_media_type, config_digest, status, version,
            accept_new_tasks, accept_existing_tasks, created_by, created_at
          ) VALUES (
            ${release.id}, ${ids.project}, ${ids.model}, ${release.alias}, ${release.maturity}, ${release.image}, ${release.digest},
            ${"a".repeat(64)}, ${JSON.stringify(manifest)}, ${release.digest},
            'application/vnd.oci.image.manifest.v1+json', ${release.digest}, 'approved', 1,
            ${release.id === ids.sourceRelease}, true, 'test', ${startedAt.toISOString()}
          )`;
      }
      await transaction`INSERT INTO provider_regions (id, provider, name, status, created_at, updated_at)
        VALUES (${ids.region}, ${provider}, 'Rollout Region', 'healthy', ${startedAt.toISOString()}, ${startedAt.toISOString()})`;
      await transaction`INSERT INTO provider_inventory (
          id, provider, region_id, gpu_sku, gpu_memory_bytes, available_replicas,
          price_per_gpu_hour_minor, currency, snapshot_version, observed_at, created_at
        ) VALUES (
          ${`inventory_${suffix}`}, ${provider}, ${ids.region}, 'rtx5090', 34359738368, 10,
          300, 'CNY', ${ids.snapshot}, ${startedAt.toISOString()}, ${startedAt.toISOString()}
        )`;
      await transaction`INSERT INTO provider_snapshot_runs (
          id, provider, contract_version, status, observed_at, expires_at, payload_hash,
          object_count, quarantine_reasons, started_at, completed_at
        ) VALUES (
          ${ids.snapshot}, ${provider}, 'reference-v1', 'published', ${startedAt.toISOString()},
          ${new Date(startedAt.getTime() + 86400000).toISOString()}, ${"b".repeat(64)}, 1, '[]',
          ${startedAt.toISOString()}, ${startedAt.toISOString()}
        )`;
      await transaction`INSERT INTO provider_snapshot_state (
          provider, latest_attempt_run_id, latest_published_run_id, status, observed_at,
          expires_at, version, updated_at
        ) VALUES (
          ${provider}, ${ids.snapshot}, ${ids.snapshot}, 'fresh', ${startedAt.toISOString()},
          ${new Date(startedAt.getTime() + 86400000).toISOString()}, 1, ${startedAt.toISOString()}
        )`;
      await transaction`INSERT INTO model_pools (
          id, project_id, release_id, provider, region_id, gpu_sku, execution_mode, status,
          version, created_by, created_at, updated_at
        ) VALUES (
          ${ids.pool}, ${ids.project}, ${ids.sourceRelease}, ${provider}, ${ids.region}, 'rtx5090',
          'deployment', 'active', 1, 'test', ${startedAt.toISOString()}, ${startedAt.toISOString()}
        )`;
      await transaction`INSERT INTO replicas (
          id, pool_id, release_id, provider, provider_resource_id, region_id, gpu_sku, image_digest,
          desired_state, observed_state, rollout_reserved, version, last_observed_at, created_at, updated_at
        ) VALUES (
          ${ids.sourceReplica}, ${ids.pool}, ${ids.sourceRelease}, ${provider}, ${`source_instance_${suffix}`},
          ${ids.region}, 'rtx5090', ${sourceDigest}, 'ready', 'ready', false, 0,
          ${startedAt.toISOString()}, ${startedAt.toISOString()}, ${startedAt.toISOString()}
        )`;
      await transaction`INSERT INTO workers (
          id, replica_id, release_id, contract_version, status, capabilities, provider, region_id,
          provider_instance_id, pool_id, instance_fingerprint, hardware, capabilities_hash,
          desired_state, last_sequence, last_heartbeat_at, created_at, updated_at
        ) VALUES (
          ${ids.sourceWorker}, ${ids.sourceReplica}, ${ids.sourceRelease}, '1.0', 'ready', '{}', ${provider},
          ${ids.region}, ${`source_instance_${suffix}`}, ${ids.pool}, ${`source-fingerprint-${suffix}`}, '{}',
          ${"c".repeat(64)}, 'run', 0, ${startedAt.toISOString()}, ${startedAt.toISOString()}, ${startedAt.toISOString()}
        )`;
      await transaction`INSERT INTO model_rollouts (
          id, project_id, pool_id, model_id, alias, provider, region_id, gpu_sku,
          source_release_id, target_release_id, source_image_digest, target_image_digest,
          direction, status, strategy, progress, spent_extra_cost_minor, currency, reason,
          created_by, version, created_at, updated_at
        ) VALUES (
          ${ids.rollout}, ${ids.project}, ${ids.pool}, ${ids.model}, ${`rollout-${suffix}`}, ${provider},
          ${ids.region}, 'rtx5090', ${ids.sourceRelease}, ${ids.targetRelease}, ${sourceDigest}, ${targetDigest},
          'forward', 'pending', ${JSON.stringify(strategy)}, '{"total_steps":1,"completed_steps":0}',
          0, 'CNY', 'integration rollout', 'test', 1, ${startedAt.toISOString()}, ${startedAt.toISOString()}
        )`;
    });

    const pepper = "rollout-worker-token-pepper-at-least-32-bytes";
    const encryptionKey = "rollout-operation-encryption-key-at-least-32-bytes";
    const operationRepository = new ProviderOperationRepository(
      database.client,
      now,
      (prefix) => `${prefix}_${Bun.randomUUIDv7()}`,
      encryptionKey,
    );
    const controller = new RolloutController(
      database.client,
      operationRepository,
      provider,
      pepper,
      "http://worker-control.test/internal",
      now,
    );
    const operator = new ReferenceProviderOperator(now);
    operator.replicas.set(`source_instance_${suffix}`, {
      id: `source_instance_${suffix}`,
      provider: "reference",
      region: ids.region,
      gpuSku: "rtx5090",
      imageDigest: sourceDigest,
      state: "ready",
    });
    const reconciler = new ProviderOperationReconciler(
      operationRepository,
      { [provider]: operator },
      provider,
      `controller_${suffix}`,
      30,
      20,
      now,
    );

    expect((await controller.runOnce()).outcome).toBe("progressed");
    expect((await reconciler.runOnce(10)).succeeded).toBe(1);
    expect((await controller.runOnce()).outcome).toBe("progressed");
    const operations = await database.client`SELECT operation_key, desired_payload::text AS payload
      FROM provider_operations WHERE resource_id IN (
        SELECT id FROM replicas WHERE rollout_id=${ids.rollout}
        UNION SELECT id FROM rollout_steps WHERE rollout_id=${ids.rollout}
      ) ORDER BY created_at`;
    expect(operations).toHaveLength(2);
    expect(operations[1]?.payload).not.toContain("WORKER_BOOTSTRAP_TOKEN");
    expect(operations[1]?.payload).not.toContain("bootstrap_");
    expect((await reconciler.runOnce(10)).succeeded).toBe(1);

    const stepRows = await database.client`SELECT rs.id AS step_id, rs.target_replica_id,
        po.operation_key, r.provider_resource_id FROM rollout_steps rs JOIN replicas r ON r.id=rs.target_replica_id
        JOIN provider_operations po ON po.resource_id=r.id AND po.operation_type='provision'
      WHERE rs.rollout_id=${ids.rollout}`;
    const step = stepRows[0];
    if (!step) throw new Error("rollout step missing");
    const provisionKey = String(step.operation_key);
    const bootstrapToken = `bootstrap_${createHmac("sha256", pepper).update(provisionKey).digest("base64url")}`;
    const capabilities = capabilitiesSchema.parse({
      contract_version: "1.0",
      app: { name: "reference-model-app", version: "1.0.0", build: "integration" },
      model_release: ids.targetRelease,
      modalities: ["video"],
      operations: ["generation"],
      max_concurrency: 1,
      capabilities: {
        aspect_ratios: ["16:9"],
        resolutions: ["720p"],
        resolution_matrix: { "16:9/720p": { width: 1280, height: 720 } },
        durations: [15],
        fps: [24],
        input_types: ["image", "video", "audio"],
        input_roles: ["reference_image", "reference_video", "reference_audio"],
        audio_modes: ["native"],
        supports_cancel: true,
        supports_progress: true,
        supports_resume: false,
      },
      artifacts: {
        output_artifacts: [{ role: "result", content_types: ["video/mp4"] }],
        max_outputs: 1,
        sidecar_manifest_allowed: true,
        post_processing: "model_app_only",
      },
    });
    const workerRepository = new WorkerControlRepository(database.client, "r".repeat(32), now);
    const registered = await workerRepository.register(
      {
        provider,
        region: ids.region,
        provider_instance_id: String(step.target_replica_id),
        replica_id: String(step.target_replica_id),
        pool_id: ids.pool,
        release_id: ids.targetRelease,
        image_digest: targetDigest,
        instance_fingerprint: `rollout-${createHash("sha256").update(provisionKey).digest("hex")}`,
        hardware: { gpu_sku: "rtx5090", gpu_count: 1, gpu_memory_bytes: 34359738368 },
        capabilities,
      },
      createHmac("sha256", pepper).update(bootstrapToken).digest("hex"),
      {
        id: `worker_session_${suffix}`,
        tokenHash: createHash("sha256").update(`worker-session:${suffix}`).digest("hex"),
        expiresAt: new Date(current.getTime() + 3600000),
      },
    );
    expect(registered.rolloutValidationRequired).toBe(true);
    const report = {
      sequence: 1,
      observed_at: current.toISOString(),
      image_digest: targetDigest,
      status: "passed" as const,
      capabilities_hash: canonicalHash(capabilities),
      smoke: {
        validation_id: `validation_${step.target_replica_id}`,
        model_release: ids.targetRelease,
        status: "passed" as const,
        evidence_sha256: "e".repeat(64),
        duration_ms: 1,
        checks: { readiness: true, capabilities: true, execution: true, output_contract: true },
      },
      resources: { gpu_memory_peak_bytes: 0, system_memory_peak_bytes: 0 },
    };
    await workerRepository.reportRolloutValidation(registered, report, canonicalHash(report));
    current = new Date(current.getTime() + 61000);
    expect((await controller.runOnce()).outcome).toBe("progressed");
    const switched = await database.client`SELECT r.rollout_reserved, mr.accept_new_tasks,
        source.accept_new_tasks AS source_accept_new, w.desired_state AS source_worker_desired
      FROM replicas r JOIN model_releases mr ON mr.id=${ids.targetRelease}
      JOIN model_releases source ON source.id=${ids.sourceRelease}
      JOIN workers w ON w.id=${ids.sourceWorker}
      WHERE r.id=${String(step.target_replica_id)}`;
    expect(switched[0]).toMatchObject({
      rollout_reserved: false,
      accept_new_tasks: true,
      source_accept_new: false,
      source_worker_desired: "drain",
    });
    const beforeDrain = await database.client`SELECT count(*)::int AS count FROM provider_operations
      WHERE resource_id=${ids.sourceReplica} AND operation_type='terminate'`;
    expect(beforeDrain[0]?.count).toBe(0);

    await database.client.begin(async (transaction) => {
      await transaction`UPDATE workers SET status='drained', drained_at=${current.toISOString()} WHERE id=${ids.sourceWorker}`;
      await transaction`UPDATE replicas SET observed_state='drained' WHERE id=${ids.sourceReplica}`;
    });
    expect((await controller.runOnce()).outcome).toBe("progressed");
    expect((await reconciler.runOnce(10)).succeeded).toBe(1);
    expect((await controller.runOnce()).outcome).toBe("progressed");
    expect((await controller.runOnce()).outcome).toBe("completed");
    const completed = await database.client`SELECT status FROM model_rollouts WHERE id=${ids.rollout}`;
    expect(completed[0]?.status).toBe("completed");
  });
});
