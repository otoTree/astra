import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import type {
  Capabilities,
  CompleteAttempt,
  CompleteOutputs,
  CompleteOutputsResponse,
  DrainedWorker,
  FailAttempt,
  InferenceRequest,
  LeasedAttempt,
  ModelExecutionView,
  ModelSmokeRequest,
  ModelSmokeResponse,
  OutputManifest,
  PrepareOutputs,
  PrepareOutputsResponse,
  WorkerHeartbeat,
  WorkerHeartbeatResponse,
  WorkerLeaseRequest,
  WorkerRegistration,
  WorkerRegistrationResponse,
  RolloutValidationReport,
} from "@astra/contracts";
import type { LogContext } from "@astra/observability";
import { downloadInputs, FileTransferError, uploadOutput, verifyOutputs } from "./file-transfer.ts";
import type { WorkerAgentState } from "./state-store.ts";
import { WorkerControlClientError } from "./worker-control-client.ts";

type Logger = Readonly<{
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}>;

export interface WorkerControlPort {
  register(input: WorkerRegistration, bootstrapToken: string): Promise<WorkerRegistrationResponse>;
  lease(
    session: Readonly<{ workerId: string; token: string }>,
    input: WorkerLeaseRequest,
  ): Promise<LeasedAttempt | undefined>;
  heartbeat(
    session: Readonly<{ workerId: string; token: string }>,
    input: WorkerHeartbeat,
  ): Promise<WorkerHeartbeatResponse>;
  prepareOutputs(
    session: Readonly<{ workerId: string; token: string }>,
    attemptId: string,
    input: PrepareOutputs,
  ): Promise<PrepareOutputsResponse>;
  completeOutputs(
    session: Readonly<{ workerId: string; token: string }>,
    attemptId: string,
    input: CompleteOutputs,
  ): Promise<CompleteOutputsResponse>;
  complete(
    session: Readonly<{ workerId: string; token: string }>,
    attemptId: string,
    input: CompleteAttempt,
  ): Promise<unknown>;
  fail(session: Readonly<{ workerId: string; token: string }>, attemptId: string, input: FailAttempt): Promise<unknown>;
  drained(session: Readonly<{ workerId: string; token: string }>, input: DrainedWorker): Promise<unknown>;
  reportRolloutValidation(
    session: Readonly<{ workerId: string; token: string }>,
    input: RolloutValidationReport,
  ): Promise<unknown>;
}

export interface ModelAppPort {
  live(): Promise<boolean>;
  ready(): Promise<boolean>;
  capabilities(): Promise<Capabilities>;
  accept(request: InferenceRequest): Promise<ModelExecutionView>;
  status(executionId: string): Promise<ModelExecutionView>;
  cancel(executionId: string, reason?: string): Promise<ModelExecutionView>;
  smoke(input: ModelSmokeRequest): Promise<ModelSmokeResponse>;
}

export interface WorkerStatePort {
  load(): Promise<WorkerAgentState | undefined>;
  save(state: WorkerAgentState): Promise<void>;
}

export type WorkerAgentOptions = Readonly<{
  bootstrapToken: string;
  provider: string;
  region: string;
  providerInstanceId: string;
  replicaId: string;
  poolId: string;
  releaseId: string;
  imageDigest?: string;
  instanceFingerprint: string;
  gpuSku: string;
  gpuCount: number;
  gpuMemoryBytes: number;
  workRoot: string;
  idlePollMilliseconds: number;
}>;

type ActiveExecution = {
  lease: LeasedAttempt;
  status: ModelExecutionView["status"];
  progress: number | null;
  cancelSent: boolean;
};

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
const hash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
const terminal = (status: ModelExecutionView["status"]): boolean =>
  status === "completed" || status === "failed" || status === "canceled";
const progressOf = (view: ModelExecutionView): number | null =>
  "progress" in view && view.progress !== undefined ? view.progress : view.status === "completed" ? 100 : null;

export class WorkerAgent {
  private state?: WorkerAgentState;
  private capabilities?: Capabilities;
  private heartbeatIntervalMilliseconds = 10_000;
  private desiredState: "run" | "cancel" | "drain" | "shutdown" = "run";
  private readonly active = new Map<string, ActiveExecution>();
  private stopped = false;

