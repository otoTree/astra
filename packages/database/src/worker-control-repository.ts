import { createHash } from "node:crypto";
import {
  type CompleteAttempt,
  type CompleteOutputs,
  capabilitiesSchema,
  type DrainedWorker,
  type FailAttempt,
  type InferenceRequest,
  inferenceRequestSchema,
  inputMediaTypeForContentType,
  type MediaMetadata,
  outputManifestSchema,
  type PrepareOutputs,
  type WorkerHeartbeat,
  type WorkerHeartbeatResponse,
  type WorkerLeaseRequest,
  type WorkerRegistration,
} from "@astra/contracts";
import type postgres from "postgres";
import { RequestCipher } from "./request-cipher.ts";

type SqlClient = ReturnType<typeof postgres>;

export class WorkerControlError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(code);
  }
}

export type WorkerIdentity = Readonly<{
  workerId: string;
  replicaId: string;
  releaseId: string;
  poolId: string;
  instanceFingerprint: string;
  sessionId: string;
  sessionExpiresAt: string;
}>;

export type RegisteredWorker = WorkerIdentity &
  Readonly<{
    capabilitiesHash: string;
  }>;

export type InputDownloadMaterial = Readonly<{
  fileId: string;
  objectKey: string;
}>;

export type LeasedAttemptMaterial = Readonly<{
  attemptId: string;
  leaseId: string;
  leaseVersion: number;
  leaseExpiresAt: string;
  executionKey: string;
  inference: InferenceRequest;
  inputDownloads: readonly InputDownloadMaterial[];
}>;

export type PreparedOutput = Readonly<{
  outputIndex: number;
  fileId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  declaredMedia: MediaMetadata;
}>;

export type TerminalAttempt = Readonly<{
  attempt_id: string;
  task_id: string;
  attempt_status: "completed" | "failed" | "canceled";
  task_status: "completed" | "failed" | "canceled";
  lease_version: number;
}>;

type TaskExecutionSnapshot = Readonly<{ request: Record<string, unknown>; execution: Record<string, unknown> }>;

const activeStatuses = ["reserved", "leased", "running", "unknown"] as const;
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
export const canonicalHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
const unix = (value: Date | string): number => Math.floor(new Date(value).getTime() / 1000);
const extensionFor = (contentType: string): string =>
  ({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
  })[contentType] ?? "bin";
const safePart = (value: string): string => value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");

export class WorkerControlRepository {
  private readonly cipher: RequestCipher;

  constructor(
    private readonly sql: SqlClient,
    requestEncryptionKey: string,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: (prefix: string) => string = (prefix) => `${prefix}_${Bun.randomUUIDv7()}`,
  ) {
    this.cipher = new RequestCipher(requestEncryptionKey);
  }

  async register(
    input: WorkerRegistration,
    bootstrapTokenHash: string,
    session: Readonly<{ id: string; tokenHash: string; expiresAt: Date }>,
  ): Promise<RegisteredWorker> {
    const timestamp = this.now();
    const capabilityHash = canonicalHash(input.capabilities);
    return this.sql.begin(async (transaction) => {
      const bootstrapRows = await transaction`SELECT b.id, b.replica_id, b.release_id, b.expires_at, b.used_at,
          r.pool_id, r.provider, r.provider_resource_id, r.region_id, r.gpu_sku, r.desired_state,
          r.observed_state, mr.manifest
        FROM worker_bootstrap_tokens b JOIN replicas r ON r.id=b.replica_id
        JOIN model_releases mr ON mr.id=b.release_id
        WHERE b.token_hash=${bootstrapTokenHash} FOR UPDATE OF b, r`;
      const bootstrap = bootstrapRows[0];
      if (!bootstrap || bootstrap.used_at || new Date(bootstrap.expires_at as Date | string) <= timestamp) {
        throw new WorkerControlError("invalid_bootstrap_token", 401);
      }
      if (
        String(bootstrap.replica_id) !== input.replica_id ||
        String(bootstrap.release_id) !== input.release_id ||
        String(bootstrap.pool_id) !== input.pool_id ||
        String(bootstrap.provider) !== input.provider ||
        String(bootstrap.provider_resource_id) !== input.provider_instance_id ||
        String(bootstrap.region_id) !== input.region ||
        String(bootstrap.gpu_sku) !== input.hardware.gpu_sku ||
        !["provisioning", "ready"].includes(String(bootstrap.desired_state)) ||
        !["provisioning", "ready"].includes(String(bootstrap.observed_state))
      ) {
        throw new WorkerControlError("worker_registration_binding_mismatch", 409);
      }
      if (input.capabilities.contract_version !== "1.0" || input.capabilities.model_release !== input.release_id) {
        throw new WorkerControlError("worker_contract_mismatch", 422);
      }
      const manifest = (bootstrap.manifest ?? {}) as Record<string, unknown>;
      const approvedConcurrency = Number(manifest.max_concurrency ?? 1);
      if (!Number.isInteger(approvedConcurrency) || input.capabilities.max_concurrency > approvedConcurrency) {
        throw new WorkerControlError("worker_capability_expansion", 422);
      }
      capabilitiesSchema.parse(input.capabilities);

      const existingRows = await transaction`SELECT id, release_id, instance_fingerprint, desired_state
        FROM workers WHERE replica_id=${input.replica_id} FOR UPDATE`;
      const existing = existingRows[0];
      if (
        existing &&
        (String(existing.release_id) !== input.release_id ||
          (existing.instance_fingerprint && String(existing.instance_fingerprint) !== input.instance_fingerprint))
      ) {
        throw new WorkerControlError("worker_identity_conflict", 409);
      }
      const workerId = existing ? String(existing.id) : this.createId("worker");
      if (existing) {
        await transaction`UPDATE workers SET contract_version=${input.capabilities.contract_version},
          capabilities=${JSON.stringify(input.capabilities)}, capabilities_hash=${capabilityHash},
          provider=${input.provider}, region_id=${input.region}, provider_instance_id=${input.provider_instance_id},
          pool_id=${input.pool_id}, instance_fingerprint=${input.instance_fingerprint},
          hardware=${JSON.stringify(input.hardware)}, status=CASE WHEN desired_state='run' THEN 'ready' ELSE 'draining' END,
          last_heartbeat_at=${timestamp.toISOString()}, unknown_since=NULL, updated_at=${timestamp.toISOString()}
          WHERE id=${workerId}`;
      } else {
        await transaction`INSERT INTO workers (
          id, replica_id, release_id, contract_version, status, capabilities, provider, region_id,
          provider_instance_id, pool_id, instance_fingerprint, hardware, capabilities_hash, desired_state,
          last_sequence, last_heartbeat_at, created_at, updated_at
        ) VALUES (
          ${workerId}, ${input.replica_id}, ${input.release_id}, ${input.capabilities.contract_version}, 'ready',
          ${JSON.stringify(input.capabilities)}, ${input.provider}, ${input.region}, ${input.provider_instance_id},
          ${input.pool_id}, ${input.instance_fingerprint}, ${JSON.stringify(input.hardware)}, ${capabilityHash},
          'run', 0, ${timestamp.toISOString()}, ${timestamp.toISOString()}, ${timestamp.toISOString()}
        )`;
      }
      await transaction`UPDATE worker_sessions SET status='revoked', ended_at=${timestamp.toISOString()}
        WHERE worker_id=${workerId} AND status='active'`;
      await transaction`INSERT INTO worker_sessions (
        id, worker_id, token_hash, instance_fingerprint, status, expires_at, created_at
      ) VALUES (
        ${session.id}, ${workerId}, ${session.tokenHash}, ${input.instance_fingerprint}, 'active',
        ${session.expiresAt.toISOString()}, ${timestamp.toISOString()}
      )`;
      await transaction`UPDATE worker_bootstrap_tokens SET used_at=${timestamp.toISOString()}
        WHERE id=${String(bootstrap.id)} AND used_at IS NULL`;
      await transaction`UPDATE replicas SET observed_state='ready',
        last_observed_at=${timestamp.toISOString()}, version=version+1, updated_at=${timestamp.toISOString()}
        WHERE id=${input.replica_id}`;
      return {
        workerId,
        replicaId: input.replica_id,
        releaseId: input.release_id,
        poolId: input.pool_id,
        instanceFingerprint: input.instance_fingerprint,
        sessionId: session.id,
        sessionExpiresAt: session.expiresAt.toISOString(),
        capabilitiesHash: capabilityHash,
      };
    });
  }

