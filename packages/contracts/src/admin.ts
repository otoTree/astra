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
    service_time_baseline: z
      .object({
        default_gpu_seconds: z.number().int().positive(),
        video_duration_gpu_seconds: z.record(z.string().regex(/^\d+$/), z.number().int().positive()).default({}),
        image_gpu_seconds_per_output: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
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
    mode: z.enum(["automatic", "protected", "manual"]).default("automatic"),
    min_replicas: z.number().int().nonnegative(),
    max_replicas: z.number().int().positive(),
    manual_replicas: z.number().int().nonnegative().optional(),
    queue_target_seconds: z.number().int().positive(),
    max_queue_eta_seconds: z.number().int().positive().default(900),
    backlog_drain_seconds: z.number().int().positive().default(1800),
    target_utilization_percent: z.number().int().min(1).max(100),
    scale_up_step: z.number().int().positive(),
    emergency_scale_up_step: z.number().int().positive().default(10),
    scale_down_step_percent: z.number().int().min(1).max(100),
    idle_window_seconds: z.number().int().min(60),
    scale_down_observation_seconds: z.number().int().min(60).default(900),
    scale_down_cooldown_seconds: z.number().int().min(60),
    scale_up_cooldown_seconds: z.number().int().min(1).default(60),
    hysteresis_percent: z.number().int().min(0).max(100),
    scale_down_safety_margin_percent: z.number().int().min(0).max(100).default(25),
    min_hold_seconds: z.number().int().min(60).default(1800),
    provisioning_p90_seconds: z.number().int().min(1).default(300),
    min_net_benefit_minor: z.number().int().nonnegative().default(0),
    min_net_saving_minor: z.number().int().nonnegative().default(0),
    wait_value_minor_per_minute: z.number().int().nonnegative().default(0),
    slo_penalty_minor_per_minute: z.number().int().nonnegative().default(0),
    batch_min_share_percent: z.number().int().min(0).max(100).default(10),
    aging_seconds: z.number().int().min(60).max(86400).default(1800),
    prediction_min_samples: z.number().int().min(1).max(10000).default(30),
    ewma_alpha_basis_points: z.number().int().min(1).max(10000).default(2000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.max_replicas < value.min_replicas) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["max_replicas"], message: "must be >= min_replicas" });
    }
    if (value.mode === "manual" && value.manual_replicas === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["manual_replicas"], message: "required in manual mode" });
    }
    if (
      value.manual_replicas !== undefined &&
      (value.manual_replicas < value.min_replicas || value.manual_replicas > value.max_replicas)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manual_replicas"],
        message: "must be within min_replicas and max_replicas",
      });
    }
  });

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
    allowed_providers: z.array(resourceIdSchema).min(1).max(64).optional(),
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
    expected_pool_version: z.number().int().positive(),
    reason: z.string().min(8).max(1000),
  })
  .strict();

export const rolloutStrategySchema = z
  .object({
    max_surge: z.number().int().min(0).max(100).default(1),
    max_unavailable: z.number().int().min(0).max(100).default(0),
    batch_size: z.number().int().min(1).max(100).default(1),
    readiness_timeout_seconds: z.number().int().min(60).max(7200).default(1800),
    readiness_stability_seconds: z.number().int().min(10).max(1800).default(60),
    progress_deadline_seconds: z.number().int().min(300).max(86400).default(7200),
    pause_on_failure: z.boolean().default(true),
    maximum_failure_rate_basis_points: z.number().int().min(0).max(10000).default(500),
    maximum_duration_regression_basis_points: z.number().int().min(0).max(100000).default(2500),
    maximum_extra_cost_minor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    rollback_retention_seconds: z.number().int().min(3600).max(2592000).default(604800),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.max_surge === 0 && value.max_unavailable === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_surge"],
        message: "max_surge and max_unavailable cannot both be zero",
      });
    }
    if (value.progress_deadline_seconds < value.readiness_timeout_seconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["progress_deadline_seconds"],
        message: "progress_deadline_seconds must be >= readiness_timeout_seconds",
      });
    }
  });

export const rolloutPreviewSchema = z
  .object({
    release_id: resourceIdSchema,
    pool_id: resourceIdSchema,
    expected_pool_version: z.number().int().positive(),
    strategy: rolloutStrategySchema,
    reason: reasonSchema,
  })
  .strict();

export const rolloutControlSchema = z
  .object({
    expected_version: z.number().int().positive(),
    reason: reasonSchema,
  })
  .strict();
