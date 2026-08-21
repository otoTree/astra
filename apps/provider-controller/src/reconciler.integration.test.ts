import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createDatabase,
  ProviderOperationRepository,
  ProviderSnapshotRepository,
  type ProviderObservationBundleInput,
} from "@astra/database";
import { ReferenceProviderOperator } from "@astra/provider-reference";
import { ProviderError } from "@astra/provider-core";
import { ProviderOperationReconciler } from "./reconciler.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integration = database ? test : test.skip;

describe("Provider operation reconcile", () => {
  integration("converges response loss, suppresses stale capacity and protects active replicas", async () => {
    if (!database) return;
    let now = new Date("2026-08-22T02:00:00.000Z");
    let sequence = 0;
    const suffix = Bun.randomUUIDv7();
    const provider = `reference-contract-${suffix}`;
    const region = "region-a";
    const regionId = `${provider}:${region}`;
    const poolId = `pool_provider_${suffix}`;
    const firstReplicaId = `replica_provider_${suffix}`;
    const secondReplicaId = `replica_provider_loss_${suffix}`;
    const snapshotRepository = new ProviderSnapshotRepository(
      database.client,
      () => now,
      (prefix) => `${prefix}_${suffix}_${sequence++}`,
    );
    const operationRepository = new ProviderOperationRepository(
      database.client,
      () => now,
      (prefix) => `${prefix}_${suffix}_${sequence++}`,
    );
    const snapshot = (): ProviderObservationBundleInput => {
      const payload = { region, inventory: 10 };
      return {
        provider,
        contractVersion: "reference-operation-v1",
        observedAt: now,
        resources: {
          regions: [{ id: region, healthy: true, allowed: true }],
          offers: [
            {
              region,
              gpuSku: "reference-gpu",
              gpuMemoryBytes: 32 * 1024 * 1024 * 1024,
              availableReplicas: 10,
              pricePerGpuHourMinor: 300,
              currency: "CNY",
              observedAt: now,
            },
          ],
        },
        pages: [
          {
            kind: "resource",
            endpoint: "reference://resources",
            payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
            redactedPayload: payload,
            quarantineReasons: [],
            objects: [
              {
                kind: "resource",
                providerId: `${region}:reference-gpu`,
                region,
                gpuSku: "reference-gpu",
                observedAt: now,
                attributes: { available_replicas: 10, region_name: "Region A" },
              },
            ],
          },
        ],
      };
    };
    await snapshotRepository.publish(snapshot(), 300);
    await database.client`INSERT INTO model_pools (
        id, project_id, release_id, provider, region_id, gpu_sku, execution_mode, status,
        version, created_at, updated_at
      ) VALUES (
        ${poolId}, 'project_local', 'release_local_reference', ${provider}, ${regionId},
        'reference-gpu', 'deployment', 'active', 1, ${now.toISOString()}, ${now.toISOString()}
      )`;
    for (const replicaId of [firstReplicaId, secondReplicaId]) {
      await database.client`INSERT INTO replicas (
          id, pool_id, release_id, provider, region_id, gpu_sku, image_digest,
          desired_state, observed_state, rollout_reserved, version, created_at, updated_at
        ) VALUES (
          ${replicaId}, ${poolId}, 'release_local_reference', ${provider}, ${regionId}, 'reference-gpu',
          ${`sha256:${"a".repeat(64)}`}, 'provisioning', 'provisioning', false, 1,
          ${now.toISOString()}, ${now.toISOString()}
        )`;
    }
    const operator = new ReferenceProviderOperator(() => now);
    const reconciler = new ProviderOperationReconciler(
      operationRepository,
      { [provider]: operator },
      provider,
      `controller-${suffix}`,
      30,
      20,
      () => now,
    );
    const provisionPayload = {
      image_digest: `sha256:${"a".repeat(64)}`,
      region,
      gpu_sku: "reference-gpu",
    } as const;
    const first = await operationRepository.enqueue({
      projectId: "project_local",
      provider,
      operationKey: `provision:${firstReplicaId}`,
      operationType: "provision",
      resourceType: "replica",
      resourceId: firstReplicaId,
      payload: provisionPayload,
      maximumAttempts: 5,
    });
    expect(first.status).toBe("pending");
    expect(
      (
        await operationRepository.enqueue({
          projectId: "project_local",
          provider,
          operationKey: `provision:${firstReplicaId}`,
          operationType: "provision",
          resourceType: "replica",
          resourceId: firstReplicaId,
          payload: provisionPayload,
          maximumAttempts: 5,
        })
      ).replayed,
    ).toBe(true);
    expect((await reconciler.runOnce(10)).succeeded).toBe(1);
    const firstReplica = await database.client`SELECT provider_resource_id, observed_state FROM replicas
      WHERE id=${firstReplicaId}`;
    expect(firstReplica[0]?.observed_state).toBe("ready");
    expect(firstReplica[0]?.provider_resource_id).toBeTruthy();

    await operationRepository.enqueue({
      projectId: "project_local",
      provider,
      operationKey: `provision:${secondReplicaId}`,
      operationType: "provision",
      resourceType: "replica",
      resourceId: secondReplicaId,
      payload: provisionPayload,
      maximumAttempts: 5,
    });
    const lostClaim = (await operationRepository.claim(`lost-controller-${suffix}`, provider, 1, 30))[0];
    if (!lostClaim) throw new Error("expected_provider_operation_claim");
    const externallyCreated = await operator.provisionReplica(
      { imageDigest: provisionPayload.image_digest, region, gpuSku: "reference-gpu" },
      {
        operationId: lostClaim.operationKey,
        requestId: lostClaim.id,
        deadlineAt: new Date(now.getTime() + 20_000),
      },
    );
    now = new Date(now.getTime() + 31_000);
    expect(
      await operationRepository.succeed(lostClaim, {
        providerResourceId: externallyCreated.id,
        providerState: externallyCreated.state,
        response: { resource_id: externallyCreated.id },
      }),
    ).toBe(false);
    expect((await reconciler.runOnce(10)).succeeded).toBe(1);
    expect(operator.replicas.size).toBe(2);

    const providerResourceId = String(firstReplica[0]?.provider_resource_id);
    await database.client`UPDATE replicas SET desired_state='draining', observed_state='busy', version=version+1
      WHERE id=${firstReplicaId}`;
    await operationRepository.enqueue({
      projectId: "project_local",
      provider,
      operationKey: `drain:${firstReplicaId}`,
      operationType: "drain",
      resourceType: "replica",
      resourceId: firstReplicaId,
      payload: { provider_resource_id: providerResourceId },
      maximumAttempts: 5,
    });
    expect(await operationRepository.claim(`safety-${suffix}`, provider, 10, 30)).toHaveLength(0);
    await database.client`UPDATE replicas SET observed_state='drained', version=version+1 WHERE id=${firstReplicaId}`;
    expect((await reconciler.runOnce(10)).succeeded).toBe(1);

    now = new Date(now.getTime() + 301_000);
    const suppressed = await operationRepository.enqueue({
      projectId: "project_local",
      provider,
      operationKey: `prewarm:${suffix}`,
      operationType: "prewarm",
      resourceType: "release",
      resourceId: "release_local_reference",
      payload: provisionPayload,
      maximumAttempts: 5,
    });
    expect(suppressed.status).toBe("suppressed");
    await snapshotRepository.publish(snapshot(), 300);
    const recovered = await reconciler.runOnce(10);
    expect(recovered.reactivated).toBe(1);
    expect(recovered.succeeded).toBe(1);

    let firstAttempt = true;
    const retryingOperator = {
      ...operator,
      prewarmImage: async (...args: Parameters<ReferenceProviderOperator["prewarmImage"]>) => {
        if (firstAttempt) {
          firstAttempt = false;
          throw new ProviderError("rate_limited", true, 2);
        }
        return operator.prewarmImage(...args);
      },
      provisionReplica: operator.provisionReplica.bind(operator),
      drainReplica: operator.drainReplica.bind(operator),
      terminateReplica: operator.terminateReplica.bind(operator),
      observeReplica: operator.observeReplica.bind(operator),
    };
    await operationRepository.enqueue({
      projectId: "project_local",
      provider,
      operationKey: `prewarm-retry:${suffix}`,
      operationType: "prewarm",
      resourceType: "release",
      resourceId: "release_local_reference",
      payload: provisionPayload,
      maximumAttempts: 3,
    });
    const retryReconciler = new ProviderOperationReconciler(
      operationRepository,
      { [provider]: retryingOperator },
      provider,
      `retry-controller-${suffix}`,
      30,
      20,
      () => now,
    );
    expect((await retryReconciler.runOnce(10)).retrying).toBe(1);
    now = new Date(now.getTime() + 2_001);
    expect((await retryReconciler.runOnce(10)).succeeded).toBe(1);

    await operationRepository.enqueue({
      projectId: "project_local",
      provider,
      operationKey: `prewarm-auth:${suffix}`,
      operationType: "prewarm",
      resourceType: "release",
      resourceId: "release_local_reference",
      payload: provisionPayload,
      maximumAttempts: 3,
    });
    const deniedOperator = {
      ...retryingOperator,
      prewarmImage: async () => {
        throw new ProviderError("authentication_failed", false);
      },
    };
    const deniedReconciler = new ProviderOperationReconciler(
      operationRepository,
      { [provider]: deniedOperator },
      provider,
      `denied-controller-${suffix}`,
      30,
      20,
      () => now,
    );
    expect((await deniedReconciler.runOnce(10)).failed).toBe(1);
  });
});

process.on("beforeExit", () => database?.client.end());
