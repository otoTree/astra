import {
  ProviderError,
  type ProviderAdapter,
  type ProviderBatchJob,
  type ProviderImageWarmup,
  type ProviderOperationContext,
  type ProviderReplica,
  type ProviderResourceSnapshot,
  type ProviderUploadReservation,
  type ProviderUsage,
} from "@astra/provider-core";

export class ManualClock {
  constructor(private current = new Date("2026-01-01T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export type DeterministicProviderFailure = "none" | "inventory_exhausted" | "rate_limited" | "timeout";

export class DeterministicProviderAdapter implements ProviderAdapter {
  readonly replicas = new Map<string, ProviderReplica>();
  readonly jobs = new Map<string, ProviderBatchJob>();
  readonly warmups = new Map<string, ProviderImageWarmup>();
  private readonly operationResults = new Map<
    string,
    | { kind: "replica"; fingerprint: string; value: ProviderReplica }
    | { kind: "batch_job"; fingerprint: string; value: ProviderBatchJob }
    | { kind: "warmup"; fingerprint: string; value: ProviderImageWarmup }
  >();
  private failure: DeterministicProviderFailure = "none";

  constructor(private readonly clock: ManualClock = new ManualClock()) {}

  setFailure(failure: DeterministicProviderFailure): void {
    this.failure = failure;
  }

  private ensureAvailable(context: ProviderOperationContext): void {
    if (this.clock.now() >= context.deadlineAt) throw new ProviderError("operation_timeout", true);
    if (this.failure === "inventory_exhausted") throw new ProviderError("inventory_exhausted", true, 30);
    if (this.failure === "rate_limited") throw new ProviderError("rate_limited", true, 10);
    if (this.failure === "timeout") throw new ProviderError("operation_timeout", true);
  }

  async getResourceSnapshot(context: ProviderOperationContext): Promise<ProviderResourceSnapshot> {
    this.ensureAvailable(context);
    return {
      provider: "reference",
      version: "snapshot-1",
      observedAt: this.clock.now(),
      regions: [{ id: "reference-region", healthy: true, allowed: true }],
      offers: [
        {
          region: "reference-region",
          gpuSku: "reference-gpu",
          gpuMemoryBytes: 32 * 1024 * 1024 * 1024,
          availableReplicas: 100,
          pricePerGpuHourMinor: 300,
          currency: "CNY",
          observedAt: this.clock.now(),
        },
      ],
    };
  }

  async prewarmImage(
    input: Readonly<{ imageDigest: string; region: string; gpuSku: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderImageWarmup> {
    this.ensureAvailable(context);
    const fingerprint = JSON.stringify(input);
    const existing = this.operationResults.get(context.operationId);
    if (existing) {
      if (existing.kind !== "warmup" || existing.fingerprint !== fingerprint) {
        throw new ProviderError("operation_conflict", false);
      }
      return existing.value;
    }
    const warmup: ProviderImageWarmup = {
      id: `warmup_${this.warmups.size + 1}`,
      imageDigest: input.imageDigest,
      region: input.region,
      gpuSku: input.gpuSku,
      state: "ready",
    };
    this.warmups.set(warmup.id, warmup);
    this.operationResults.set(context.operationId, { kind: "warmup", fingerprint, value: warmup });
    return warmup;
  }

  async provisionReplica(
    input: Readonly<{ imageDigest: string; region: string; gpuSku: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderReplica> {
    this.ensureAvailable(context);
    const fingerprint = JSON.stringify(input);
    const existing = this.operationResults.get(context.operationId);
    if (existing) {
      if (existing.kind !== "replica" || existing.fingerprint !== fingerprint) {
        throw new ProviderError("operation_conflict", false);
      }
      return existing.value;
    }
    const replica: ProviderReplica = {
      id: `replica_${this.replicas.size + 1}`,
      provider: "reference",
      region: input.region,
      gpuSku: input.gpuSku,
      imageDigest: input.imageDigest,
      state: "ready",
    };
    this.replicas.set(replica.id, replica);
    this.operationResults.set(context.operationId, { kind: "replica", fingerprint, value: replica });
    return replica;
  }

  async drainReplica(replicaId: string, context: ProviderOperationContext): Promise<void> {
    this.ensureAvailable(context);
    const replica = this.replicas.get(replicaId);
    if (!replica) throw new ProviderError("resource_not_found", false);
    this.replicas.set(replicaId, { ...replica, state: "draining" });
  }

  async terminateReplica(replicaId: string, context: ProviderOperationContext): Promise<void> {
    this.ensureAvailable(context);
    const replica = this.replicas.get(replicaId);
    if (!replica) return;
    this.replicas.set(replicaId, { ...replica, state: "terminated" });
  }

  async getReplica(replicaId: string, context: ProviderOperationContext): Promise<ProviderReplica> {
    this.ensureAvailable(context);
    const replica = this.replicas.get(replicaId);
    if (!replica) throw new ProviderError("resource_not_found", false);
    return replica;
  }

  async submitBatchJob(
    input: Readonly<{ imageDigest: string; region: string; gpuSku: string; executionKey: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderBatchJob> {
    this.ensureAvailable(context);
    const fingerprint = JSON.stringify(input);
    const existing = this.operationResults.get(context.operationId);
    if (existing) {
      if (existing.kind !== "batch_job" || existing.fingerprint !== fingerprint) {
        throw new ProviderError("operation_conflict", false);
      }
      return existing.value;
    }
    const job: ProviderBatchJob = {
      id: `job_${this.jobs.size + 1}`,
      provider: "reference",
      region: input.region,
      gpuSku: input.gpuSku,
      imageDigest: input.imageDigest,
      state: "queued",
    };
    this.jobs.set(job.id, job);
    this.operationResults.set(context.operationId, { kind: "batch_job", fingerprint, value: job });
    return job;
  }

  async getBatchJob(jobId: string, context: ProviderOperationContext): Promise<ProviderBatchJob> {
    this.ensureAvailable(context);
    const job = this.jobs.get(jobId);
    if (!job) throw new ProviderError("resource_not_found", false);
    return job;
  }

  async cancelBatchJob(jobId: string, context: ProviderOperationContext): Promise<void> {
    this.ensureAvailable(context);
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.set(jobId, { ...job, state: "canceled" });
  }

  async createUploadReservation(
    input: Readonly<{ objectKey: string; contentType: string; sizeBytes: number; sha256: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderUploadReservation> {
    this.ensureAvailable(context);
    return {
      id: `upload_${context.operationId}`,
      method: "PUT",
      url: `https://reference.invalid/${encodeURIComponent(input.objectKey)}`,
      headers: { "content-type": input.contentType, "content-length": String(input.sizeBytes) },
      expiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000),
    };
  }

  async getUsage(resourceId: string, context: ProviderOperationContext): Promise<ProviderUsage> {
    this.ensureAvailable(context);
    return {
      resourceId,
      gpuSeconds: 0,
      amountMinor: 0,
      currency: "CNY",
      periodStart: this.clock.now(),
      periodEnd: this.clock.now(),
    };
  }
}
