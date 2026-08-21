import { createHash } from "node:crypto";
import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

export type SchedulingTaskSnapshot = Readonly<{
  taskId: string;
  projectId: string;
  releaseId: string;
  taskVersion: number;
  lane: "online" | "batch";
  createdAt: string;
  expectedGpuSeconds: number;
  predictionP95Seconds: number;
  predictionSource: "profile" | "cold_baseline";
  projectWeight: number;
  virtualGpuMilliseconds: number;
  batchMinSharePercent: number;
  agingSeconds: number;
  laneAssignedGpuSeconds: Readonly<{ online: number; batch: number }>;
}>;

export type SchedulingReplicaSnapshot = Readonly<{
  replicaId: string;
  replicaVersion: number;
  poolId: string;
  releaseId: string;
  workerId: string;
  regionId: string;
  gpuSku: string;
  maximumConcurrency: number;
  occupiedSlots: readonly number[];
  policyVersion: string;
}>;

export type SchedulingSnapshot = Readonly<{
  observedAt: string;
  tasks: readonly SchedulingTaskSnapshot[];
  replicas: readonly SchedulingReplicaSnapshot[];
}>;

export type ReservationRequest = Readonly<{
  decisionId: string;
  attemptId: string;
  leaseId: string;
  executionKey: string;
  traceId: string;
  task: SchedulingTaskSnapshot;
  replica: SchedulingReplicaSnapshot;
  slotIndex: number;
  reason: string;
  reservationSeconds: number;
  workerFreshnessSeconds: number;
  inputSnapshot: Record<string, unknown>;
}>;

export type Reservation = Readonly<{
  decisionId: string;
  attemptId: string;
  leaseId: string;
  taskId: string;
  replicaId: string;
  workerId: string;
  slotIndex: number;
  taskVersion: number;
  leaseVersion: number;
  expiresAt: string;
}>;

const activeAttemptStatuses = "('reserved', 'leased', 'running', 'unknown')";

const numberArray = (value: unknown): readonly number[] => {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((item) => Number.isInteger(item) && item >= 0);
};
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  return value;
};
const profileHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

