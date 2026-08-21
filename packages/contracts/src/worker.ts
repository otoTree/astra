import { z } from "zod";
import { mediaMetadataSchema } from "./media.ts";

export const workerContractVersion = "1.0" as const;
export const workerDesiredStateSchema = z.enum(["run", "cancel", "drain", "shutdown"]);

export const capabilitiesSchema = z
  .object({
    contract_version: z.string(),
    app: z.object({ name: z.string(), version: z.string(), build: z.string() }),
    model_release: z.string(),
    modalities: z.array(z.enum(["image", "video"])),
    operations: z.array(z.string()),
    max_concurrency: z.number().int().positive(),
    capabilities: z.object({
      aspect_ratios: z.array(z.string()),
      resolutions: z.array(z.string()),
      resolution_matrix: z.record(
        z.string(),
        z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
      ),
      durations: z.array(z.number()),
      fps: z.array(z.number()),
      input_types: z.array(z.enum(["image", "video", "audio"])),
      input_roles: z.array(z.string()),
      audio_modes: z.array(z.string()),
      supports_cancel: z.boolean(),
      supports_progress: z.boolean(),
      supports_resume: z.boolean(),
    }),
    artifacts: z.object({
      output_artifacts: z.array(
        z.object({
          role: z.string(),
          content_types: z.array(z.string()),
        }),
      ),
      max_outputs: z.number().int().positive(),
      sidecar_manifest_allowed: z.boolean(),
      post_processing: z.literal("model_app_only"),
    }),
  })
  .strict();
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const executionInputSchema = z
  .object({
    file_id: z.string(),
    type: z.enum(["image", "video", "audio"]),
    role: z.string(),
    path: z.string().regex(/^\/work\/tasks\/[a-zA-Z0-9._-]+\/inputs\/[a-zA-Z0-9._-]+$/),
    content_type: z.string(),
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const inferenceRequestSchema = z
  .object({
    execution_id: z.string().min(1),
    task_id: z.string().min(1),
    type: z.enum(["video", "image"]),
    operation: z.enum(["generation", "edit"]),
    model_release: z.string().min(1),
    request: z.record(z.string(), z.unknown()),
    inputs: z.array(executionInputSchema).max(16),
    output_dir: z.string().regex(/^\/work\/tasks\/[a-zA-Z0-9._-]+\/outputs$/),
    deadline_at: z.number().int().positive(),
  })
  .strict();
export type InferenceRequest = z.infer<typeof inferenceRequestSchema>;

export const executionStatusSchema = z.enum([
  "accepted",
  "running",
  "post_processing",
  "completed",
  "failed",
  "canceling",
  "canceled",
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const outputManifestSchema = z
  .object({
    execution_id: z.string().min(1),
    status: z.literal("completed"),
    outputs: z
      .array(
        z
          .object({
            role: z.string().min(1),
            path: z.string().min(1),
            content_type: z.enum(["image/png", "image/jpeg", "image/webp", "video/mp4", "video/quicktime"]),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            size_bytes: z.number().int().positive(),
            media: mediaMetadataSchema,
            provenance: z.object({ producer: z.literal("model_app"), transformations: z.array(z.string()) }).strict(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    usage: z.record(z.string(), z.number().nonnegative()),
  })
  .strict();
export type OutputManifest = z.infer<typeof outputManifestSchema>;

export const executionViewSchema = z
  .object({
    execution_id: z.string(),
    status: executionStatusSchema,
    stage: z.string().optional(),
    progress: z.number().min(0).max(100).nullable().optional(),
    message: z.string().optional(),
    metrics: z.record(z.string(), z.number()).optional(),
    error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict().optional(),
  })
  .strict();
export type ExecutionView = z.infer<typeof executionViewSchema>;
export const modelExecutionViewSchema = z.union([outputManifestSchema, executionViewSchema]);
export type ModelExecutionView = z.infer<typeof modelExecutionViewSchema>;

export const workerRegistrationSchema = z
  .object({
    provider: z.string().min(1),
    region: z.string().min(1),
    provider_instance_id: z.string().min(1),
    replica_id: z.string().min(1),
    pool_id: z.string().min(1),
    release_id: z.string().min(1),
    instance_fingerprint: z.string().min(16),
    hardware: z
      .object({
        gpu_sku: z.string().min(1),
        gpu_count: z.number().int().positive(),
        gpu_memory_bytes: z.number().int().positive(),
      })
      .strict(),
    capabilities: capabilitiesSchema,
  })
  .strict();
export type WorkerRegistration = z.infer<typeof workerRegistrationSchema>;

export const workerRegistrationResponseSchema = z
  .object({
    worker_id: z.string().min(1),
    worker_token: z.string().min(1),
    token_expires_at: z.number().int().positive(),
    heartbeat_interval_seconds: z.number().int().positive(),
    lease_duration_seconds: z.number().int().positive(),
    orphan_grace_period_seconds: z.number().int().nonnegative(),
  })
  .strict();
export type WorkerRegistrationResponse = z.infer<typeof workerRegistrationResponseSchema>;

export const workerLeaseRequestSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    max_concurrency: z.number().int().positive(),
    running_slots: z.number().int().nonnegative(),
    reserved_slots: z.number().int().nonnegative(),
    available_slots: z.number().int().nonnegative(),
    capabilities_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.running_slots + request.reserved_slots + request.available_slots !== request.max_concurrency) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "reported slots must equal max_concurrency" });
    }
  });
export type WorkerLeaseRequest = z.infer<typeof workerLeaseRequestSchema>;

export const leasedAttemptSchema = z
  .object({
    attempt_id: z.string().min(1),
    lease_id: z.string().min(1),
    lease_version: z.number().int().nonnegative(),
    lease_expires_at: z.number().int().positive(),
    execution_key: z.string().min(1),
    inference: inferenceRequestSchema,
    input_downloads: z.array(
      z
        .object({
          file_id: z.string().min(1),
          url: z.string().url(),
          headers: z.record(z.string(), z.string()),
          expires_at: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();
export type LeasedAttempt = z.infer<typeof leasedAttemptSchema>;

export const workerHeartbeatSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    observed_at: z.string().datetime({ offset: true }),
    running_slots: z.number().int().nonnegative(),
    reserved_slots: z.number().int().nonnegative(),
    executions: z.array(
      z
        .object({
          attempt_id: z.string().min(1),
          lease_id: z.string().min(1),
          lease_version: z.number().int().nonnegative(),
          status: executionStatusSchema,
          progress: z.number().min(0).max(100).nullable(),
        })
        .strict(),
    ),
    health: z
      .object({
        model_app_ready: z.boolean(),
        disk_available_bytes: z.number().int().nonnegative(),
        gpu_memory_used_bytes: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const workerHeartbeatResponseSchema = z
  .object({
    accepted_sequence: z.number().int().nonnegative(),
    leases: z.array(
      z
        .object({
          attempt_id: z.string().min(1),
          lease_id: z.string().min(1),
          lease_version: z.number().int().nonnegative(),
          lease_expires_at: z.number().int().positive(),
          cancel_requested: z.boolean(),
        })
        .strict(),
    ),
    desired_state: workerDesiredStateSchema,
    worker_token: z.string().min(32).optional(),
    token_expires_at: z.number().int().positive().optional(),
  })
  .strict();
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;
export type WorkerHeartbeatResponse = z.infer<typeof workerHeartbeatResponseSchema>;

export const prepareOutputsSchema = z
  .object({
    lease_id: z.string().min(1),
    lease_version: z.number().int().nonnegative(),
    manifest: outputManifestSchema,
  })
  .strict();

export const prepareOutputsResponseSchema = z
  .object({
    attempt_id: z.string().min(1),
    lease_version: z.number().int().nonnegative(),
    uploads: z.array(
      z
        .object({
          output_index: z.number().int().nonnegative(),
          file_id: z.string().min(1),
          method: z.literal("PUT"),
          url: z.string().url(),
          headers: z.record(z.string(), z.string()),
          expires_at: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();
export type PrepareOutputs = z.infer<typeof prepareOutputsSchema>;
export type PrepareOutputsResponse = z.infer<typeof prepareOutputsResponseSchema>;

export const completeOutputsSchema = z
  .object({
    lease_id: z.string().min(1),
    lease_version: z.number().int().nonnegative(),
    files: z
      .array(
        z
          .object({
            file_id: z.string().min(1),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            size_bytes: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type CompleteOutputs = z.infer<typeof completeOutputsSchema>;

export const completeOutputsResponseSchema = z
  .object({
    attempt_id: z.string().min(1),
    status: z.literal("outputs_committed"),
    file_ids: z.array(z.string().min(1)).min(1),
    lease_version: z.number().int().nonnegative(),
  })
  .strict();
export type CompleteOutputsResponse = z.infer<typeof completeOutputsResponseSchema>;

export const completeAttemptSchema = z
  .object({
    lease_id: z.string().min(1),
    lease_version: z.number().int().nonnegative(),
    execution_id: z.string().min(1),
    completed_at: z.string().datetime({ offset: true }),
    usage: z.record(z.string(), z.number().nonnegative()),
  })
  .strict();
export type CompleteAttempt = z.infer<typeof completeAttemptSchema>;

export const failAttemptSchema = z
  .object({
    lease_id: z.string().min(1),
    lease_version: z.number().int().nonnegative(),
    execution_id: z.string().min(1),
    failed_at: z.string().datetime({ offset: true }),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1).max(1000),
        retryable: z.boolean(),
        stage: z.string().min(1).optional(),
      })
      .strict(),
    usage: z.record(z.string(), z.number().nonnegative()).default({}),
  })
  .strict();
export type FailAttempt = z.infer<typeof failAttemptSchema>;

export const attemptMutationResponseSchema = z
  .object({
    attempt_id: z.string().min(1),
    task_id: z.string().min(1),
    attempt_status: z.enum(["completed", "failed", "canceled"]),
    task_status: z.enum(["completed", "failed", "canceled"]),
    lease_version: z.number().int().nonnegative(),
  })
  .strict();
export type AttemptMutationResponse = z.infer<typeof attemptMutationResponseSchema>;

export const drainedWorkerSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    release_id: z.string().min(1),
    running_slots: z.literal(0),
    reserved_slots: z.literal(0),
    active_attempt_ids: z.array(z.string()).max(0),
    drain_reason: z.string().min(1),
    observed_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const drainedWorkerResponseSchema = z
  .object({ accepted: z.literal(true), reclaim_token: z.string().min(32) })
  .strict();
export type DrainedWorker = z.infer<typeof drainedWorkerSchema>;
