import { z } from "zod";

export const adminRoleSchema = z.enum(["viewer", "operator", "model_releaser", "security_auditor", "admin"]);

export const adminSessionExchangeSchema = z
  .object({
    organization_id: z.string().min(1).max(128),
    project_id: z.string().min(1).max(128),
  })
  .strict();

export const adminSessionSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("admin.session"),
    organization_id: z.string().min(1),
    project_id: z.string().min(1),
    subject: z.string().min(1),
    display_name: z.string().nullable(),
    email: z.string().email().nullable(),
    organization_roles: z.array(adminRoleSchema),
    project_roles: z.array(adminRoleSchema),
    permissions: z.array(z.string()),
    csrf_token: z.string().min(32).optional(),
    created_at: z.number().int().nonnegative(),
    expires_at: z.number().int().nonnegative(),
  })
  .strict();

export const sensitiveTaskRequestSchema = z
  .object({
    task_id: z.string().min(1),
    request: z.record(z.string(), z.unknown()),
    accessed_at: z.number().int().nonnegative(),
  })
  .strict();

export const adminListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const versionedMutationSchema = z
  .object({
    expected_version: z.number().int().nonnegative(),
    reason: z.string().min(8).max(1000),
  })
  .strict();

const resourceIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const reasonSchema = z.string().min(8).max(1000);

export const modelCreateSchema = z
  .object({
    alias: resourceIdSchema,
    modality: z.enum(["video", "image"]),
    description: z.string().max(2000).default(""),
    reason: reasonSchema,
  })
  .strict();

export const modelUpdateSchema = z
  .object({
    expected_version: z.number().int().positive(),
    status: z.enum(["active", "disabled"]),
    description: z.string().max(2000),
    reason: reasonSchema,
  })
  .strict();

const weightReferenceSchema = z
  .object({
    logical_name: resourceIdSchema,
    sha256: sha256Schema,
    size_bytes: z.number().int().positive(),
    source_uri: z.string().url().optional(),
  })
  .strict();

export const releaseManifestSchema = z
  .object({
    worker_contract_version: z.literal("v1"),
    modalities: z
      .array(z.enum(["video", "image"]))
      .min(1)
      .max(2),
    operations: z
      .array(z.enum(["generation", "edit"]))
      .min(1)
      .max(2),
    capabilities: z.record(z.string(), z.unknown()),
    parameter_schema: z.record(z.string(), z.unknown()),
    output_contract: z.record(z.string(), z.unknown()),
    resource_requirements: z
      .object({
        gpu_skus: z.array(resourceIdSchema).min(1).max(32),
        gpu_memory_bytes: z.number().int().positive(),
        concurrency: z.number().int().min(1).max(16).default(1),
      })
      .strict(),
    components: z.array(z.object({ name: resourceIdSchema, commit: z.string().min(7).max(128) }).strict()).max(128),
    weights: z.array(weightReferenceSchema).max(256),
  })
  .strict();

export const releaseCreateSchema = z
  .object({
    model_id: resourceIdSchema,
    source_image: z.string().min(3).max(2048),
    workflow_hash: sha256Schema,
    maturity: z.enum(["candidate", "stable", "deprecated"]).default("candidate"),
    manifest: releaseManifestSchema,
    reason: reasonSchema,
  })
  .strict();

export const releaseApprovalSchema = z
  .object({
    expected_version: z.number().int().positive(),
    decision: z.enum(["approve", "reject"]),
    reason: reasonSchema,
  })
  .strict();

export const poolCreateSchema = z
  .object({
    release_id: resourceIdSchema,
    provider: resourceIdSchema,
    region_id: resourceIdSchema,
    gpu_sku: resourceIdSchema,
    execution_mode: z.enum(["deployment", "batch"]),
    reason: reasonSchema,
  })
  .strict();

export const poolUpdateSchema = z
  .object({
    expected_version: z.number().int().positive(),
    status: z.enum(["active", "disabled", "degraded"]),
    reason: reasonSchema,
  })
  .strict();

export const capacityPolicyConfigurationSchema = z
  .object({
    min_replicas: z.number().int().nonnegative(),
    max_replicas: z.number().int().positive(),
    queue_target_seconds: z.number().int().positive(),
    target_utilization_percent: z.number().int().min(1).max(100),
    scale_up_step: z.number().int().positive(),
    scale_down_step_percent: z.number().int().min(1).max(100),
    idle_window_seconds: z.number().int().min(60),
    scale_down_cooldown_seconds: z.number().int().min(60),
    hysteresis_percent: z.number().int().min(0).max(100),
  })
  .strict()
  .refine((value) => value.max_replicas >= value.min_replicas, { message: "max_replicas must be >= min_replicas" });

export const budgetPolicyConfigurationSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    hourly_limit_minor: z.number().int().nonnegative(),
    daily_limit_minor: z.number().int().nonnegative(),
    minimum_margin_minor: z.number().int().nonnegative(),
  })
  .strict();

export const regionPolicyConfigurationSchema = z
  .object({
    allowed_regions: z.array(resourceIdSchema).min(1).max(64),
    max_price_per_gpu_hour_minor: z.number().int().nonnegative(),
    completion_weight: z.number().int().min(0).max(1000),
    cost_weight: z.number().int().min(0).max(1000),
    failure_weight: z.number().int().min(0).max(1000),
    cold_start_weight: z.number().int().min(0).max(1000),
    transfer_weight: z.number().int().min(0).max(1000),
  })
  .strict();

export const retryPolicyConfigurationSchema = z
  .object({
    max_attempts: z.number().int().min(1).max(10),
    initial_backoff_seconds: z.number().int().min(1).max(3600),
    max_backoff_seconds: z.number().int().min(1).max(86400),
    retryable_codes: z.array(resourceIdSchema).max(128),
  })
  .strict()
  .refine((value) => value.max_backoff_seconds >= value.initial_backoff_seconds, {
    message: "max_backoff_seconds must be >= initial_backoff_seconds",
  });

export const policyConfigurationSchema = z.union([
  capacityPolicyConfigurationSchema,
  budgetPolicyConfigurationSchema,
  regionPolicyConfigurationSchema,
  retryPolicyConfigurationSchema,
]);

export const policyValidationSchema = z
  .object({
    policy_type: z.enum(["capacity", "budget", "region", "retry"]),
    pool_id: resourceIdSchema,
    configuration: z.record(z.string(), z.unknown()),
    reason: reasonSchema,
  })
  .strict();

export const policyImpactPreviewSchema = z
  .object({
    expected_policy_version: z.number().int().positive(),
    horizon_seconds: z.number().int().min(300).max(86400),
    reason: reasonSchema,
  })
  .strict();

export const policyPublishSchema = z
  .object({
    expected_policy_version: z.number().int().positive(),
    preview_id: resourceIdSchema,
    reason: reasonSchema,
  })
  .strict();

export const policyRollbackSchema = z
  .object({
    expected_current_version: z.number().int().positive(),
    target_policy_id: resourceIdSchema,
    reason: reasonSchema,
  })
  .strict();

export const aliasSwitchSchema = z
  .object({
    model_id: resourceIdSchema,
    release_id: resourceIdSchema,
    expected_version: z.number().int().nonnegative(),
    reason: reasonSchema,
  })
  .strict();

export const rolloutCreateSchema = z
  .object({
    release_id: z.string().min(1),
    pool_id: z.string().min(1),
    preview_id: z.string().min(1),
    expected_pool_version: z.number().int().nonnegative(),
    reason: z.string().min(8).max(1000),
  })
  .strict();