  async authenticate(tokenHash: string, workerId?: string): Promise<WorkerIdentity> {
    const rows = await this.sql`SELECT s.id AS session_id, s.expires_at, s.instance_fingerprint,
        w.id AS worker_id, w.replica_id, w.release_id, COALESCE(w.pool_id, r.pool_id) AS pool_id
      FROM worker_sessions s JOIN workers w ON w.id=s.worker_id JOIN replicas r ON r.id=w.replica_id
      WHERE s.token_hash=${tokenHash} AND s.status='active' AND s.expires_at>${this.now().toISOString()}
        AND (${workerId ?? null}::text IS NULL OR w.id=${workerId ?? null})`;
    const row = rows[0];
    if (!row) throw new WorkerControlError("invalid_worker_token", 401);
    return {
      workerId: String(row.worker_id),
      replicaId: String(row.replica_id),
      releaseId: String(row.release_id),
      poolId: String(row.pool_id),
      instanceFingerprint: String(row.instance_fingerprint),
      sessionId: String(row.session_id),
      sessionExpiresAt: new Date(row.expires_at as Date | string).toISOString(),
    };
  }

  async rotateSession(
    identity: WorkerIdentity,
    next: Readonly<{ id: string; tokenHash: string; expiresAt: Date }>,
  ): Promise<void> {
    const timestamp = this.now();
    await this.sql.begin(async (transaction) => {
      await transaction`INSERT INTO worker_sessions (
        id, worker_id, token_hash, instance_fingerprint, status, expires_at, created_at
      ) VALUES (
        ${next.id}, ${identity.workerId}, ${next.tokenHash}, ${identity.instanceFingerprint}, 'active',
        ${next.expiresAt.toISOString()}, ${timestamp.toISOString()}
      )`;
      const rows = await transaction`UPDATE worker_sessions SET status='rotated', ended_at=${timestamp.toISOString()},
          replaced_by_id=${next.id} WHERE id=${identity.sessionId} AND worker_id=${identity.workerId}
          AND status='active' RETURNING id`;
      if (!rows[0]) throw new WorkerControlError("worker_session_stale", 409);
    });
  }

  private async materialForAttempt(attemptId: string, identity: WorkerIdentity): Promise<LeasedAttemptMaterial> {
    const rows = await this.sql`SELECT a.id, a.execution_key, a.status, a.release_id, l.id AS lease_id,
        l.version AS lease_version, l.expires_at, l.status AS lease_status, t.id AS task_id,
        t.type, t.operation, t.request_ciphertext, t.expires_at AS task_expires_at
      FROM attempts a JOIN leases l ON l.attempt_id=a.id JOIN tasks t ON t.id=a.task_id
      WHERE a.id=${attemptId} AND a.replica_id=${identity.replicaId} AND a.release_id=${identity.releaseId}
        AND l.worker_id=${identity.workerId} AND l.replica_id=${identity.replicaId}`;
    const row = rows[0];
    if (!row || !["leased", "running"].includes(String(row.status)) || row.lease_status !== "active") {
      throw new WorkerControlError("assigned_attempt_not_found", 404);
    }
    const files = await this.sql`SELECT f.id, f.content_type, f.size_bytes, f.sha256, f.object_key,
        f.status, f.expires_at, tf.role, tf.ordinal FROM task_files tf JOIN files f ON f.id=tf.file_id
      WHERE tf.task_id=${String(row.task_id)} AND tf.direction='input'
      ORDER BY tf.ordinal, f.id`;
    const snapshot = this.cipher.open<TaskExecutionSnapshot>(String(row.request_ciphertext));
    const expectedInputs = Array.isArray(snapshot.request.input_files)
      ? snapshot.request.input_files.map((item) => {
          if (item === null || typeof item !== "object")
            throw new WorkerControlError("input_media_contract_mismatch", 422);
          const file = item as Record<string, unknown>;
          return { fileId: String(file.file_id), role: String(file.role) };
        })
      : [];
    if (
      files.length !== expectedInputs.length ||
      files.some((file, index) => {
        const expected = expectedInputs[index];
        return !expected || String(file.id) !== expected.fileId || String(file.role) !== expected.role;
      })
    ) {
      throw new WorkerControlError("input_set_mismatch", 409);
    }
    if (
      files.some(
        (file) =>
          file.status !== "available" || new Date(file.expires_at as Date | string).getTime() <= this.now().getTime(),
      )
    ) {
      throw new WorkerControlError("input_asset_unavailable", 409);
    }
    const inputs = files.map((file) => {
      const mediaType = inputMediaTypeForContentType(String(file.content_type));
      if (!mediaType) throw new WorkerControlError("input_media_contract_mismatch", 422);
      const filename = `${String(file.ordinal).padStart(3, "0")}-${safePart(String(file.role))}.${extensionFor(String(file.content_type))}`;
      return {
        file_id: String(file.id),
        type: mediaType,
        role: String(file.role),
        path: `/work/tasks/${safePart(String(row.id))}/inputs/${filename}`,
        content_type: String(file.content_type),
        size_bytes: Number(file.size_bytes),
        sha256: String(file.sha256),
      };
    });
    const taskExpiry = row.task_expires_at ? unix(row.task_expires_at as Date | string) : undefined;
    const deadline = Math.min(
      Math.floor(this.now().getTime() / 1000) + 6 * 60 * 60,
      taskExpiry ?? Number.MAX_SAFE_INTEGER,
    );
    const inference = inferenceRequestSchema.parse({
      execution_id: String(row.execution_key),
      task_id: String(row.task_id),
      type: row.type,
      operation: row.operation,
      model_release: String(row.release_id),
      request: snapshot.execution,
      inputs,
      output_dir: `/work/tasks/${safePart(String(row.id))}/outputs`,
      deadline_at: deadline,
    });
    return {
      attemptId: String(row.id),
      leaseId: String(row.lease_id),
      leaseVersion: Number(row.lease_version),
      leaseExpiresAt: new Date(row.expires_at as Date | string).toISOString(),
      executionKey: String(row.execution_key),
      inference,
      inputDownloads: files.map((file) => ({ fileId: String(file.id), objectKey: String(file.object_key) })),
    };
  }