  constructor(
    private readonly control: WorkerControlPort,
    private readonly model: ModelAppPort,
    private readonly stateStore: WorkerStatePort,
    private readonly options: WorkerAgentOptions,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    if (!(await this.model.live())) throw new Error("model_app_not_live");
    if (!(await this.model.ready())) throw new Error("model_app_not_ready");
    const capabilities = await this.model.capabilities();
    if (capabilities.model_release !== this.options.releaseId) throw new Error("model_app_release_mismatch");
    this.capabilities = capabilities;
    const stored = await this.stateStore.load();
    if (stored && stored.token_expires_at > Math.floor(Date.now() / 1000)) {
      this.state = stored;
      this.logger.info("worker_session_restored", { worker_id: stored.worker_id });
      return;
    }
    const registration = await this.control.register(
      {
        provider: this.options.provider,
        region: this.options.region,
        provider_instance_id: this.options.providerInstanceId,
        replica_id: this.options.replicaId,
        pool_id: this.options.poolId,
        release_id: this.options.releaseId,
        ...(this.options.imageDigest ? { image_digest: this.options.imageDigest } : {}),
        instance_fingerprint: this.options.instanceFingerprint,
        hardware: {
          gpu_sku: this.options.gpuSku,
          gpu_count: this.options.gpuCount,
          gpu_memory_bytes: this.options.gpuMemoryBytes,
        },
        capabilities,
      },
      this.options.bootstrapToken,
    );
    this.heartbeatIntervalMilliseconds = registration.heartbeat_interval_seconds * 1000;
    this.state = {
      worker_id: registration.worker_id,
      token: registration.worker_token,
      token_expires_at: registration.token_expires_at,
      sequence: 0,
    };
    await this.stateStore.save(this.state);
    this.logger.info("worker_registered", { worker_id: registration.worker_id, replica_id: this.options.replicaId });
    if (registration.rollout_validation_required) {
      await this.reportRolloutValidation(registration);
    }
  }

