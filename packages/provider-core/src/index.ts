export type ProviderOperationContext = Readonly<{
  operationId: string;
  requestId: string;
  deadlineAt: Date;
}>;

export type ProviderErrorCode =
  | "authentication_failed"
  | "rate_limited"
  | "inventory_exhausted"
  | "region_unavailable"
  | "operation_timeout"
  | "resource_not_found"
  | "provider_unavailable"
  | "operation_conflict"
  | "invalid_provider_response";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "ProviderError";
  }
}

export type ProviderRegion = Readonly<{
  id: string;
  healthy: boolean;
  allowed: boolean;
}>;

export type ProviderCapacityOffer = Readonly<{
  region: string;
  gpuSku: string;
  gpuMemoryBytes: number;
  availableReplicas: number;
  pricePerGpuHourMinor: number;
  currency: string;
  observedAt: Date;
}>;

export type ProviderResourceSnapshot = Readonly<{
  provider: string;
  version: string;
  observedAt: Date;
  regions: readonly ProviderRegion[];
  offers: readonly ProviderCapacityOffer[];
}>;

export type ProviderObservationKind =
  | "resource"
  | "deployment"
  | "node"
  | "batch_job"
  | "image_prewarm_region"
  | "image_prewarm"
  | "billing";

export type ProviderObservedObject = Readonly<{
  kind: ProviderObservationKind;
  providerId: string;
  state?: string;
  region?: string;
  gpuSku?: string;
  imageReference?: string;
  observedAt: Date;
  attributes: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type ProviderObservationPage = Readonly<{
  kind: ProviderObservationKind;
  endpoint: string;
  objects: readonly ProviderObservedObject[];
  redactedPayload: unknown;
  payloadHash: string;
  quarantineReasons: readonly string[];
}>;

export type ProviderObservationBundle = Readonly<{
  provider: string;
  contractVersion: string;
  observedAt: Date;
  resources: ProviderResourceSnapshot;
  pages: readonly ProviderObservationPage[];
}>;

export interface ProviderObservationReader {
  observe(context: ProviderOperationContext): Promise<ProviderObservationBundle>;
}

export type ProviderImageWarmup = Readonly<{
  id: string;
  imageDigest: string;
  region: string;
  gpuSku: string;
  state: "requested" | "pulling" | "validating" | "ready" | "failed";
}>;

export type ProviderReplica = Readonly<{
  id: string;
  provider: string;
  region: string;
  gpuSku: string;
  imageDigest: string;
  state: "provisioning" | "ready" | "draining" | "unknown" | "terminated";
}>;

export type ProviderBatchJob = Readonly<{
  id: string;
  provider: string;
  region: string;
  gpuSku: string;
  imageDigest: string;
  state: "queued" | "provisioning" | "running" | "succeeded" | "failed" | "canceling" | "canceled";
}>;

export type ProviderUploadReservation = Readonly<{
  id: string;
  method: "PUT";
  url: string;
  headers: Readonly<Record<string, string>>;
  expiresAt: Date;
}>;

export type ProviderUsage = Readonly<{
  resourceId: string;
  gpuSeconds: number;
  amountMinor: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
}>;

export interface ProviderAdapter {
  getResourceSnapshot(context: ProviderOperationContext): Promise<ProviderResourceSnapshot>;
  prewarmImage(
    input: Readonly<{ imageDigest: string; region: string; gpuSku: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderImageWarmup>;
  provisionReplica(
    input: Readonly<{ imageDigest: string; region: string; gpuSku: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderReplica>;
  drainReplica(replicaId: string, context: ProviderOperationContext): Promise<void>;
  terminateReplica(replicaId: string, context: ProviderOperationContext): Promise<void>;
  getReplica(replicaId: string, context: ProviderOperationContext): Promise<ProviderReplica>;
  submitBatchJob(
    input: Readonly<{ imageDigest: string; region: string; gpuSku: string; executionKey: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderBatchJob>;
  getBatchJob(jobId: string, context: ProviderOperationContext): Promise<ProviderBatchJob>;
  cancelBatchJob(jobId: string, context: ProviderOperationContext): Promise<void>;
  createUploadReservation(
    input: Readonly<{ objectKey: string; contentType: string; sizeBytes: number; sha256: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderUploadReservation>;
  getUsage(resourceId: string, context: ProviderOperationContext): Promise<ProviderUsage>;
}