  async lease(
    identity: WorkerIdentity,
    input: WorkerLeaseRequest,
    requestHash: string,
    leaseSeconds: number,
  ): Promise<LeasedAttemptMaterial | undefined> {
    const timestamp = this.now();
    const existingReceipt = await this.sql`SELECT request_hash, response_body FROM worker_request_receipts
      WHERE worker_id=${identity.workerId} AND operation='lease' AND sequence=${input.sequence}`;
    if (existingReceipt[0]) {
      if (String(existingReceipt[0].request_hash) !== requestHash) {
        throw new WorkerControlError("worker_sequence_conflict", 409);
      }
      const body = existingReceipt[0].response_body as { attempt_id?: unknown } | null;
      return body?.attempt_id ? this.materialForAttempt(String(body.attempt_id), identity) : undefined;
    }
    if (input.available_slots === 0) {
      await this.storeReceipt(identity.workerId, "lease", input.sequence, requestHash, 204, null);
      return undefined;
    }

    const attemptId = await this.sql.begin(async (transaction) => {
      const workerRows = await transaction`SELECT id, status, desired_state, capabilities_hash, capabilities,
          release_id, replica_id FROM workers WHERE id=${identity.workerId} FOR UPDATE`;
      const worker = workerRows[0];
      if (!worker) throw new WorkerControlError("worker_not_found", 404);
      if (worker.desired_state !== "run" || !["ready", "busy", "unknown"].includes(String(worker.status))) {
        return undefined;
      }
      if (String(worker.capabilities_hash) !== input.capabilities_hash) {
        throw new WorkerControlError("worker_capabilities_changed", 409);
      }
      const capabilities = capabilitiesSchema.parse(worker.capabilities);
      if (input.max_concurrency !== capabilities.max_concurrency) {
        throw new WorkerControlError("worker_slot_report_invalid", 409);
      }
      const activeRows = await transaction`SELECT count(*)::integer AS count FROM attempts a
        JOIN leases l ON l.attempt_id=a.id WHERE l.worker_id=${identity.workerId}
        AND a.status IN ('leased', 'running') AND l.status='active'`;
      const activeCount = Number(activeRows[0]?.count ?? 0);
      const recoveryRows = await transaction`SELECT a.id, a.status, l.status AS lease_status, l.version AS lease_version
        FROM attempts a JOIN leases l ON l.attempt_id=a.id
        WHERE l.worker_id=${identity.workerId} AND a.replica_id=${identity.replicaId}
          AND a.release_id=${identity.releaseId} AND a.status IN ('leased', 'running', 'unknown')
          AND l.status IN ('active', 'unknown')
        ORDER BY a.created_at, a.id LIMIT 1 FOR UPDATE OF a, l`;
      const recoveryAttempt = recoveryRows[0];
      if (recoveryAttempt && (recoveryAttempt.lease_status === "unknown" || input.running_slots < activeCount)) {
        if (recoveryAttempt.lease_status === "unknown") {
          const expiresAt = new Date(timestamp.getTime() + leaseSeconds * 1000);
          await transaction`UPDATE leases SET status='active', version=version+1,
            expires_at=${expiresAt.toISOString()}, heartbeat_at=${timestamp.toISOString()}, updated_at=${timestamp.toISOString()}
            WHERE attempt_id=${String(recoveryAttempt.id)} AND status='unknown'
            AND version=${Number(recoveryAttempt.lease_version)}`;
          await transaction`UPDATE attempts SET status='leased', updated_at=${timestamp.toISOString()}
            WHERE id=${String(recoveryAttempt.id)} AND status='unknown'`;
        }
        await transaction`INSERT INTO worker_request_receipts (
          worker_id, operation, sequence, request_hash, response_status, response_body, created_at
        ) VALUES (
          ${identity.workerId}, 'lease', ${input.sequence}, ${requestHash}, 200,
          ${JSON.stringify({ attempt_id: String(recoveryAttempt.id) })}, ${timestamp.toISOString()}
        )`;
        return String(recoveryAttempt.id);
      }
      if (worker.status === "unknown") return undefined;
      if (
        input.reserved_slots !== 0 ||
        input.running_slots !== activeCount ||
        input.available_slots !== input.max_concurrency - activeCount
      ) {
        throw new WorkerControlError("worker_slot_report_invalid", 409);
      }
      const rows = await transaction`SELECT a.id, a.task_id, a.status, l.id AS lease_id, l.status AS lease_status,
          l.version AS lease_version, l.expires_at, t.status AS task_status, t.version AS task_version
        FROM attempts a JOIN leases l ON l.attempt_id=a.id JOIN tasks t ON t.id=a.task_id
        WHERE a.replica_id=${identity.replicaId} AND a.release_id=${identity.releaseId}
          AND l.worker_id=${identity.workerId} AND l.replica_id=${identity.replicaId}
          AND a.status='reserved' AND l.status='reserved' AND l.expires_at>${timestamp.toISOString()}
        ORDER BY a.created_at, a.id LIMIT 1 FOR UPDATE OF a, l, t SKIP LOCKED`;
      const attempt = rows[0];
      if (!attempt) return undefined;
      const expiresAt = new Date(timestamp.getTime() + leaseSeconds * 1000);
      const leaseRows = await transaction`UPDATE leases SET status='active', version=version+1,
          expires_at=${expiresAt.toISOString()}, heartbeat_at=${timestamp.toISOString()}, updated_at=${timestamp.toISOString()}
        WHERE id=${String(attempt.lease_id)} AND status='reserved' AND version=${Number(attempt.lease_version)}
        RETURNING version`;
      if (!leaseRows[0]) throw new WorkerControlError("lease_cas_conflict", 409, true);
      await transaction`UPDATE attempts SET status='leased', reservation_expires_at=${expiresAt.toISOString()},
        updated_at=${timestamp.toISOString()} WHERE id=${String(attempt.id)} AND status='reserved'`;
      let taskVersion = Number(attempt.task_version);
      if (attempt.task_status === "queued") {
        const taskRows = await transaction`UPDATE tasks SET status='provisioning', version=version+1,
            updated_at=${timestamp.toISOString()} WHERE id=${String(attempt.task_id)} AND status='queued'
            AND version=${taskVersion} RETURNING version`;
        if (!taskRows[0]) throw new WorkerControlError("task_lease_cas_conflict", 409, true);
        taskVersion = Number(taskRows[0].version);
        await this.insertTaskEvent(
          transaction,
          String(attempt.task_id),
          "queued",
          "provisioning",
          "worker_leased",
          taskVersion,
          timestamp,
        );
      }
      await transaction`UPDATE workers SET status='busy', current_attempt_id=${String(attempt.id)},
        last_sequence=GREATEST(last_sequence, ${input.sequence}), updated_at=${timestamp.toISOString()}
        WHERE id=${identity.workerId}`;
      await transaction`INSERT INTO worker_request_receipts (
        worker_id, operation, sequence, request_hash, response_status, response_body, created_at
      ) VALUES (
        ${identity.workerId}, 'lease', ${input.sequence}, ${requestHash}, 200,
        ${JSON.stringify({ attempt_id: String(attempt.id) })}, ${timestamp.toISOString()}
      )`;
      return String(attempt.id);
    });
    if (!attemptId) {
      await this.storeReceipt(identity.workerId, "lease", input.sequence, requestHash, 204, null);
      return undefined;
    }
    try {
      return await this.materialForAttempt(attemptId, identity);
    } catch (error) {
      const deterministic =
        !(error instanceof WorkerControlError) ||
        ["input_set_mismatch", "input_asset_unavailable", "input_media_contract_mismatch"].includes(error.code);
      if (!deterministic) throw error;
      await this.rejectLeasedAttempt(attemptId, identity, "task_execution_payload_invalid");
      throw new WorkerControlError("task_execution_payload_invalid", 422);
    }
  }

