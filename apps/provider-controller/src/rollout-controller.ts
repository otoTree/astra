import { createHash, createHmac } from "node:crypto";
import type postgres from "postgres";
import type { ProviderOperationRepository } from "@astra/database";

type SqlClient = ReturnType<typeof postgres>;

type Strategy = Readonly<{
  max_surge: number;
  max_unavailable: number;
  batch_size: number;
  readiness_timeout_seconds: number;
  readiness_stability_seconds: number;
  progress_deadline_seconds: number;
  pause_on_failure: boolean;
  maximum_extra_cost_minor: number;
  currency: string;
}>;

type RolloutRow = Readonly<
  Record<string, unknown> & {
    id: string;
    project_id: string;
    pool_id: string;
    model_id: string;
    alias: string;
    provider: string;
    region_id: string;
    gpu_sku: string;
    source_release_id: string;
    target_release_id: string;
    source_image_digest: string;
    target_image_digest: string;
    direction: "forward" | "rollback";
    status: string;
    strategy: Strategy;
    version: number;
    created_at: Date | string;
  }
>;

export type RolloutCycle = Readonly<{
  outcome: "idle" | "waiting" | "progressed" | "paused" | "completed";
  rolloutId?: string;
  reason?: string;
}>;

const pinnedReference = (source: string, digest: string): string => {
  if (source.includes("@")) return `${source.slice(0, source.lastIndexOf("@"))}@${digest}`;
  const slash = source.lastIndexOf("/");
  const colon = source.lastIndexOf(":");
  const repository = colon > slash ? source.slice(0, colon) : source;
  return `${repository}@${digest}`;
};

const id = (prefix: string): string => `${prefix}_${Bun.randomUUIDv7()}`;

export class RolloutController {
  private readonly controllerId = `rollout_controller_${Bun.randomUUIDv7()}`;

