import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

export type CapacityPoolSnapshot = Readonly<{
  projectId: string;
  poolId: string;
  provider: string;
  regionId: string;
  gpuSku: string;
  policyVersionId?: string;
  policy: Record<string, unknown>;
  currentReadyReplicas: number;
  currentDesiredReplicas: number;
  approvedMaxConcurrency: number;
  queue: readonly Readonly<{
    taskId: string;
    projectId: string;
    lane: "online" | "batch";
    predictedGpuSeconds: number;
  }>[];
  running: readonly Readonly<{ attemptId: string; remainingGpuSeconds: number }>[];
  replicas: readonly Readonly<{
    replicaId: string;
    regionId: string;
    gpuSku: string;
    maximumConcurrency: number;
    runningSlots: number;
    reservedSlots: number;
    idleSince?: Date;
    readyAt?: Date;
    lastScaleActionAt?: Date;
    rolloutOwned: boolean;
    draining: boolean;
  }>[];
  offers: readonly Readonly<{
    provider: string;
    regionId: string;
    gpuSku: string;
    availableReplicas: number;
    pricePerGpuHourMinor: number;
    coldStartSeconds: number;
    failureRateBasisPoints: number;
    transferCostMinorPerTask: number;
    healthy: boolean;
    snapshotFresh: boolean;
  }>[];
}>;