  private async rejectLeasedAttempt(attemptId: string, identity: WorkerIdentity, code: string): Promise<void> {
    const timestamp = this.now();
    await this.sql.begin(async (transaction) => {
      const rows = await transaction`SELECT a.task_id, a.status, l.id AS lease_id, l.status AS lease_status,
          t.status AS task_status, t.version AS task_version FROM attempts a JOIN leases l ON l.attempt_id=a.id
        JOIN tasks t ON t.id=a.task_id WHERE a.id=${attemptId} AND a.replica_id=${identity.replicaId}
          AND a.release_id=${identity.releaseId} AND l.worker_id=${identity.workerId} FOR UPDATE OF a, l, t`;
      const current = rows[0];
      if (!current || !["leased", "running"].includes(String(current.status)) || current.lease_status !== "active") {
        return;
      }
      await transaction`UPDATE attempts SET status='failed', failure_code=${code},
        error=${JSON.stringify({ code, message: "Task execution payload is unavailable", retryable: false })},
        completed_at=${timestamp.toISOString()}, updated_at=${timestamp.toISOString()} WHERE id=${attemptId}`;
      await transaction`UPDATE leases SET status='released', version=version+1, updated_at=${timestamp.toISOString()}
        WHERE id=${String(current.lease_id)} AND status='active'`;
      if (!["completed", "failed", "canceled", "expired"].includes(String(current.task_status))) {
        const taskRows = await transaction`UPDATE tasks SET status='failed', progress=NULL,
          error=${JSON.stringify({ code, message: "Task execution payload is unavailable", retryable: false })},
          version=version+1, completed_at=${timestamp.toISOString()}, updated_at=${timestamp.toISOString()}
          WHERE id=${String(current.task_id)} AND version=${Number(current.task_version)} RETURNING version`;
        if (taskRows[0]) {
          await this.insertTaskEvent(
            transaction,
            String(current.task_id),
            String(current.task_status),
            "failed",
            code,
            Number(taskRows[0].version),
            timestamp,
          );
        }
      }
      await transaction`UPDATE admission_reservations SET status='released', release_reason='task_failed',
        released_at=${timestamp.toISOString()} WHERE resource_type='task' AND resource_id=${String(current.task_id)}
        AND status='held'`;
      const remaining = await transaction`SELECT a.id FROM attempts a JOIN leases l ON l.attempt_id=a.id
        WHERE l.worker_id=${identity.workerId} AND a.id<>${attemptId}
          AND a.status IN ('leased', 'running', 'unknown') AND l.status IN ('active', 'unknown')
        ORDER BY a.created_at, a.id LIMIT 1`;
      const remainingAttemptId = remaining[0] ? String(remaining[0].id) : null;
      await transaction`UPDATE workers SET status=CASE
          WHEN desired_state<>'run' THEN 'draining'
          WHEN ${remainingAttemptId}::text IS NOT NULL THEN 'busy'
          ELSE 'ready' END, current_attempt_id=${remainingAttemptId}, updated_at=${timestamp.toISOString()}
        WHERE id=${identity.workerId}`;
    });
  }

  private async storeReceipt(
    workerId: string,
    operation: "lease" | "heartbeat" | "drained",
    sequence: number,
    requestHash: string,
    status: number,
    body: Record<string, unknown> | null,
  ): Promise<void> {
    await this.sql`INSERT INTO worker_request_receipts (
      worker_id, operation, sequence, request_hash, response_status, response_body, created_at
    ) VALUES (
      ${workerId}, ${operation}, ${sequence}, ${requestHash}, ${status}, ${body ? JSON.stringify(body) : null},
      ${this.now().toISOString()}
    ) ON CONFLICT (worker_id, operation, sequence) DO NOTHING`;
  }