export class SchedulingRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: (prefix: string) => string = (prefix) => `${prefix}_${Bun.randomUUIDv7()}`,
  ) {}

  async snapshot(limit: number, workerFreshnessSeconds: number): Promise<SchedulingSnapshot> {
    const observedAt = this.now();
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const freshAfter = new Date(observedAt.getTime() - workerFreshnessSeconds * 1000);
    const tasks = await this.sql`SELECT t.id, t.project_id, t.model_release_id, t.priority, t.version, t.created_at,
        t.scheduling_profile, t.baseline_gpu_seconds, COALESCE(q.scheduling_weight, 100) AS project_weight
      FROM tasks t JOIN model_releases mr ON mr.id=t.model_release_id
      LEFT JOIN project_quotas q ON q.project_id=t.project_id
      WHERE t.status='queued' AND (mr.accept_new_tasks=true OR mr.accept_existing_tasks=true) AND mr.status='approved'
        AND (t.retry_not_before IS NULL OR t.retry_not_before<=${observedAt.toISOString()})
        AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id=t.id
          AND a.status IN ('reserved', 'leased', 'running', 'unknown'))
        AND EXISTS (SELECT 1 FROM replicas candidate JOIN model_pools p ON p.id=candidate.pool_id
          WHERE candidate.release_id=t.model_release_id AND p.status='active'
            AND candidate.desired_state='ready' AND candidate.observed_state IN ('ready','busy'))
      ORDER BY t.created_at, t.id
      LIMIT ${Math.min(boundedLimit * 4, 2000)}`;
    const releaseIds = [...new Set(tasks.map((row) => String(row.model_release_id)))];
    if (releaseIds.length === 0) return { observedAt: observedAt.toISOString(), tasks: [], replicas: [] };

    const replicas = await this.sql`SELECT r.id, r.version, r.pool_id, r.release_id, w.id AS worker_id,
        r.region_id, r.gpu_sku,
        LEAST(64, CASE
          WHEN (w.capabilities->>'max_concurrency') ~ '^[1-9][0-9]*$'
            THEN (w.capabilities->>'max_concurrency')::int
          ELSE 1 END, CASE
          WHEN (mr.manifest->>'max_concurrency') ~ '^[1-9][0-9]*$'
            THEN (mr.manifest->>'max_concurrency')::int
          ELSE 1 END)::int AS maximum_concurrency,
        COALESCE(array_agg(a.slot_index ORDER BY a.slot_index)
          FILTER (WHERE a.id IS NOT NULL AND a.slot_index IS NOT NULL), '{}'::int[]) AS occupied_slots,
        COALESCE((SELECT 'capacity:' || pv.id FROM policy_versions pv
          WHERE pv.pool_id=p.id AND pv.policy_type='capacity' AND pv.status='published'
          ORDER BY pv.version DESC LIMIT 1), 'baseline-v1') AS policy_version
      FROM replicas r
      JOIN model_pools p ON p.id=r.pool_id
      JOIN model_releases mr ON mr.id=r.release_id
      JOIN workers w ON w.replica_id=r.id AND w.release_id=r.release_id
      LEFT JOIN attempts a ON a.replica_id=r.id AND a.status IN ('reserved', 'leased', 'running', 'unknown')
      WHERE r.release_id=ANY(${this.sql.array(releaseIds)}::text[])
        AND p.region_id=r.region_id AND p.gpu_sku=r.gpu_sku
        AND p.status='active' AND r.desired_state='ready' AND r.observed_state IN ('ready', 'busy')
        AND r.rollout_reserved=false AND w.status IN ('ready', 'busy')
        AND w.last_heartbeat_at IS NOT NULL AND w.last_heartbeat_at>=${freshAfter.toISOString()}
      GROUP BY r.id, r.version, r.pool_id, r.release_id, w.id, r.region_id, r.gpu_sku,
        w.capabilities, mr.manifest, p.id
      ORDER BY r.release_id, r.region_id, r.pool_id, r.id`;

    const [profiles, policies, projectAccounts, laneAccounts] = await Promise.all([
      this.sql`SELECT release_id, gpu_sku, dimensions_hash, sample_count, p75_seconds, p95_seconds, ewma_seconds
        FROM service_time_profiles WHERE release_id=ANY(${this.sql.array(releaseIds)}::text[])
        ORDER BY release_id, gpu_sku, dimensions_hash`,
      this.sql`SELECT p.release_id, pv.id, pv.configuration FROM model_pools p
        JOIN policy_versions pv ON pv.pool_id=p.id AND pv.policy_type='capacity' AND pv.status='published'
        WHERE p.status='active' AND p.release_id=ANY(${this.sql.array(releaseIds)}::text[])
        ORDER BY p.release_id, p.id, pv.version DESC`,
      this.sql`SELECT release_id, project_id, lane, virtual_gpu_milliseconds
        FROM project_scheduling_accounts WHERE release_id=ANY(${this.sql.array(releaseIds)}::text[])`,
      this.sql`SELECT release_id, lane, window_started_at, assigned_gpu_seconds
        FROM scheduler_lane_accounts WHERE release_id=ANY(${this.sql.array(releaseIds)}::text[])`,
    ]);
    const policyByRelease = new Map<string, Record<string, unknown>>();
    for (const row of policies) {
      const releaseId = String(row.release_id);
      if (!policyByRelease.has(releaseId)) policyByRelease.set(releaseId, row.configuration as Record<string, unknown>);
    }
    const virtualByAccount = new Map(
      projectAccounts.map((row) => [
        `${String(row.release_id)}\u0000${String(row.project_id)}\u0000${String(row.lane)}`,
        Number(row.virtual_gpu_milliseconds),
      ]),
    );
    const laneByRelease = new Map<string, { online: number; batch: number }>();
    for (const row of laneAccounts) {
      const releaseId = String(row.release_id);
      const current = laneByRelease.get(releaseId) ?? { online: 0, batch: 0 };
      const fresh = observedAt.getTime() - new Date(row.window_started_at as Date | string).getTime() < 60 * 60 * 1000;
      current[row.lane === "batch" ? "batch" : "online"] = fresh ? Number(row.assigned_gpu_seconds) : 0;
      laneByRelease.set(releaseId, current);
    }
    const gpuSkusByRelease = new Map<string, Set<string>>();
    for (const replica of replicas) {
      const releaseId = String(replica.release_id);
      const skus = gpuSkusByRelease.get(releaseId) ?? new Set<string>();
      skus.add(String(replica.gpu_sku));
      gpuSkusByRelease.set(releaseId, skus);
    }
    return {
      observedAt: observedAt.toISOString(),
      tasks: tasks.slice(0, boundedLimit).map((row) => {
        const releaseId = String(row.model_release_id);
        const dimensionsHash = profileHash(row.scheduling_profile);
        const policy = policyByRelease.get(releaseId) ?? {};
        const minimumSamples = Number(policy.prediction_min_samples ?? 30);
        const matches = profiles.filter(
          (profile) =>
            String(profile.release_id) === releaseId &&
            String(profile.dimensions_hash) === dimensionsHash &&
            (gpuSkusByRelease.get(releaseId)?.has(String(profile.gpu_sku)) ?? false) &&
            Number(profile.sample_count) >= minimumSamples,
        );
        const selected = matches.sort(
          (left, right) =>
            Number(right.p75_seconds) - Number(left.p75_seconds) ||
            String(left.gpu_sku).localeCompare(String(right.gpu_sku)),
        )[0];
        const baseline = Math.max(1, Number(row.baseline_gpu_seconds));
        const expected = selected
          ? Math.max(1, Math.ceil((Number(selected.p75_seconds) * 3 + Number(selected.ewma_seconds)) / 4))
          : baseline;
        const lane = row.priority === "batch" ? "batch" : "online";
        const projectId = String(row.project_id);
        return {
          taskId: String(row.id),
          projectId,
          releaseId,
          taskVersion: Number(row.version),
          lane,
          createdAt: new Date(row.created_at as Date | string).toISOString(),
          expectedGpuSeconds: expected,
          predictionP95Seconds: selected ? Number(selected.p95_seconds) : baseline,
          predictionSource: selected ? ("profile" as const) : ("cold_baseline" as const),
          projectWeight: Math.max(1, Number(row.project_weight)),
          virtualGpuMilliseconds: virtualByAccount.get(`${releaseId}\u0000${projectId}\u0000${lane}`) ?? 0,
          batchMinSharePercent: Number(policy.batch_min_share_percent ?? 10),
          agingSeconds: Number(policy.aging_seconds ?? 1800),
          laneAssignedGpuSeconds: laneByRelease.get(releaseId) ?? { online: 0, batch: 0 },
        };
      }),
      replicas: replicas.map((row) => ({
        replicaId: String(row.id),
        replicaVersion: Number(row.version),
        poolId: String(row.pool_id),
        releaseId: String(row.release_id),
        workerId: String(row.worker_id),
        regionId: String(row.region_id),
        gpuSku: String(row.gpu_sku),
        maximumConcurrency: Number(row.maximum_concurrency),
        occupiedSlots: numberArray(row.occupied_slots),
        policyVersion: String(row.policy_version),
      })),
    };
  }

  async reserve(input: ReservationRequest): Promise<Reservation | undefined> {
    if (!Number.isInteger(input.slotIndex) || input.slotIndex < 0) throw new Error("invalid_slot_index");
    if (!Number.isInteger(input.task.expectedGpuSeconds) || input.task.expectedGpuSeconds < 1) {
      throw new Error("invalid_expected_gpu_seconds");
    }
    if (!Number.isInteger(input.task.projectWeight) || input.task.projectWeight < 1) {
      throw new Error("invalid_project_weight");
    }
    if (!Number.isInteger(input.reservationSeconds) || input.reservationSeconds < 5) {
      throw new Error("invalid_reservation_seconds");
    }
    const timestamp = this.now();
    const freshAfter = new Date(timestamp.getTime() - input.workerFreshnessSeconds * 1000);
    const expiresAt = new Date(timestamp.getTime() + input.reservationSeconds * 1000);
    try {
      return await this.sql.begin(async (transaction) => {
        const tasks = await transaction`SELECT t.id, t.project_id, t.model_release_id, t.status, t.version,
            t.retry_not_before, mr.accept_new_tasks, mr.accept_existing_tasks, mr.status AS release_status
          FROM tasks t JOIN model_releases mr ON mr.id=t.model_release_id
          WHERE t.id=${input.task.taskId} FOR UPDATE OF t`;
        const task = tasks[0];
        if (
          task?.status !== "queued" ||
          Number(task.version) !== input.task.taskVersion ||
          String(task.model_release_id) !== input.task.releaseId ||
          (task.retry_not_before && new Date(task.retry_not_before as Date | string) > timestamp) ||
          (task.accept_new_tasks !== true && task.accept_existing_tasks !== true) ||
          task.release_status !== "approved"
        ) {
          return undefined;
        }
        const active = await transaction.unsafe(
          `SELECT 1 FROM attempts WHERE task_id=$1 AND status IN ${activeAttemptStatuses} LIMIT 1`,
          [input.task.taskId],
        );
        if (active[0]) return undefined;

        const resourceRows = await transaction`SELECT r.id, r.version, r.pool_id, r.release_id,
            r.desired_state, r.observed_state, r.rollout_reserved, p.status AS pool_status,
            p.region_id, p.gpu_sku, w.id AS worker_id, w.status AS worker_status,
            w.last_heartbeat_at, w.capabilities, mr.manifest
          FROM replicas r JOIN model_pools p ON p.id=r.pool_id
          JOIN workers w ON w.replica_id=r.id JOIN model_releases mr ON mr.id=r.release_id
          WHERE r.id=${input.replica.replicaId} FOR UPDATE OF r, w`;
        const resource = resourceRows[0];
        if (
          !resource ||
          Number(resource.version) !== input.replica.replicaVersion ||
          String(resource.pool_id) !== input.replica.poolId ||
          String(resource.release_id) !== input.task.releaseId ||
          String(resource.worker_id) !== input.replica.workerId ||
          resource.pool_status !== "active" ||
          resource.desired_state !== "ready" ||
          !["ready", "busy"].includes(String(resource.observed_state)) ||
          resource.rollout_reserved === true ||
          !["ready", "busy"].includes(String(resource.worker_status)) ||
          !resource.last_heartbeat_at ||
          new Date(resource.last_heartbeat_at as Date | string) < freshAfter
        ) {
          return undefined;
        }
        const capabilities = (resource.capabilities ?? {}) as Record<string, unknown>;
        const manifest = (resource.manifest ?? {}) as Record<string, unknown>;
        const reportedConcurrency = Number(capabilities.max_concurrency ?? 1);
        const approvedConcurrency = Number(manifest.max_concurrency ?? 1);
        if (
          !Number.isInteger(reportedConcurrency) ||
          reportedConcurrency < 1 ||
          !Number.isInteger(approvedConcurrency) ||
          approvedConcurrency < 1
        ) {
          return undefined;
        }
        const maximumConcurrency = Math.min(64, reportedConcurrency, approvedConcurrency);
        if (!Number.isInteger(maximumConcurrency) || input.slotIndex >= maximumConcurrency) return undefined;
        const occupied = await transaction.unsafe(
          `SELECT 1 FROM attempts WHERE replica_id=$1 AND slot_index=$2 AND status IN ${activeAttemptStatuses} LIMIT 1`,
          [input.replica.replicaId, input.slotIndex],
        );
        if (occupied[0]) return undefined;

        const attemptNumbers = await transaction`SELECT COALESCE(max(attempt_no), 0)::int + 1 AS next_attempt_no
          FROM attempts WHERE task_id=${input.task.taskId}`;
        const attemptNo = Number(attemptNumbers[0]?.next_attempt_no ?? 1);
        await transaction`INSERT INTO scheduling_decisions (
          id, task_id, release_id, pool_id, replica_id, worker_id, task_version, replica_version,
          slot_index, policy_version, reason, input_snapshot, outcome, decided_at
        ) VALUES (
          ${input.decisionId}, ${input.task.taskId}, ${input.task.releaseId}, ${input.replica.poolId},
          ${input.replica.replicaId}, ${input.replica.workerId}, ${input.task.taskVersion},
          ${input.replica.replicaVersion}, ${input.slotIndex}, ${input.replica.policyVersion}, ${input.reason},
          ${JSON.stringify(input.inputSnapshot)}, 'reserved', ${timestamp.toISOString()}
        )`;
        await transaction`INSERT INTO attempts (
          id, task_id, release_id, status, execution_key, attempt_no, pool_id, replica_id, slot_index,
          decision_id, task_version_at_assignment, reservation_expires_at, expected_gpu_seconds,
          prediction_source, retry_disposition, created_at, updated_at
        ) VALUES (
          ${input.attemptId}, ${input.task.taskId}, ${input.task.releaseId}, 'reserved', ${input.executionKey},
          ${attemptNo}, ${input.replica.poolId}, ${input.replica.replicaId}, ${input.slotIndex},
          ${input.decisionId}, ${input.task.taskVersion}, ${expiresAt.toISOString()}, ${input.task.expectedGpuSeconds},
          ${input.task.predictionSource}, 'none',
          ${timestamp.toISOString()}, ${timestamp.toISOString()}
        )`;
        await transaction`INSERT INTO leases (
          id, attempt_id, worker_id, replica_id, status, expires_at, version, created_at, updated_at
        ) VALUES (
          ${input.leaseId}, ${input.attemptId}, ${input.replica.workerId}, ${input.replica.replicaId},
          'reserved', ${expiresAt.toISOString()}, 0, ${timestamp.toISOString()}, ${timestamp.toISOString()}
        )`;
        const changed = await transaction`UPDATE tasks SET version=version+1, updated_at=${timestamp.toISOString()}
          WHERE id=${input.task.taskId} AND version=${input.task.taskVersion} AND status='queued'
          RETURNING version`;
        if (!changed[0]) throw new Error("task_assignment_cas_failed");
        const taskVersion = Number(changed[0].version);
        const virtualCharge = Math.max(
          1,
          Math.ceil((input.task.expectedGpuSeconds * 1000) / Math.max(1, input.task.projectWeight)),
        );
        await transaction`INSERT INTO project_scheduling_accounts (
            release_id, project_id, lane, project_weight, virtual_gpu_milliseconds,
            assigned_gpu_seconds, version, updated_at
          ) VALUES (
            ${input.task.releaseId}, ${input.task.projectId}, ${input.task.lane}, ${input.task.projectWeight},
            ${virtualCharge}, ${input.task.expectedGpuSeconds}, 1, ${timestamp.toISOString()}
          ) ON CONFLICT (release_id, project_id, lane) DO UPDATE SET
            project_weight=EXCLUDED.project_weight,
            virtual_gpu_milliseconds=project_scheduling_accounts.virtual_gpu_milliseconds+EXCLUDED.virtual_gpu_milliseconds,
            assigned_gpu_seconds=project_scheduling_accounts.assigned_gpu_seconds+EXCLUDED.assigned_gpu_seconds,
            version=project_scheduling_accounts.version+1, updated_at=EXCLUDED.updated_at`;
        await transaction`INSERT INTO scheduler_lane_accounts (
            release_id, lane, window_started_at, assigned_gpu_seconds, version, updated_at
          ) VALUES (
            ${input.task.releaseId}, ${input.task.lane}, ${timestamp.toISOString()},
            ${input.task.expectedGpuSeconds}, 1, ${timestamp.toISOString()}
          ) ON CONFLICT (release_id, lane) DO UPDATE SET
            window_started_at=CASE
              WHEN scheduler_lane_accounts.window_started_at<=${new Date(timestamp.getTime() - 60 * 60 * 1000).toISOString()}
                THEN EXCLUDED.window_started_at ELSE scheduler_lane_accounts.window_started_at END,
            assigned_gpu_seconds=CASE
              WHEN scheduler_lane_accounts.window_started_at<=${new Date(timestamp.getTime() - 60 * 60 * 1000).toISOString()}
                THEN EXCLUDED.assigned_gpu_seconds
              ELSE scheduler_lane_accounts.assigned_gpu_seconds+EXCLUDED.assigned_gpu_seconds END,
            version=scheduler_lane_accounts.version+1, updated_at=EXCLUDED.updated_at`;
        await transaction`INSERT INTO task_state_events (
          id, task_id, from_status, to_status, reason, version, created_at
        ) VALUES (
          ${this.createId("evt")}, ${input.task.taskId}, 'queued', 'queued', 'slot_reserved',
          ${taskVersion}, ${timestamp.toISOString()}
        )`;
        await transaction`INSERT INTO outbox_events (
          id, aggregate_type, aggregate_id, aggregate_version, event_type, trace_id, payload, created_at
        ) VALUES (
          ${this.createId("evt")}, 'generation_task', ${input.task.taskId}, ${taskVersion}, 'task.reserved',
          ${input.traceId}, ${JSON.stringify({
            task_id: input.task.taskId,
            attempt_id: input.attemptId,
            lease_id: input.leaseId,
            replica_id: input.replica.replicaId,
            slot_index: input.slotIndex,
            reservation_expires_at: expiresAt.toISOString(),
          })}, ${timestamp.toISOString()}
        )`;
        return {
          decisionId: input.decisionId,
          attemptId: input.attemptId,
          leaseId: input.leaseId,
          taskId: input.task.taskId,
          replicaId: input.replica.replicaId,
          workerId: input.replica.workerId,
          slotIndex: input.slotIndex,
          taskVersion,
          leaseVersion: 0,
          expiresAt: expiresAt.toISOString(),
        };
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") return undefined;
      throw error;
    }
  }

  async expireReservations(limit: number): Promise<number> {
    const timestamp = this.now();
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`SELECT l.id AS lease_id, l.version AS lease_version,
          a.id AS attempt_id, a.task_id, t.status AS task_status
        FROM leases l JOIN attempts a ON a.id=l.attempt_id JOIN tasks t ON t.id=a.task_id
        WHERE l.status='reserved' AND a.status='reserved' AND l.expires_at<=${timestamp.toISOString()}
        ORDER BY l.expires_at, l.id LIMIT ${Math.min(Math.max(limit, 1), 500)}
        FOR UPDATE OF l, a, t SKIP LOCKED`;
      for (const row of rows) {
        await transaction`UPDATE leases SET status='expired', version=version+1, updated_at=${timestamp.toISOString()}
          WHERE id=${String(row.lease_id)} AND version=${Number(row.lease_version)} AND status='reserved'`;
        await transaction`UPDATE attempts SET status='expired', updated_at=${timestamp.toISOString()},
          completed_at=${timestamp.toISOString()} WHERE id=${String(row.attempt_id)} AND status='reserved'`;
        if (row.task_status !== "queued") continue;
        const changed = await transaction`UPDATE tasks SET version=version+1, updated_at=${timestamp.toISOString()}
          WHERE id=${String(row.task_id)} AND status='queued' RETURNING version`;
        if (!changed[0]) continue;
        const version = Number(changed[0].version);
        await transaction`INSERT INTO task_state_events (
          id, task_id, from_status, to_status, reason, version, created_at
        ) VALUES (
          ${this.createId("evt")}, ${String(row.task_id)}, 'queued', 'queued', 'reservation_expired',
          ${version}, ${timestamp.toISOString()}
        )`;
        await transaction`INSERT INTO outbox_events (
          id, aggregate_type, aggregate_id, aggregate_version, event_type, trace_id, payload, created_at
        ) VALUES (
          ${this.createId("evt")}, 'generation_task', ${String(row.task_id)}, ${version}, 'task.queued',
          ${`trace_${String(row.attempt_id)}`}, ${JSON.stringify({
            task_id: String(row.task_id),
            expired_attempt_id: String(row.attempt_id),
            reason: "reservation_expired",
          })}, ${timestamp.toISOString()}
        )`;
      }
      return rows.length;
    });
  }
}