  constructor(
    private readonly sql: SqlClient,
    private readonly operations: ProviderOperationRepository,
    private readonly provider: string,
    private readonly workerTokenPepper: string,
    private readonly workerControlUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<RolloutCycle> {
    const timestamp = this.now();
    const leaseExpiresAt = new Date(timestamp.getTime() + 30_000);
    const claimed = await this.sql`WITH candidate AS (
        SELECT id FROM model_rollouts
        WHERE status IN ('pending','validating','rolling','rolling_back')
          AND provider=${this.provider}
          AND (controller_lease_expires_at IS NULL OR controller_lease_expires_at<=${timestamp.toISOString()})
        ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE model_rollouts r SET controller_lease_owner=${this.controllerId},
        controller_lease_expires_at=${leaseExpiresAt.toISOString()}, updated_at=${timestamp.toISOString()}
      FROM candidate c WHERE r.id=c.id RETURNING r.id`;
    const rolloutId = claimed[0] ? String(claimed[0].id) : undefined;
    if (!rolloutId) return { outcome: "idle" };
    try {
      const rows = await this.sql`SELECT r.*, target.source_image AS target_source_image,
            target.manifest AS target_manifest, source.source_image AS source_source_image,
            source.manifest AS source_manifest
          FROM model_rollouts r
          JOIN model_releases target ON target.id=r.target_release_id
          JOIN model_releases source ON source.id=r.source_release_id
          WHERE r.id=${rolloutId} AND r.controller_lease_owner=${this.controllerId}`;
      const row = rows[0] as RolloutRow | undefined;
      return row ? await this.reconcile(row) : { outcome: "idle" };
    } finally {
      await this.sql`UPDATE model_rollouts SET controller_lease_owner=NULL, controller_lease_expires_at=NULL
        WHERE id=${rolloutId} AND controller_lease_owner=${this.controllerId}`;
    }
  }

  private desired(row: RolloutRow): Readonly<{
    releaseId: string;
    imageDigest: string;
    sourceReleaseId: string;
    sourceImageDigest: string;
    sourceImage: string;
    gpuMemoryBytes: number;
  }> {
    return row.direction === "forward"
      ? {
          releaseId: String(row.target_release_id),
          imageDigest: String(row.target_image_digest),
          sourceReleaseId: String(row.source_release_id),
          sourceImageDigest: String(row.source_image_digest),
          sourceImage: String(row.target_source_image),
          gpuMemoryBytes: Number(
            ((row.target_manifest as Record<string, unknown>)?.resource_requirements as Record<string, unknown>)
              ?.gpu_memory_bytes ?? 1,
          ),
        }
      : {
          releaseId: String(row.source_release_id),
          imageDigest: String(row.source_image_digest),
          sourceReleaseId: String(row.target_release_id),
          sourceImageDigest: String(row.target_image_digest),
          sourceImage: String(row.source_source_image),
          gpuMemoryBytes: Number(
            ((row.source_manifest as Record<string, unknown>)?.resource_requirements as Record<string, unknown>)
              ?.gpu_memory_bytes ?? 1,
          ),
        };
  }

  private async reconcile(row: RolloutRow): Promise<RolloutCycle> {
    const timestamp = this.now();
    const strategy = row.strategy;
    if (timestamp.getTime() - new Date(row.created_at).getTime() > strategy.progress_deadline_seconds * 1000) {
      await this.pause(row, "progress_deadline_exceeded");
      return { outcome: "paused", rolloutId: row.id, reason: "progress_deadline_exceeded" };
    }
    const spent = await this.sql`SELECT COALESCE(sum(cost_minor),0)::bigint AS cost, max(currency) AS currency
      FROM provider_operations WHERE resource_id IN (
        SELECT id FROM replicas WHERE rollout_id=${row.id}
        UNION SELECT id FROM rollout_steps WHERE rollout_id=${row.id}
      )`;
    if (
      Number(spent[0]?.cost ?? 0) > strategy.maximum_extra_cost_minor ||
      (spent[0]?.currency && String(spent[0].currency) !== strategy.currency)
    ) {
      await this.pause(row, "rollout_cost_limit_exceeded");
      return { outcome: "paused", rolloutId: row.id, reason: "rollout_cost_limit_exceeded" };
    }

    const desired = this.desired(row);
    const steps = await this.sql`SELECT * FROM rollout_steps
      WHERE rollout_id=${row.id} AND direction=${row.direction} ORDER BY ordinal, id`;
    let step = steps.find((item) => item.status !== "completed");
    if (!step) {
      const source = await this.sql`SELECT r.id FROM replicas r
        WHERE r.pool_id=${row.pool_id} AND r.release_id=${desired.sourceReleaseId}
          AND r.observed_state<>'terminated'
          AND NOT EXISTS (SELECT 1 FROM rollout_steps rs WHERE rs.rollout_id=${row.id}
            AND rs.direction=${row.direction} AND rs.source_replica_id=r.id)
        ORDER BY r.created_at, r.id LIMIT 1`;
      if (!source[0] && steps.length > 0) {
        await this.complete(row, desired.releaseId, desired.sourceReleaseId);
        return { outcome: "completed", rolloutId: row.id };
      }
      step = await this.createStep(row, desired, source[0] ? String(source[0].id) : undefined, steps.length);
    }

    const stepId = String(step.id);
    const replicaId = String(step.target_replica_id);
    const prewarm = await this.sql`SELECT * FROM provider_operations
      WHERE operation_key=${`rollout:${row.id}:${row.direction}:${String(step.ordinal)}:prewarm`}`;
    if (!prewarm[0]) {
      const operation = await this.operations.enqueue({
        projectId: row.project_id,
        provider: row.provider,
        operationKey: `rollout:${row.id}:${row.direction}:${String(step.ordinal)}:prewarm`,
        operationType: "prewarm",
        resourceType: "rollout_step",
        resourceId: stepId,
        payload: {
          image_digest: desired.imageDigest,
          image_reference: pinnedReference(desired.sourceImage, desired.imageDigest),
          region: row.region_id,
          gpu_sku: row.gpu_sku,
        },
        maximumAttempts: 8,
      });
      await this.sql`UPDATE rollout_steps SET prewarm_operation_id=${operation.id}, status='provisioning',
        version=version+1, updated_at=${timestamp.toISOString()} WHERE id=${stepId} AND status='pending'`;
      return { outcome: "progressed", rolloutId: row.id };
    }
    if (prewarm[0].status === "failed") return this.pauseResult(row, "image_prewarm_failed");
    if (prewarm[0].status !== "succeeded") return { outcome: "waiting", rolloutId: row.id, reason: "image_prewarm" };

    const provisionKey = `rollout:${row.id}:${row.direction}:${String(step.ordinal)}:provision`;
    const provision = await this.sql`SELECT * FROM provider_operations WHERE operation_key=${provisionKey}`;
    if (!provision[0]) {
      const bootstrap = this.bootstrap(row, desired, replicaId, provisionKey, strategy);
      await this.sql`INSERT INTO worker_bootstrap_tokens (
          id, token_hash, replica_id, release_id, expires_at, created_at
        ) VALUES (
          ${`bootstrap_${createHash("sha256").update(provisionKey).digest("hex").slice(0, 32)}`},
          ${bootstrap.tokenHash}, ${replicaId}, ${desired.releaseId}, ${bootstrap.expiresAt.toISOString()},
          ${timestamp.toISOString()}
        ) ON CONFLICT (token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at
          WHERE worker_bootstrap_tokens.used_at IS NULL`;
      await this.operations.enqueue({
        projectId: row.project_id,
        provider: row.provider,
        operationKey: provisionKey,
        operationType: "provision",
        resourceType: "replica",
        resourceId: replicaId,
        payload: {
          image_digest: desired.imageDigest,
          image_reference: pinnedReference(desired.sourceImage, desired.imageDigest),
          region: row.region_id,
          gpu_sku: row.gpu_sku,
        },
        maximumAttempts: 8,
        secretEnvironment: bootstrap.environment,
        secretExpiresAt: bootstrap.expiresAt,
      });
      return { outcome: "progressed", rolloutId: row.id };
    }
    if (provision[0].status === "failed") return this.pauseResult(row, "replica_provision_failed");
    if (provision[0].status !== "succeeded") return { outcome: "waiting", rolloutId: row.id, reason: "provisioning" };

    const validation = await this.sql`SELECT * FROM worker_rollout_validation_reports
      WHERE rollout_step_id=${stepId} ORDER BY created_at DESC LIMIT 1`;
    if (!validation[0]) {
      await this.sql`UPDATE rollout_steps SET status='validating', version=version+1,
        updated_at=${timestamp.toISOString()} WHERE id=${stepId} AND status='provisioning'`;
      return { outcome: "waiting", rolloutId: row.id, reason: "worker_validation" };
    }
    if (validation[0].status === "failed") return this.pauseResult(row, String(validation[0].failure_code));
    const stableAt =
      new Date(validation[0].observed_at as Date | string).getTime() + strategy.readiness_stability_seconds * 1000;
    if (timestamp.getTime() < stableAt) return { outcome: "waiting", rolloutId: row.id, reason: "readiness_stability" };

    if (!["target_ready", "draining_old", "replacing"].includes(String(step.status))) {
      await this.promoteTarget(row, desired, stepId, replicaId);
      step = { ...step, status: "target_ready" };
    }
    const sourceReplicaId = step.source_replica_id ? String(step.source_replica_id) : undefined;
    if (!sourceReplicaId) {
      await this.completeStep(row, stepId, replicaId);
      return { outcome: "progressed", rolloutId: row.id };
    }
    const queued = await this.sql`SELECT count(*)::int AS count FROM tasks
      WHERE model_release_id=${desired.sourceReleaseId} AND status IN ('queued','scheduling','provisioning')`;
    if (Number(queued[0]?.count ?? 0) > 0) {
      return { outcome: "waiting", rolloutId: row.id, reason: "source_queue_draining" };
    }
    if (step.status === "target_ready") {
      await this.sql.begin(async (transaction) => {
        await transaction`UPDATE replicas SET desired_state='draining', version=version+1,
          updated_at=${timestamp.toISOString()} WHERE id=${sourceReplicaId} AND desired_state<>'terminated'`;
        await transaction`UPDATE workers SET desired_state='drain', status=CASE WHEN status='drained' THEN status ELSE 'draining' END,
          updated_at=${timestamp.toISOString()} WHERE replica_id=${sourceReplicaId}`;
        await transaction`UPDATE rollout_steps SET status='draining_old', version=version+1,
          updated_at=${timestamp.toISOString()} WHERE id=${stepId}`;
      });
      return { outcome: "progressed", rolloutId: row.id };
    }
    const source = await this.sql`SELECT r.*, w.status AS worker_status FROM replicas r
      LEFT JOIN workers w ON w.replica_id=r.id WHERE r.id=${sourceReplicaId}`;
    if (
      !["drained", "terminated"].includes(String(source[0]?.observed_state)) ||
      source[0]?.worker_status !== "drained"
    ) {
      return { outcome: "waiting", rolloutId: row.id, reason: "worker_draining" };
    }
    const active = await this.sql`SELECT 1 FROM attempts WHERE replica_id=${sourceReplicaId}
      AND status IN ('reserved','leased','running','unknown') LIMIT 1`;
    if (active[0]) return { outcome: "waiting", rolloutId: row.id, reason: "active_attempt" };
    const terminateKey = `rollout:${row.id}:${row.direction}:${String(step.ordinal)}:terminate`;
    const terminate = await this.sql`SELECT * FROM provider_operations WHERE operation_key=${terminateKey}`;
    if (!terminate[0]) {
      if (!source[0]?.provider_resource_id) return this.pauseResult(row, "source_provider_resource_missing");
      const operation = await this.operations.enqueue({
        projectId: row.project_id,
        provider: row.provider,
        operationKey: terminateKey,
        operationType: "terminate",
        resourceType: "replica",
        resourceId: sourceReplicaId,
        payload: { provider_resource_id: String(source[0].provider_resource_id) },
        maximumAttempts: 8,
      });
      await this.sql`UPDATE rollout_steps SET status='replacing', terminate_operation_id=${operation.id},
        version=version+1, updated_at=${timestamp.toISOString()} WHERE id=${stepId}`;
      return { outcome: "progressed", rolloutId: row.id };
    }
    if (terminate[0].status === "failed") return this.pauseResult(row, "source_terminate_failed");
    if (terminate[0].status !== "succeeded") return { outcome: "waiting", rolloutId: row.id, reason: "terminating" };
    await this.completeStep(row, stepId, replicaId);
    return { outcome: "progressed", rolloutId: row.id };
  }

  private bootstrap(
    row: RolloutRow,
    desired: ReturnType<RolloutController["desired"]>,
    replicaId: string,
    key: string,
    strategy: Strategy,
  ) {
    const token = `bootstrap_${createHmac("sha256", this.workerTokenPepper).update(key).digest("base64url")}`;
    const expiresAt = new Date(this.now().getTime() + Math.max(strategy.progress_deadline_seconds, 3600) * 1000);
    return {
      tokenHash: createHmac("sha256", this.workerTokenPepper).update(token).digest("hex"),
      expiresAt,
      environment: {
        WORKER_BOOTSTRAP_TOKEN: token,
        WORKER_CONTROL_URL: this.workerControlUrl,
        WORKER_PROVIDER: row.provider,
        WORKER_REGION: row.region_id,
        WORKER_PROVIDER_INSTANCE_ID: replicaId,
        WORKER_REPLICA_ID: replicaId,
        WORKER_POOL_ID: row.pool_id,
        WORKER_RELEASE_ID: desired.releaseId,
        WORKER_IMAGE_DIGEST: desired.imageDigest,
        WORKER_INSTANCE_FINGERPRINT: `rollout-${createHash("sha256").update(key).digest("hex")}`,
        WORKER_GPU_SKU: row.gpu_sku,
        WORKER_GPU_COUNT: "1",
        WORKER_GPU_MEMORY_BYTES: String(desired.gpuMemoryBytes),
        MODEL_APP_RELEASE: desired.releaseId,
      },
    };
  }

  private async createStep(
    row: RolloutRow,
    desired: ReturnType<RolloutController["desired"]>,
    sourceReplicaId: string | undefined,
    ordinal: number,
  ): Promise<Record<string, unknown>> {
    const timestamp = this.now();
    const stepId = id("rolloutstep");
    const replicaId = id("replica");
    await this.sql.begin(async (transaction) => {
      await transaction`INSERT INTO rollout_steps (
          id, rollout_id, ordinal, direction, source_replica_id, status, gates, version, created_at, updated_at
        ) VALUES (
          ${stepId}, ${row.id}, ${ordinal}, ${row.direction}, ${sourceReplicaId ?? null}, 'pending', '{}', 1,
          ${timestamp.toISOString()}, ${timestamp.toISOString()}
        )`;
      await transaction`INSERT INTO replicas (
          id, pool_id, release_id, provider, region_id, gpu_sku, image_digest, rollout_id, rollout_step_id,
          desired_state, observed_state, rollout_reserved, version, last_observed_at, created_at, updated_at
        ) VALUES (
          ${replicaId}, ${row.pool_id}, ${desired.releaseId}, ${row.provider}, ${row.region_id}, ${row.gpu_sku},
          ${desired.imageDigest}, ${row.id}, ${stepId}, 'provisioning', 'provisioning', true, 0,
          ${timestamp.toISOString()}, ${timestamp.toISOString()}, ${timestamp.toISOString()}
        )`;
      await transaction`UPDATE rollout_steps SET target_replica_id=${replicaId} WHERE id=${stepId}`;
      await transaction`UPDATE model_rollouts SET status='validating', started_at=COALESCE(started_at, ${timestamp.toISOString()}),
        version=version+1, updated_at=${timestamp.toISOString()} WHERE id=${row.id}`;
      await this.event(
        transaction,
        row,
        "rollout.step_created",
        "controller",
        "rollout-controller",
        "replacement_step_created",
        {
          rollout_step_id: stepId,
          source_replica_id: sourceReplicaId ?? null,
          target_replica_id: replicaId,
          image_digest: desired.imageDigest,
        },
      );
    });
    return {
      id: stepId,
      ordinal,
      direction: row.direction,
      source_replica_id: sourceReplicaId ?? null,
      target_replica_id: replicaId,
      status: "pending",
    };
  }

  private async promoteTarget(
    row: RolloutRow,
    desired: ReturnType<RolloutController["desired"]>,
    stepId: string,
    replicaId: string,
  ): Promise<void> {
    const timestamp = this.now();
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE replicas SET rollout_reserved=false, desired_state='ready', observed_state='ready',
        version=version+1, updated_at=${timestamp.toISOString()} WHERE id=${replicaId} AND rollout_reserved=true`;
      await transaction`UPDATE rollout_steps SET status='target_ready', version=version+1,
        updated_at=${timestamp.toISOString()} WHERE id=${stepId}`;
      const currentPool = await transaction`SELECT release_id FROM model_pools WHERE id=${row.pool_id} FOR UPDATE`;
      if (String(currentPool[0]?.release_id) !== desired.releaseId) {
        const currentAlias = await transaction`SELECT version FROM model_alias_versions
          WHERE project_id=${row.project_id} AND alias=${row.alias} AND status='active' FOR UPDATE`;
        if (currentAlias[0]) {
          await transaction`UPDATE model_alias_versions SET status='superseded'
            WHERE project_id=${row.project_id} AND alias=${row.alias} AND status='active'`;
        }
        await transaction`INSERT INTO model_alias_versions (
            id, project_id, alias, model_id, release_id, version, status, reason, created_by, created_at
          ) VALUES (
            ${id("aliasver")}, ${row.project_id}, ${row.alias}, ${row.model_id}, ${desired.releaseId},
            ${Number(currentAlias[0]?.version ?? 0) + 1}, 'active', 'rollout target validated',
            'rollout-controller', ${timestamp.toISOString()}
          )`;
        await transaction`UPDATE model_releases SET accept_new_tasks=false WHERE model_id=${row.model_id}`;
        await transaction`UPDATE model_releases SET accept_new_tasks=true, accept_existing_tasks=true
          WHERE id=${desired.releaseId}`;
        await transaction`UPDATE model_releases SET accept_existing_tasks=true WHERE id=${desired.sourceReleaseId}`;
        await transaction`UPDATE model_pools SET release_id=${desired.releaseId}, version=version+1,
          updated_at=${timestamp.toISOString()} WHERE id=${row.pool_id}`;
      }
      await transaction`UPDATE model_rollouts SET status=${row.direction === "rollback" ? "rolling_back" : "rolling"},
        version=version+1, updated_at=${timestamp.toISOString()} WHERE id=${row.id}`;
      await this.event(
        transaction,
        row,
        "rollout.target_ready",
        "controller",
        "rollout-controller",
        "worker_validation_passed",
        {
          rollout_step_id: stepId,
          target_replica_id: replicaId,
          image_digest: desired.imageDigest,
        },
      );
    });
  }

  private async completeStep(row: RolloutRow, stepId: string, replicaId: string): Promise<void> {
    const timestamp = this.now();
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE rollout_steps SET status='completed', version=version+1,
        completed_at=${timestamp.toISOString()}, updated_at=${timestamp.toISOString()} WHERE id=${stepId}`;
      const counts = await transaction`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE status='completed')::int AS completed FROM rollout_steps
        WHERE rollout_id=${row.id} AND direction=${row.direction}`;
      const progress = {
        total_steps: Number(counts[0]?.total ?? 0),
        completed_steps: Number(counts[0]?.completed ?? 0),
      };
      await transaction`UPDATE model_rollouts SET progress=${JSON.stringify(progress)}, version=version+1,
        updated_at=${timestamp.toISOString()} WHERE id=${row.id}`;
      await this.event(
        transaction,
        row,
        "rollout.step_completed",
        "controller",
        "rollout-controller",
        "replacement_completed",
        {
          rollout_step_id: stepId,
          target_replica_id: replicaId,
          progress,
        },
      );
    });
  }

  private async complete(row: RolloutRow, releaseId: string, sourceReleaseId: string): Promise<void> {
    const timestamp = this.now();
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE model_releases SET accept_existing_tasks=false WHERE id=${sourceReleaseId}
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE model_release_id=${sourceReleaseId}
          AND status NOT IN ('completed','failed','canceled','expired'))`;
      await transaction`UPDATE model_rollouts SET status=${row.direction === "rollback" ? "rolled_back" : "completed"},
        version=version+1, completed_at=${timestamp.toISOString()}, updated_at=${timestamp.toISOString()}
        WHERE id=${row.id}`;
      await this.event(
        transaction,
        row,
        "rollout.completed",
        "controller",
        "rollout-controller",
        "all_replicas_replaced",
        {
          active_release_id: releaseId,
          retired_release_id: sourceReleaseId,
        },
      );
    });
  }

  private async pauseResult(row: RolloutRow, reason: string): Promise<RolloutCycle> {
    await this.pause(row, reason || "rollout_gate_failed");
    return { outcome: "paused", rolloutId: row.id, reason: reason || "rollout_gate_failed" };
  }

  private async pause(row: RolloutRow, reason: string): Promise<void> {
    const timestamp = this.now();
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE model_rollouts SET status='paused', pause_code=${reason}, paused_at=${timestamp.toISOString()},
        version=version+1, updated_at=${timestamp.toISOString()} WHERE id=${row.id}
        AND status IN ('pending','validating','rolling','rolling_back')`;
      await this.event(transaction, row, "rollout.auto_paused", "controller", "rollout-controller", reason, {});
    });
  }

  private async event(
    sql: postgres.TransactionSql,
    row: RolloutRow,
    eventType: string,
    actorType: "oidc_user" | "controller" | "worker",
    actorId: string,
    reason: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const versions = await sql`SELECT version FROM model_rollouts WHERE id=${row.id}`;
    const version = Number(versions[0]?.version ?? row.version);
    await sql`INSERT INTO rollout_events (
        id, rollout_id, rollout_version, event_type, actor_type, actor_id, reason, details, created_at
      ) VALUES (
        ${id("rolloutevent")}, ${row.id}, ${version}, ${eventType}, ${actorType}, ${actorId}, ${reason},
        ${JSON.stringify(details)}, ${this.now().toISOString()}
      )`;
    await sql`INSERT INTO outbox_events (
        id, aggregate_type, aggregate_id, aggregate_version, event_type, payload, trace_id, created_at
      ) VALUES (
        ${id("event")}, 'rollout', ${row.id}, ${version}, ${`${eventType}.v1`},
        ${JSON.stringify({ rollout_id: row.id, ...details })}, ${`rollout:${row.id}`}, ${this.now().toISOString()}
      )`;
  }
}