  async heartbeat(
    identity: WorkerIdentity,
    input: WorkerHeartbeat,
    requestHash: string,
    leaseSeconds: number,
  ): Promise<WorkerHeartbeatResponse> {
    const timestamp = this.now();
    return this.sql.begin(async (transaction) => {
      const receiptRows = await transaction`SELECT request_hash, response_body FROM worker_request_receipts
        WHERE worker_id=${identity.workerId} AND operation='heartbeat' AND sequence=${input.sequence}`;
      if (receiptRows[0]) {
        if (String(receiptRows[0].request_hash) !== requestHash) {
          throw new WorkerControlError("worker_sequence_conflict", 409);
        }
        return receiptRows[0].response_body as WorkerHeartbeatResponse;
      }
      const workerRows = await transaction`SELECT id, desired_state, release_id, replica_id FROM workers
        WHERE id=${identity.workerId} FOR UPDATE`;
      const worker = workerRows[0];
      if (
        !worker ||
        String(worker.release_id) !== identity.releaseId ||
        String(worker.replica_id) !== identity.replicaId
      ) {
        throw new WorkerControlError("worker_identity_mismatch", 403);
      }
      const renewed: WorkerHeartbeatResponse["leases"] = [];
      for (const execution of input.executions) {
        const rows = await transaction`SELECT a.id, a.task_id, a.status, a.progress, l.id AS lease_id,
            l.version AS lease_version, l.status AS lease_status, t.status AS task_status,
            t.version AS task_version FROM attempts a JOIN leases l ON l.attempt_id=a.id
          JOIN tasks t ON t.id=a.task_id WHERE a.id=${execution.attempt_id} AND l.id=${execution.lease_id}
            AND a.replica_id=${identity.replicaId} AND a.release_id=${identity.releaseId}
            AND l.worker_id=${identity.workerId} FOR UPDATE OF a, l, t`;
        const current = rows[0];
        if (!current) throw new WorkerControlError("lease_binding_mismatch", 409);
        if (
          Number(current.lease_version) !== execution.lease_version ||
          !["active", "unknown"].includes(String(current.lease_status))
        ) {
          throw new WorkerControlError("stale_lease_version", 409);
        }
        const expiresAt = new Date(timestamp.getTime() + leaseSeconds * 1000);
        const leaseRows = await transaction`UPDATE leases SET status='active', version=version+1,
            expires_at=${expiresAt.toISOString()}, heartbeat_at=${timestamp.toISOString()}, updated_at=${timestamp.toISOString()}
          WHERE id=${execution.lease_id} AND version=${execution.lease_version} AND status IN ('active', 'unknown')
          RETURNING version`;
        if (!leaseRows[0]) throw new WorkerControlError("lease_cas_conflict", 409, true);
        const leaseVersion = Number(leaseRows[0].version);
        renewed.push({
          attempt_id: execution.attempt_id,
          lease_id: execution.lease_id,
          lease_version: leaseVersion,
          lease_expires_at: unix(expiresAt),
          cancel_requested: ["canceling", "canceled"].includes(String(current.task_status)),
        });
        const progress =
          execution.progress === null ? null : Math.max(Number(current.progress ?? 0), execution.progress);
        const nextTaskStatus =
          execution.status === "post_processing" || execution.status === "completed"
            ? "post_processing"
            : ["accepted", "running"].includes(execution.status)
              ? "running"
              : undefined;
        const nextAttemptStatus = ["accepted", "running", "post_processing", "completed"].includes(execution.status)
          ? "running"
          : current.status;
        await transaction`UPDATE attempts SET status=${nextAttemptStatus}, stage=${execution.status},
          progress=${progress}, started_at=COALESCE(started_at, ${timestamp.toISOString()}),
          updated_at=${timestamp.toISOString()} WHERE id=${execution.attempt_id}`;
        if (
          nextTaskStatus &&
          current.task_status !== nextTaskStatus &&
          !["canceling", "canceled"].includes(String(current.task_status))
        ) {
          const taskRows = await transaction`UPDATE tasks SET status=${nextTaskStatus}, progress=${progress},
              version=version+1, updated_at=${timestamp.toISOString()} WHERE id=${String(current.task_id)}
              AND version=${Number(current.task_version)} RETURNING version`;
          if (taskRows[0]) {
            await this.insertTaskEvent(
              transaction,
              String(current.task_id),
              String(current.task_status),
              nextTaskStatus,
              `worker_${execution.status}`,
              Number(taskRows[0].version),
              timestamp,
            );
          }
        } else if (progress !== null) {
          await transaction`UPDATE tasks SET progress=GREATEST(COALESCE(progress, 0), ${progress}),
            updated_at=${timestamp.toISOString()} WHERE id=${String(current.task_id)}`;
        }
      }
      const desiredState = String(worker.desired_state);
      const status =
        desiredState === "drain" || desiredState === "shutdown"
          ? "draining"
          : input.running_slots + input.reserved_slots > 0
            ? "busy"
            : input.health.model_app_ready
              ? "ready"
              : "unknown";
      await transaction`UPDATE workers SET status=${status}, last_sequence=GREATEST(last_sequence, ${input.sequence}),
        last_heartbeat_at=${timestamp.toISOString()}, unknown_since=CASE WHEN ${status}='unknown'
          THEN COALESCE(unknown_since, ${timestamp.toISOString()}::timestamptz) ELSE NULL END,
        updated_at=${timestamp.toISOString()} WHERE id=${identity.workerId}`;
      await transaction`UPDATE replicas SET observed_state=${status === "busy" ? "busy" : status},
        last_observed_at=${timestamp.toISOString()}, version=version+1, updated_at=${timestamp.toISOString()}
        WHERE id=${identity.replicaId} AND observed_state<>'terminated'`;
      const response = {
        accepted_sequence: input.sequence,
        leases: renewed,
        desired_state: desiredState as WorkerHeartbeatResponse["desired_state"],
      };
      await transaction`INSERT INTO worker_request_receipts (
        worker_id, operation, sequence, request_hash, response_status, response_body, created_at
      ) VALUES (
        ${identity.workerId}, 'heartbeat', ${input.sequence}, ${requestHash}, 200,
        ${JSON.stringify(response)}, ${timestamp.toISOString()}
      )`;
      return response;
    });
  }