  private async reportRolloutValidation(registration: WorkerRegistrationResponse): Promise<void> {
    if (!this.capabilities) throw new Error("worker_capabilities_missing");
    const imageDigest = this.options.imageDigest;
    if (!imageDigest || imageDigest !== registration.expected_image_digest) {
      throw new Error("worker_rollout_image_digest_mismatch");
    }
    const validationId = `validation_${this.options.replicaId}`;
    const smoke = await this.model.smoke({ validation_id: validationId, model_release: this.options.releaseId });
    const sequence = await this.nextSequence();
    await this.control.reportRolloutValidation(this.session(), {
      sequence,
      observed_at: new Date().toISOString(),
      image_digest: imageDigest,
      status: smoke.status,
      capabilities_hash: hash(this.capabilities),
      smoke,
      resources: { gpu_memory_peak_bytes: 0, system_memory_peak_bytes: 0 },
      ...(smoke.failure_code ? { failure_code: smoke.failure_code } : {}),
    });
    this.logger.info("worker_rollout_validation_reported", {
      worker_id: registration.worker_id,
      replica_id: this.options.replicaId,
      status: smoke.status,
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.state || !this.capabilities) throw new Error("worker_agent_not_initialized");
    let nextHeartbeatAt = 0;
    while (!signal.aborted && !this.stopped) {
      try {
        const now = Date.now();
        if (now >= nextHeartbeatAt) {
          await this.heartbeatWithRetry();
          nextHeartbeatAt = Date.now() + this.heartbeatIntervalMilliseconds;
        }
        if (this.desiredState === "cancel") {
          await Promise.all([...this.active.values()].map((execution) => this.cancel(execution, "worker_cancel")));
        }
        if (this.desiredState === "run") await this.fillAvailableSlots();
        if ((this.desiredState === "drain" || this.desiredState === "shutdown") && this.active.size === 0) {
          await this.reportDrained();
          this.stopped = true;
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : "worker_iteration_failed";
        const retryable = error instanceof WorkerControlClientError ? error.retryable : false;
        this.logger.warn("worker_iteration_failed", { error_code: code, retryable });
      }
      await Bun.sleep(Math.min(this.options.idlePollMilliseconds, Math.max(100, nextHeartbeatAt - Date.now())));
    }
    await Promise.allSettled([...this.active.values()].map((execution) => this.cancel(execution, "agent_shutdown")));
  }

  private session(): Readonly<{ workerId: string; token: string }> {
    if (!this.state) throw new Error("worker_session_missing");
    return { workerId: this.state.worker_id, token: this.state.token };
  }

  private async nextSequence(): Promise<number> {
    if (!this.state) throw new Error("worker_session_missing");
    this.state = { ...this.state, sequence: this.state.sequence + 1 };
    await this.stateStore.save(this.state);
    return this.state.sequence;
  }

  private async heartbeatWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.heartbeat();
        return;
      } catch (error) {
        const retryable = error instanceof WorkerControlClientError && error.retryable;
        if (!retryable || attempt === 2) throw error;
        await Bun.sleep(250 * 2 ** attempt);
      }
    }
  }

  private async heartbeat(): Promise<void> {
    if (!this.state) throw new Error("worker_session_missing");
    const disk = await statfs(this.options.workRoot);
    const sequence = await this.nextSequence();
    const response = await this.control.heartbeat(this.session(), {
      sequence,
      observed_at: new Date().toISOString(),
      running_slots: this.active.size,
      reserved_slots: 0,
      executions: [...this.active.values()].map((execution) => ({
        attempt_id: execution.lease.attempt_id,
        lease_id: execution.lease.lease_id,
        lease_version: execution.lease.lease_version,
        status: execution.status,
        progress: execution.progress,
      })),
      health: {
        model_app_ready: await this.model.ready(),
        disk_available_bytes: disk.bavail * disk.bsize,
        gpu_memory_used_bytes: 0,
      },
    });
    this.desiredState = response.desired_state;
    for (const renewed of response.leases) {
      const execution = this.active.get(renewed.attempt_id);
      if (!execution) continue;
      execution.lease = {
        ...execution.lease,
        lease_version: renewed.lease_version,
        lease_expires_at: renewed.lease_expires_at,
      };
      if (renewed.cancel_requested) await this.cancel(execution, "task_canceled");
    }
    if (response.worker_token && response.token_expires_at) {
      this.state = { ...this.state, token: response.worker_token, token_expires_at: response.token_expires_at };
      await this.stateStore.save(this.state);
      this.logger.info("worker_session_rotated", { worker_id: this.state.worker_id });
    }
  }

  private async fillAvailableSlots(): Promise<void> {
    if (!this.capabilities) throw new Error("worker_capabilities_missing");
    const available = this.capabilities.max_concurrency - this.active.size;
    if (available <= 0) return;
    const sequence = await this.nextSequence();
    const lease = await this.control.lease(this.session(), {
      sequence,
      max_concurrency: this.capabilities.max_concurrency,
      running_slots: this.active.size,
      reserved_slots: 0,
      available_slots: available,
      capabilities_hash: hash(this.capabilities),
    });
    if (!lease) return;
    const execution: ActiveExecution = { lease, status: "accepted", progress: 0, cancelSent: false };
    this.active.set(lease.attempt_id, execution);
    this.logger.info("worker_attempt_leased", { attempt_id: lease.attempt_id, task_id: lease.inference.task_id });
    void this.execute(execution)
      .catch((error: unknown) => this.handleExecutionFailure(execution, error))
      .finally(() => this.active.delete(lease.attempt_id));
  }

  private async execute(execution: ActiveExecution): Promise<void> {
    await this.retryExternal(() => downloadInputs(execution.lease, this.options.workRoot));
    let view = await this.model.accept(execution.lease.inference);
    while (!terminal(view.status)) {
      execution.status = view.status;
      execution.progress = progressOf(view);
      if (execution.cancelSent && view.status !== "canceling") await this.cancel(execution, "task_canceled");
      await Bun.sleep(Math.min(1000, this.options.idlePollMilliseconds));
      view = await this.model.status(execution.lease.execution_key);
    }
    execution.status = view.status;
    execution.progress = progressOf(view);
    if (view.status === "completed") {
      await this.publishOutputs(execution, view as OutputManifest);
      return;
    }
    const code = view.status === "canceled" ? "canceled" : "model_execution_failed";
    const message = "error" in view && view.error ? view.error.message.slice(0, 1000) : code;
    await this.reportFailure(execution, code, message, "error" in view && view.error ? view.error.retryable : false);
  }

  private async publishOutputs(execution: ActiveExecution, manifest: OutputManifest): Promise<void> {
    const verified = await verifyOutputs(manifest, execution.lease.inference.output_dir);
    const prepared = await this.retryExternal(() =>
      this.control.prepareOutputs(this.session(), execution.lease.attempt_id, {
        lease_id: execution.lease.lease_id,
        lease_version: execution.lease.lease_version,
        manifest,
      }),
    );
    for (const upload of prepared.uploads) {
      const output = verified.find((item) => item.index === upload.output_index);
      if (!output) throw new Error("output_upload_set_mismatch");
      await this.retryExternal(() => uploadOutput(output.path, upload));
    }
    const committed = await this.retryExternal(() =>
      this.control.completeOutputs(this.session(), execution.lease.attempt_id, {
        lease_id: execution.lease.lease_id,
        lease_version: execution.lease.lease_version,
        files: prepared.uploads.map((upload) => {
          const output = verified.find((item) => item.index === upload.output_index);
          if (!output) throw new Error("output_upload_set_mismatch");
          return { file_id: upload.file_id, sha256: output.sha256, size_bytes: output.sizeBytes };
        }),
      }),
    );
    execution.lease = { ...execution.lease, lease_version: committed.lease_version };
    await this.terminalWithLeaseRetry(async () => {
      await this.control.complete(this.session(), execution.lease.attempt_id, {
        lease_id: execution.lease.lease_id,
        lease_version: execution.lease.lease_version,
        execution_id: execution.lease.execution_key,
        completed_at: new Date().toISOString(),
        usage: manifest.usage,
      });
    });
    this.logger.info("worker_attempt_completed", { attempt_id: execution.lease.attempt_id });
  }

  private async handleExecutionFailure(execution: ActiveExecution, error: unknown): Promise<void> {
    const code =
      error instanceof WorkerControlClientError ? error.code : error instanceof Error ? error.message : "agent_failed";
    this.logger.error("worker_attempt_failed", { attempt_id: execution.lease.attempt_id, error_code: code });
    try {
      await this.reportFailure(execution, code.slice(0, 128), "Worker execution failed", false);
    } catch (reportError) {
      this.logger.error("worker_attempt_failure_report_failed", {
        attempt_id: execution.lease.attempt_id,
        error_code: reportError instanceof Error ? reportError.message : "failure_report_failed",
      });
    }
  }

  private async reportFailure(
    execution: ActiveExecution,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    await this.terminalWithLeaseRetry(async () => {
      await this.control.fail(this.session(), execution.lease.attempt_id, {
        lease_id: execution.lease.lease_id,
        lease_version: execution.lease.lease_version,
        execution_id: execution.lease.execution_key,
        failed_at: new Date().toISOString(),
        error: { code, message: message.slice(0, 1000), retryable, stage: execution.status },
        usage: {},
      });
    });
  }

  private async terminalWithLeaseRetry(operation: () => Promise<void>): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await operation();
        return;
      } catch (error) {
        if (
          !(error instanceof WorkerControlClientError) ||
          (!error.retryable && !["lease_binding_mismatch", "stale_lease_version"].includes(error.code)) ||
          attempt === 2
        ) {
          throw error;
        }
        await Bun.sleep(250 * 2 ** attempt);
      }
    }
  }

  private async retryExternal<Value>(operation: () => Promise<Value>): Promise<Value> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof WorkerControlClientError
            ? error.retryable
            : error instanceof FileTransferError
              ? error.retryable
              : error instanceof TypeError || error instanceof DOMException;
        if (!retryable || attempt === 2) throw error;
        await Bun.sleep(250 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private async cancel(execution: ActiveExecution, reason: string): Promise<void> {
    if (execution.cancelSent) return;
    execution.cancelSent = true;
    const view = await this.model.cancel(execution.lease.execution_key, reason);
    execution.status = view.status;
    execution.progress = progressOf(view);
  }

  private async reportDrained(): Promise<void> {
    if (!this.capabilities || !this.state) return;
    const sequence = await this.nextSequence();
    await this.control.drained(this.session(), {
      sequence,
      release_id: this.options.releaseId,
      running_slots: 0,
      reserved_slots: 0,
      active_attempt_ids: [],
      drain_reason: this.desiredState,
      observed_at: new Date().toISOString(),
    });
    this.logger.info("worker_drained", { worker_id: this.state.worker_id, desired_state: this.desiredState });
  }
}