export class CapacityPlanRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: (prefix: string) => string = (prefix) => `${prefix}_${Bun.randomUUIDv7()}`,
  ) {}

  async activePoolSnapshots(limit = 100): Promise<readonly CapacityPoolSnapshot[]> {
    const timestamp = this.now();
    const pools = await this.sql`SELECT p.id, p.project_id, p.release_id, p.provider, p.region_id, p.gpu_sku,
        p.status, p.version, mr.manifest,
        pv.id AS policy_version_id, pv.configuration, rp.configuration AS region_configuration,
        (SELECT count(*)::int FROM replicas r WHERE r.pool_id=p.id AND r.observed_state IN ('ready','busy')) AS ready_replicas,
        (SELECT count(*)::int FROM replicas r WHERE r.pool_id=p.id AND r.desired_state<>'terminated') AS desired_replicas
      FROM model_pools p JOIN model_releases mr ON mr.id=p.release_id
      LEFT JOIN LATERAL (
        SELECT id, configuration FROM policy_versions
        WHERE pool_id=p.id AND policy_type='capacity' AND status='published'
        ORDER BY version DESC LIMIT 1
      ) pv ON true
      LEFT JOIN LATERAL (
        SELECT configuration FROM policy_versions
        WHERE pool_id=p.id AND policy_type='region' AND status='published'
        ORDER BY version DESC LIMIT 1
      ) rp ON true
      WHERE p.status IN ('active','degraded') AND pv.id IS NOT NULL
      ORDER BY p.id LIMIT ${Math.min(Math.max(limit, 1), 500)}`;
    const snapshots: CapacityPoolSnapshot[] = [];
    for (const pool of pools) {
      const poolId = String(pool.id);
      const replicas = await this.sql`SELECT r.id, r.region_id, r.gpu_sku, r.rollout_reserved,
          r.observed_state, r.idle_since, r.ready_at, r.last_scale_action_at,
          (SELECT count(*)::int FROM attempts a WHERE a.replica_id=r.id AND a.status IN ('running','leased')) AS running_slots,
          (SELECT count(*)::int FROM attempts a WHERE a.replica_id=r.id AND a.status='reserved') AS reserved_slots,
          LEAST(64, COALESCE(NULLIF((w.capabilities->>'max_concurrency')::int, 0), 1),
            COALESCE(NULLIF((pool_release.manifest->>'max_concurrency')::int, 0), 1)) AS maximum_concurrency
        FROM replicas r JOIN workers w ON w.replica_id=r.id
        JOIN model_releases pool_release ON pool_release.id=r.release_id
        WHERE r.pool_id=${poolId} AND r.observed_state IN ('ready','busy','draining')
        ORDER BY r.id`;
      const queue = await this.sql`SELECT t.id, t.project_id, t.priority, t.baseline_gpu_seconds
        FROM tasks t WHERE t.model_release_id=${String(pool.release_id)} AND t.status='queued'
          AND (t.retry_not_before IS NULL OR t.retry_not_before<=${timestamp.toISOString()})
        ORDER BY t.created_at, t.id LIMIT 2000`;
      const running = await this.sql`SELECT a.id, a.expected_gpu_seconds, a.started_at
        FROM attempts a WHERE a.pool_id=${poolId} AND a.status IN ('leased','running') ORDER BY a.id LIMIT 2000`;
      const offers = await this.sql`SELECT provider, region_id, gpu_sku, available_replicas,
          price_per_gpu_hour_minor, observed_at FROM provider_inventory
        WHERE gpu_sku=${String(pool.gpu_sku)}
        ORDER BY provider, region_id`;
      const capacityPolicy = (pool.configuration ?? {}) as Record<string, unknown>;
      const regionPolicy = (pool.region_configuration ?? {}) as Record<string, unknown>;
      const policy: Record<string, unknown> = {
        ...capacityPolicy,
        ...(Array.isArray(regionPolicy.allowed_providers)
          ? { allowed_providers: regionPolicy.allowed_providers }
          : { allowed_providers: [String(pool.provider)] }),
        ...(Array.isArray(regionPolicy.allowed_regions) ? { allowed_regions: regionPolicy.allowed_regions } : {}),
        ...(regionPolicy.max_price_per_gpu_hour_minor === undefined
          ? {}
          : { max_price_per_gpu_hour_minor: regionPolicy.max_price_per_gpu_hour_minor }),
      };
      snapshots.push({
        projectId: String(pool.project_id),
        poolId,
        provider: String(pool.provider),
        regionId: String(pool.region_id),
        gpuSku: String(pool.gpu_sku),
        ...(pool.policy_version_id ? { policyVersionId: String(pool.policy_version_id) } : {}),
        policy,
        currentReadyReplicas: Number(pool.ready_replicas),
        currentDesiredReplicas: Number(pool.desired_replicas),
        approvedMaxConcurrency: Math.max(1, Number((pool.manifest as Record<string, unknown>)?.max_concurrency ?? 1)),
        queue: queue.map((row) => ({
          taskId: String(row.id),
          projectId: String(row.project_id),
          lane: String(row.priority) === "batch" ? "batch" : "online",
          predictedGpuSeconds: Math.max(1, Number(row.baseline_gpu_seconds)),
        })),
        running: running.map((row) => ({
          attemptId: String(row.id),
          remainingGpuSeconds: Math.max(
            1,
            Number(row.expected_gpu_seconds ?? 1) -
              Math.max(
                0,
                Math.floor((timestamp.getTime() - new Date(row.started_at as Date | string).getTime()) / 1000),
              ),
          ),
        })),
        replicas: replicas.map((row) => ({
          replicaId: String(row.id),
          regionId: String(row.region_id),
          gpuSku: String(row.gpu_sku),
          maximumConcurrency: Math.max(1, Number(row.maximum_concurrency)),
          runningSlots: Number(row.running_slots),
          reservedSlots: Number(row.reserved_slots),
          ...(row.idle_since ? { idleSince: new Date(row.idle_since as Date | string) } : {}),
          ...(row.ready_at ? { readyAt: new Date(row.ready_at as Date | string) } : {}),
          ...(row.last_scale_action_at
            ? { lastScaleActionAt: new Date(row.last_scale_action_at as Date | string) }
            : {}),
          rolloutOwned: Boolean(row.rollout_reserved),
          draining: String(row.observed_state) === "draining",
        })),
        offers: offers.map((row) => ({
          provider: String(row.provider),
          regionId: String(row.region_id),
          gpuSku: String(row.gpu_sku),
          availableReplicas: Number(row.available_replicas),
          pricePerGpuHourMinor: Number(row.price_per_gpu_hour_minor),
          coldStartSeconds: Number(policy.provisioning_p90_seconds ?? 300),
          failureRateBasisPoints: 0,
          transferCostMinorPerTask: 0,
          healthy: true,
          snapshotFresh: timestamp.getTime() - new Date(row.observed_at as Date | string).getTime() <= 300_000,
        })),
      });
    }
    return snapshots;
  }

  async record(
    input: Readonly<{
      snapshot: CapacityPoolSnapshot;
      result: Readonly<Record<string, unknown>>;
      status: "planned" | "applied" | "suppressed" | "admission_control";
      strategyVersion: string;
    }>,
  ): Promise<string> {
    const timestamp = this.now();
    const result = input.result;
    const id = this.createId("capacity_plan");
    await this.sql`INSERT INTO capacity_plans (
        id, project_id, pool_id, policy_version_id, status, observed_at, input_snapshot, result,
        current_replicas, desired_replicas, workload_replicas, queue_slo_replicas,
        cost_minor, benefit_minor, net_benefit_minor, admission_control, suppression_reason,
        strategy_version, created_at
      ) VALUES (
        ${id}, ${input.snapshot.projectId}, ${input.snapshot.poolId}, ${input.snapshot.policyVersionId ?? null},
        ${input.status}, ${timestamp.toISOString()}, ${JSON.stringify(input.snapshot)}, ${JSON.stringify(result)},
        ${input.snapshot.currentDesiredReplicas}, ${Number(result.desired_replicas ?? input.snapshot.currentDesiredReplicas)},
        ${Number(result.workload_replicas ?? 0)}, ${Number(result.queue_slo_replicas ?? 0)},
        ${Number(result.cost_minor ?? 0)}, ${Number(result.benefit_minor ?? 0)}, ${Number(result.net_benefit_minor ?? 0)},
        ${Boolean(result.admission_control)}, ${result.suppressed_by ? String(result.suppressed_by) : null},
        ${input.strategyVersion}, ${timestamp.toISOString()}
      )`;
    return id;
  }
}