  async prepareOutputs(
    identity: WorkerIdentity,
    attemptId: string,
    input: PrepareOutputs,
  ): Promise<readonly PreparedOutput[]> {
    const manifest = outputManifestSchema.parse(input.manifest);
    const manifestHash = canonicalHash(manifest);
    const timestamp = this.now();
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`SELECT a.id, a.task_id, a.execution_key, a.status, a.outputs_status,
          a.output_manifest_hash, l.id AS lease_id, l.version AS lease_version, l.status AS lease_status,
          t.project_id, t.status AS task_status, t.version AS task_version, mr.manifest AS release_manifest,
          w.capabilities AS worker_capabilities
        FROM attempts a JOIN leases l ON l.attempt_id=a.id JOIN tasks t ON t.id=a.task_id
        JOIN model_releases mr ON mr.id=a.release_id JOIN workers w ON w.id=l.worker_id
        WHERE a.id=${attemptId} AND a.replica_id=${identity.replicaId} AND a.release_id=${identity.releaseId}
          AND l.worker_id=${identity.workerId} FOR UPDATE OF a, l, t`;
      const attempt = rows[0];
      if (!attempt || String(attempt.lease_id) !== input.lease_id) {
        throw new WorkerControlError("lease_binding_mismatch", 409);
      }
      if (
        Number(attempt.lease_version) < input.lease_version ||
        !["active", "unknown"].includes(String(attempt.lease_status))
      ) {
        throw new WorkerControlError("stale_lease_version", 409);
      }
      if (manifest.execution_id !== String(attempt.execution_key)) {
        throw new WorkerControlError("execution_identity_mismatch", 409);
      }
      const releaseManifest = attempt.release_manifest as Record<string, unknown>;
      const outputContract = (releaseManifest.output_contract ?? {}) as Record<string, unknown>;
      const workerCapabilities = capabilitiesSchema.parse(attempt.worker_capabilities);
      const allowedContentTypes = new Set(
        Array.isArray(outputContract.media_types)
          ? outputContract.media_types.map(String)
          : workerCapabilities.artifacts.output_artifacts.flatMap((artifact) => artifact.content_types),
      );
      const allowedByRole = new Map(
        workerCapabilities.artifacts.output_artifacts.map((artifact) => [
          artifact.role,
          new Set(artifact.content_types),
        ]),
      );
      const maximumOutputs = Math.min(
        workerCapabilities.artifacts.max_outputs,
        Number(outputContract.max_outputs ?? workerCapabilities.artifacts.max_outputs),
      );
      if (outputContract.preserve_original_bytes === false || manifest.outputs.length > maximumOutputs) {
        throw new WorkerControlError("release_output_contract_mismatch", 422);
      }
      for (const output of manifest.outputs) {
        if (
          !allowedContentTypes.has(output.content_type) ||
          !allowedByRole.get(output.role)?.has(output.content_type)
        ) {
          throw new WorkerControlError("release_output_contract_mismatch", 422);
        }
      }
      if (attempt.output_manifest_hash && String(attempt.output_manifest_hash) !== manifestHash) {
        throw new WorkerControlError("output_manifest_conflict", 409);
      }
      for (const output of manifest.outputs) {
        const expectedPrefix = `/work/tasks/${safePart(attemptId)}/outputs/`;
        if (!output.path.startsWith(expectedPrefix) || output.path.slice(expectedPrefix.length).includes("/")) {
          throw new WorkerControlError("output_path_invalid", 422);
        }
      }
      const existing = await transaction`SELECT aof.output_index, aof.file_id, f.object_key,
          aof.content_type, aof.size_bytes, aof.sha256, aof.media FROM attempt_output_files aof
        JOIN files f ON f.id=aof.file_id WHERE aof.attempt_id=${attemptId} ORDER BY aof.output_index`;
      if (existing.length > 0) return existing.map((row) => this.preparedOutput(row));
      const expiresAt = new Date(timestamp.getTime() + 15 * 60 * 1000);
      for (const [outputIndex, output] of manifest.outputs.entries()) {
        const fileId = this.createId("file");
        const objectKey = `outputs/${String(attempt.project_id)}/${String(attempt.task_id)}/${attemptId}/${fileId}`;
        await transaction`INSERT INTO files (
          id, project_id, filename, purpose, content_type, size_bytes, sha256, object_key,
          status, media, created_at, updated_at, expires_at
        ) VALUES (
          ${fileId}, ${String(attempt.project_id)}, ${output.path.split("/").at(-1) ?? `output-${outputIndex}`},
          'generation_output', ${output.content_type}, ${output.size_bytes}, ${output.sha256}, ${objectKey},
          'pending_upload', ${JSON.stringify(output.media)}, ${timestamp.toISOString()}, ${timestamp.toISOString()},
          ${expiresAt.toISOString()}
        )`;
        await transaction`INSERT INTO attempt_output_files (
          attempt_id, output_index, file_id, role, content_type, size_bytes, sha256, media,
          provenance, status, created_at
        ) VALUES (
          ${attemptId}, ${outputIndex}, ${fileId}, ${output.role}, ${output.content_type}, ${output.size_bytes},
          ${output.sha256}, ${JSON.stringify(output.media)}, ${JSON.stringify(output.provenance)}, 'prepared',
          ${timestamp.toISOString()}
        )`;
      }
      await transaction`UPDATE attempts SET output_manifest=${JSON.stringify(manifest)},
        output_manifest_hash=${manifestHash}, outputs_status='prepared', stage='uploading',
        updated_at=${timestamp.toISOString()} WHERE id=${attemptId}`;
      if (!["uploading", "canceling", "canceled"].includes(String(attempt.task_status))) {
        const taskRows = await transaction`UPDATE tasks SET status='uploading', version=version+1,
          updated_at=${timestamp.toISOString()} WHERE id=${String(attempt.task_id)}
          AND version=${Number(attempt.task_version)} RETURNING version`;
        if (taskRows[0]) {
          await this.insertTaskEvent(
            transaction,
            String(attempt.task_id),
            String(attempt.task_status),
            "uploading",
            "outputs_prepared",
            Number(taskRows[0].version),
            timestamp,
          );
        }
      }
      const prepared = await transaction`SELECT aof.output_index, aof.file_id, f.object_key,
          aof.content_type, aof.size_bytes, aof.sha256, aof.media FROM attempt_output_files aof
        JOIN files f ON f.id=aof.file_id WHERE aof.attempt_id=${attemptId} ORDER BY aof.output_index`;
      return prepared.map((row) => this.preparedOutput(row));
    });
  }

  private preparedOutput(row: Record<string, unknown>): PreparedOutput {
    return {
      outputIndex: Number(row.output_index),
      fileId: String(row.file_id),
      objectKey: String(row.object_key),
      contentType: String(row.content_type),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      declaredMedia: row.media as MediaMetadata,
    };
  }

  async preparedOutputs(
    identity: WorkerIdentity,
    attemptId: string,
    input: CompleteOutputs,
  ): Promise<readonly PreparedOutput[]> {
    const rows = await this.sql`SELECT aof.output_index, aof.file_id, f.object_key, aof.content_type,
        aof.size_bytes, aof.sha256, a.replica_id, a.release_id, l.worker_id, l.id AS lease_id,
        l.version AS lease_version, l.status AS lease_status FROM attempt_output_files aof
      JOIN files f ON f.id=aof.file_id JOIN attempts a ON a.id=aof.attempt_id JOIN leases l ON l.attempt_id=a.id
      WHERE aof.attempt_id=${attemptId} ORDER BY aof.output_index`;
    if (rows.length === 0) throw new WorkerControlError("outputs_not_prepared", 409);
    const first = rows[0];
    if (
      !first ||
      String(first.replica_id) !== identity.replicaId ||
      String(first.release_id) !== identity.releaseId ||
      String(first.worker_id) !== identity.workerId ||
      String(first.lease_id) !== input.lease_id ||
      Number(first.lease_version) < input.lease_version ||
      !["active", "unknown"].includes(String(first.lease_status))
    ) {
      throw new WorkerControlError("lease_binding_mismatch", 409);
    }
    const submitted = new Map(input.files.map((file) => [file.file_id, file]));
    if (submitted.size !== rows.length) throw new WorkerControlError("output_set_mismatch", 422);
    for (const row of rows) {
      const file = submitted.get(String(row.file_id));
      if (!file || file.sha256 !== String(row.sha256) || file.size_bytes !== Number(row.size_bytes)) {
        throw new WorkerControlError("output_integrity_mismatch", 422);
      }
    }
    return rows.map((row) => this.preparedOutput(row));
  }

  async commitOutputs(
    identity: WorkerIdentity,
    attemptId: string,
    input: CompleteOutputs,
    validatedMedia: ReadonlyMap<string, MediaMetadata>,
  ): Promise<Readonly<{ fileIds: readonly string[]; leaseVersion: number }>> {
    const timestamp = this.now();
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`SELECT aof.file_id, aof.status, aof.media, a.task_id,
          a.replica_id, a.release_id, a.outputs_status, l.worker_id, l.id AS lease_id,
          l.version AS lease_version, l.status AS lease_status FROM attempt_output_files aof
        JOIN attempts a ON a.id=aof.attempt_id JOIN leases l ON l.attempt_id=a.id
        WHERE aof.attempt_id=${attemptId} ORDER BY aof.output_index FOR UPDATE OF aof, a, l`;
      if (rows.length === 0) throw new WorkerControlError("outputs_not_prepared", 409);
      const first = rows[0];
      if (
        !first ||
        String(first.replica_id) !== identity.replicaId ||
        String(first.release_id) !== identity.releaseId ||
        String(first.worker_id) !== identity.workerId ||
        String(first.lease_id) !== input.lease_id ||
        Number(first.lease_version) < input.lease_version ||
        !["active", "unknown"].includes(String(first.lease_status))
      ) {
        throw new WorkerControlError("lease_binding_mismatch", 409);
      }
      const fileIds = rows.map((row) => String(row.file_id));
      if (first.outputs_status === "committed") {
        return { fileIds, leaseVersion: Number(first.lease_version) };
      }
      for (const row of rows) {
        const actualMedia = validatedMedia.get(String(row.file_id));
        if (!actualMedia || canonicalHash(actualMedia) !== canonicalHash(row.media)) {
          throw new WorkerControlError("output_media_metadata_mismatch", 422);
        }
        await transaction`UPDATE attempt_output_files SET status='committed', committed_at=${timestamp.toISOString()}
          WHERE attempt_id=${attemptId} AND file_id=${String(row.file_id)} AND status='prepared'`;
        await transaction`UPDATE files SET status='available', media=${JSON.stringify(row.media)},
          updated_at=${timestamp.toISOString()}, expires_at=${new Date(timestamp.getTime() + 24 * 60 * 60 * 1000).toISOString()}
          WHERE id=${String(row.file_id)} AND status='pending_upload'`;
        await transaction`INSERT INTO task_files (id, task_id, file_id, direction, role, ordinal)
          SELECT ${this.createId("taskfile")}, ${String(row.task_id)}, aof.file_id, 'output', aof.role, aof.output_index
          FROM attempt_output_files aof WHERE aof.attempt_id=${attemptId} AND aof.file_id=${String(row.file_id)}
          AND NOT EXISTS (SELECT 1 FROM task_files tf WHERE tf.task_id=${String(row.task_id)}
            AND tf.file_id=aof.file_id AND tf.direction='output')`;
      }
      await transaction`UPDATE attempts SET outputs_status='committed', updated_at=${timestamp.toISOString()}
        WHERE id=${attemptId} AND outputs_status='prepared'`;
      return { fileIds, leaseVersion: Number(first.lease_version) };
    });
  }

  async complete(identity: WorkerIdentity, attemptId: string, input: CompleteAttempt): Promise<TerminalAttempt> {
    return this.finish(identity, attemptId, input, undefined);
  }

  async fail(identity: WorkerIdentity, attemptId: string, input: FailAttempt): Promise<TerminalAttempt> {
    return this.finish(identity, attemptId, undefined, input);
  }

  private async finish(
    identity: WorkerIdentity,
    attemptId: string,
    completed: CompleteAttempt | undefined,
    failed: FailAttempt | undefined,
  ): Promise<TerminalAttempt> {
    const input = completed ?? failed;
    if (!input) throw new Error("terminal_input_missing");
    const timestamp = this.now();
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`SELECT a.id, a.task_id, a.execution_key, a.status, a.outputs_status,
          a.output_manifest, a.replica_id, a.release_id, l.id AS lease_id, l.worker_id,
          l.version AS lease_version, l.status AS lease_status, t.status AS task_status,
          t.version AS task_version, t.project_id, p.organization_id
        FROM attempts a JOIN leases l ON l.attempt_id=a.id JOIN tasks t ON t.id=a.task_id
        LEFT JOIN projects p ON p.id=t.project_id WHERE a.id=${attemptId} FOR UPDATE OF a, l, t`;
      const current = rows[0];
      if (!current) throw new WorkerControlError("attempt_not_found", 404);
      const intendedAttemptStatus = failed?.error.code === "canceled" ? "canceled" : failed ? "failed" : "completed";
      const intendedTaskStatus = intendedAttemptStatus;
      if (["completed", "failed", "canceled"].includes(String(current.status))) {
        if (String(current.status) !== intendedAttemptStatus)
          throw new WorkerControlError("attempt_terminal_conflict", 409);
        return {
          attempt_id: attemptId,
          task_id: String(current.task_id),
          attempt_status: intendedAttemptStatus,
          task_status: intendedTaskStatus,
          lease_version: Number(current.lease_version),
        };
      }
      if (
        String(current.replica_id) !== identity.replicaId ||
        String(current.release_id) !== identity.releaseId ||
        String(current.worker_id) !== identity.workerId ||
        String(current.lease_id) !== input.lease_id ||
        Number(current.lease_version) !== input.lease_version ||
        current.lease_status !== "active" ||
        String(current.execution_key) !== input.execution_id
      ) {
        throw new WorkerControlError("lease_binding_mismatch", 409);
      }
      if (completed && current.outputs_status !== "committed") {
        throw new WorkerControlError("outputs_not_committed", 409);
      }
      const usage = completed?.usage ?? failed?.usage ?? {};
      const error = failed
        ? { code: failed.error.code, message: failed.error.message, retryable: failed.error.retryable }
        : null;
      await transaction`UPDATE attempts SET status=${intendedAttemptStatus}, usage=${JSON.stringify(usage)},
        error=${error ? JSON.stringify(error) : null}, failure_code=${failed?.error.code ?? null}, progress=${completed ? 100 : null},
        completed_at=${timestamp.toISOString()}, updated_at=${timestamp.toISOString()} WHERE id=${attemptId}`;
      const leaseRows =
        await transaction`UPDATE leases SET status=${intendedAttemptStatus === "canceled" ? "canceled" : "released"},
        version=version+1, updated_at=${timestamp.toISOString()} WHERE id=${input.lease_id}
        AND version=${input.lease_version} AND status='active' RETURNING version`;
      if (!leaseRows[0]) throw new WorkerControlError("lease_cas_conflict", 409, true);
      const outputRows = completed
        ? await transaction`SELECT file_id FROM attempt_output_files WHERE attempt_id=${attemptId}
            AND status='committed' ORDER BY output_index`
        : [];
      const output = completed
        ? { file_ids: outputRows.map((row) => String(row.file_id)), manifest: current.output_manifest }
        : null;
      const taskRows =
        await transaction`UPDATE tasks SET status=${intendedTaskStatus}, progress=${completed ? 100 : null},
          output=${output ? JSON.stringify(output) : null}, error=${error ? JSON.stringify(error) : null},
          version=version+1, updated_at=${timestamp.toISOString()}, completed_at=${timestamp.toISOString()}
        WHERE id=${String(current.task_id)} AND version=${Number(current.task_version)} RETURNING version`;
      if (!taskRows[0]) throw new WorkerControlError("task_completion_cas_conflict", 409, true);
      const taskVersion = Number(taskRows[0].version);
      await this.insertTaskEvent(
        transaction,
        String(current.task_id),
        String(current.task_status),
        intendedTaskStatus,
        failed ? failed.error.code : "worker_completed",
        taskVersion,
        timestamp,
      );
      await transaction`UPDATE admission_reservations SET status='released',
        release_reason=${failed ? "task_failed" : "task_completed"}, released_at=${timestamp.toISOString()}
        WHERE resource_type='task' AND resource_id=${String(current.task_id)} AND status='held'`;
      const gpuSeconds = Math.max(0, Math.ceil(Number(usage.gpu_seconds ?? 0)));
      if (current.organization_id && gpuSeconds > 0) {
        await transaction`INSERT INTO usage_ledger (
          id, organization_id, project_id, task_id, source_type, source_id, metric, quantity, occurred_at, created_at
        ) VALUES (
          ${this.createId("usage")}, ${String(current.organization_id)}, ${String(current.project_id)},
          ${String(current.task_id)}, 'attempt', ${attemptId}, 'gpu_seconds', ${gpuSeconds},
          ${timestamp.toISOString()}, ${timestamp.toISOString()}
        ) ON CONFLICT (source_type, source_id, metric) DO NOTHING`;
      }
      const remaining = await transaction`SELECT a.id FROM attempts a JOIN leases l ON l.attempt_id=a.id
        WHERE l.worker_id=${identity.workerId} AND a.id<>${attemptId}
          AND a.status IN ('leased', 'running', 'unknown') AND l.status IN ('active', 'unknown')
        ORDER BY a.created_at, a.id LIMIT 1`;
      const remainingAttemptId = remaining[0] ? String(remaining[0].id) : null;
      await transaction`UPDATE workers SET status=CASE
          WHEN desired_state<>'run' THEN 'draining'
          WHEN ${remainingAttemptId}::text IS NOT NULL THEN 'busy'
          ELSE 'ready' END,
        current_attempt_id=${remainingAttemptId}, updated_at=${timestamp.toISOString()} WHERE id=${identity.workerId}`;
      return {
        attempt_id: attemptId,
        task_id: String(current.task_id),
        attempt_status: intendedAttemptStatus,
        task_status: intendedTaskStatus,
        lease_version: Number(leaseRows[0].version),
      };
    });
  }

  async drained(
    identity: WorkerIdentity,
    input: DrainedWorker,
    requestHash: string,
    reclaimTokenHash: string,
  ): Promise<void> {
    const timestamp = this.now();
    await this.sql.begin(async (transaction) => {
      const receipts = await transaction`SELECT request_hash FROM worker_request_receipts
        WHERE worker_id=${identity.workerId} AND operation='drained' AND sequence=${input.sequence}`;
      if (receipts[0]) {
        if (String(receipts[0].request_hash) !== requestHash)
          throw new WorkerControlError("worker_sequence_conflict", 409);
        return;
      }
      const workers = await transaction`SELECT id, release_id, desired_state FROM workers
        WHERE id=${identity.workerId} FOR UPDATE`;
      const worker = workers[0];
      if (!worker || String(worker.release_id) !== input.release_id)
        throw new WorkerControlError("worker_identity_mismatch", 403);
      if (!["drain", "shutdown"].includes(String(worker.desired_state))) {
        throw new WorkerControlError("worker_not_draining", 409);
      }
      const active = await transaction`SELECT 1 FROM attempts a JOIN leases l ON l.attempt_id=a.id
        WHERE a.replica_id=${identity.replicaId} AND a.status=ANY(${transaction.array([...activeStatuses])}::text[])
          AND l.status IN ('reserved', 'active', 'unknown') LIMIT 1`;
      if (active[0]) throw new WorkerControlError("worker_not_drained", 409);
      await transaction`UPDATE workers SET status='drained', drained_at=${timestamp.toISOString()},
        reclaim_token_hash=${reclaimTokenHash}, last_sequence=GREATEST(last_sequence, ${input.sequence}),
        updated_at=${timestamp.toISOString()} WHERE id=${identity.workerId}`;
      await transaction`UPDATE replicas SET observed_state='drained', last_observed_at=${timestamp.toISOString()},
        version=version+1, updated_at=${timestamp.toISOString()} WHERE id=${identity.replicaId}`;
      await transaction`INSERT INTO worker_request_receipts (
        worker_id, operation, sequence, request_hash, response_status, response_body, created_at
      ) VALUES (
        ${identity.workerId}, 'drained', ${input.sequence}, ${requestHash}, 200,
        ${JSON.stringify({ accepted: true })}, ${timestamp.toISOString()}
      )`;
    });
  }

  async reconcileLiveness(
    heartbeatTimeoutSeconds: number,
    orphanGraceSeconds: number,
    limit: number,
  ): Promise<Readonly<{ unknown: number; orphaned: number }>> {
    const timestamp = this.now();
    const staleBefore = new Date(timestamp.getTime() - heartbeatTimeoutSeconds * 1000);
    const orphanBefore = new Date(timestamp.getTime() - orphanGraceSeconds * 1000);
    const unknownRows = await this.sql.begin(async (transaction) => {
      const rows = await transaction`SELECT id, replica_id FROM workers
        WHERE status IN ('ready', 'busy', 'draining') AND last_heartbeat_at<${staleBefore.toISOString()}
        ORDER BY last_heartbeat_at, id LIMIT ${Math.min(Math.max(limit, 1), 500)} FOR UPDATE SKIP LOCKED`;
      for (const row of rows) {
        await transaction`UPDATE workers SET status='unknown', unknown_since=${timestamp.toISOString()},
          updated_at=${timestamp.toISOString()} WHERE id=${String(row.id)}`;
        await transaction`UPDATE replicas SET observed_state='unknown', version=version+1,
          updated_at=${timestamp.toISOString()} WHERE id=${String(row.replica_id)} AND observed_state<>'terminated'`;
        await transaction`UPDATE leases SET status='unknown', updated_at=${timestamp.toISOString()}
          WHERE worker_id=${String(row.id)} AND status='active'`;
        await transaction`UPDATE attempts SET status='unknown', updated_at=${timestamp.toISOString()}
          WHERE id IN (SELECT attempt_id FROM leases WHERE worker_id=${String(row.id)} AND status='unknown')
            AND status IN ('leased', 'running')`;
      }
      return rows.length;
    });
    const orphanRows = await this.sql.begin(async (transaction) => {
      const workers = await transaction`SELECT id, replica_id FROM workers WHERE status='unknown'
        AND unknown_since<=${orphanBefore.toISOString()} ORDER BY unknown_since, id
        LIMIT ${Math.min(Math.max(limit, 1), 500)} FOR UPDATE SKIP LOCKED`;
      let orphaned = 0;
      for (const worker of workers) {
        const attempts = await transaction`SELECT a.id, a.task_id, t.status AS task_status, t.version AS task_version
          FROM attempts a JOIN leases l ON l.attempt_id=a.id JOIN tasks t ON t.id=a.task_id
          WHERE l.worker_id=${String(worker.id)} AND a.status='unknown' AND l.status='unknown'
          FOR UPDATE OF a, l, t`;
        for (const attempt of attempts) {
          await transaction`UPDATE leases SET status='expired', version=version+1,
            updated_at=${timestamp.toISOString()} WHERE attempt_id=${String(attempt.id)} AND status='unknown'`;
          await transaction`UPDATE attempts SET status='abandoned', failure_code='worker_lost',
            completed_at=${timestamp.toISOString()}, updated_at=${timestamp.toISOString()}
            WHERE id=${String(attempt.id)} AND status='unknown'`;
          if (["provisioning", "running", "post_processing", "uploading"].includes(String(attempt.task_status))) {
            const taskRows = await transaction`UPDATE tasks SET status='queued', progress=NULL, version=version+1,
              updated_at=${timestamp.toISOString()} WHERE id=${String(attempt.task_id)}
              AND version=${Number(attempt.task_version)} RETURNING version`;
            if (taskRows[0]) {
              await this.insertTaskEvent(
                transaction,
                String(attempt.task_id),
                String(attempt.task_status),
                "queued",
                "worker_lost",
                Number(taskRows[0].version),
                timestamp,
              );
            }
          }
          orphaned += 1;
        }
        await transaction`UPDATE workers SET status='offline', updated_at=${timestamp.toISOString()}
          WHERE id=${String(worker.id)}`;
        await transaction`UPDATE replicas SET observed_state='failed', version=version+1,
          updated_at=${timestamp.toISOString()} WHERE id=${String(worker.replica_id)} AND observed_state='unknown'`;
      }
      return orphaned;
    });
    return { unknown: unknownRows, orphaned: orphanRows };
  }

  private async insertTaskEvent(
    transaction: postgres.TransactionSql,
    taskId: string,
    fromStatus: string,
    toStatus: string,
    reason: string,
    version: number,
    timestamp: Date,
  ): Promise<void> {
    await transaction`INSERT INTO task_state_events (
      id, task_id, from_status, to_status, reason, version, created_at
    ) VALUES (
      ${this.createId("evt")}, ${taskId}, ${fromStatus}, ${toStatus}, ${reason}, ${version}, ${timestamp.toISOString()}
    )`;
    await transaction`INSERT INTO outbox_events (
      id, aggregate_type, aggregate_id, aggregate_version, event_type, trace_id, payload, created_at
    ) VALUES (
      ${this.createId("evt")}, 'generation_task', ${taskId}, ${version}, ${`task.${toStatus}`},
      ${this.createId("trace")}, ${JSON.stringify({ task_id: taskId, reason })}, ${timestamp.toISOString()}
    )`;
  }
}
