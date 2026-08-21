import { pgTable, text, integer, timestamp, jsonb, boolean, index, uniqueIndex, bigint } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("organization_memberships_subject_idx").on(table.subjectType, table.subjectId, table.organizationId),
  ],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    oidcGroups: text("oidc_groups").array().notNull(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    csrfHash: text("csrf_hash").notNull(),
    oidcTokenHash: text("oidc_token_hash").notNull().unique(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("admin_sessions_subject_idx").on(table.issuer, table.subject, table.createdAt, table.id)],
);

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  defaultProjectId: text("default_project_id").notNull(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull().unique(),
  keyLastFour: text("key_last_four").notNull(),
  secretHash: text("secret_hash").notNull(),
  scopes: text("scopes").array().notNull(),
  status: text("status").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const projectQuotas = pgTable("project_quotas", {
  projectId: text("project_id").primaryKey(),
  version: integer("version").notNull(),
  requestRatePerMinute: integer("request_rate_per_minute").notNull(),
  requestBurst: integer("request_burst").notNull(),
  taskRatePerMinute: integer("task_rate_per_minute").notNull(),
  taskBurst: integer("task_burst").notNull(),
  queuedTaskLimit: integer("queued_task_limit").notNull(),
  onlineReservationLimit: integer("online_reservation_limit").notNull(),
  batchReservationLimit: integer("batch_reservation_limit").notNull(),
  dailyGpuSecondsLimit: bigint("daily_gpu_seconds_limit", { mode: "number" }),
  dailyCostLimitMinor: bigint("daily_cost_limit_minor", { mode: "number" }),
  currency: text("currency").notNull(),
  maxFileSizeBytes: bigint("max_file_size_bytes", { mode: "number" }).notNull(),
  dailyUploadBytesLimit: bigint("daily_upload_bytes_limit", { mode: "number" }).notNull(),
  activeFileBytesLimit: bigint("active_file_bytes_limit", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const admissionReservations = pgTable(
  "admission_reservations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    apiKeyId: text("api_key_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    lane: text("lane"),
    status: text("status").notNull(),
    estimatedGpuSeconds: bigint("estimated_gpu_seconds", { mode: "number" }).notNull(),
    estimatedCostMinor: bigint("estimated_cost_minor", { mode: "number" }).notNull(),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
    releaseReason: text("release_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => ({
    projectResourceIdx: uniqueIndex("admission_reservations_project_id_resource_type_resource_id_key").on(
      table.projectId,
      table.resourceType,
      table.resourceId,
    ),
  }),
);

export const usageLedger = pgTable("usage_ledger", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  projectId: text("project_id").notNull(),
  taskId: text("task_id"),
  reservationId: text("reservation_id"),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  metric: text("metric").notNull(),
  quantity: bigint("quantity", { mode: "number" }).notNull(),
  currency: text("currency"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  apiKeyId: text("api_key_id"),
  organizationId: text("organization_id"),
  projectId: text("project_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  outcome: text("outcome").notNull(),
  reasonCode: text("reason_code"),
  sourceIp: text("source_ip"),
  userAgent: text("user_agent"),
  requestId: text("request_id").notNull(),
  traceId: text("trace_id"),
  purpose: text("purpose"),
  details: jsonb("details").notNull(),
  signature: text("signature").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    modelReleaseId: text("model_release_id").notNull(),
    operation: text("operation").notNull().default("generation"),
    priority: text("priority").notNull().default("online"),
    requestCiphertext: text("request_ciphertext").notNull(),
    requestHash: text("request_hash").notNull(),
    progress: integer("progress"),
    output: jsonb("output"),
    error: jsonb("error"),
    version: integer("version").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    statusCreatedIdx: index("tasks_status_created_idx").on(table.status, table.createdAt, table.id),
    projectCreatedIdx: index("tasks_project_created_idx").on(table.projectId, table.createdAt, table.id),
  }),
);

export const attempts = pgTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    releaseId: text("release_id").notNull(),
    status: text("status").notNull(),
    executionKey: text("execution_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    taskIdx: index("attempts_task_idx").on(table.taskId, table.createdAt),
  }),
);

export const leases = pgTable("leases", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull().unique(),
  workerId: text("worker_id").notNull(),
  replicaId: text("replica_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  version: integer("version").notNull().default(0),
});

export const modelReleases = pgTable("model_releases", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  modelId: text("model_id").notNull(),
  alias: text("alias").notNull(),
  maturity: text("maturity").notNull(),
  sourceImage: text("source_image").notNull(),
  imageDigest: text("image_digest").notNull(),
  workflowHash: text("workflow_hash").notNull(),
  manifest: jsonb("manifest").notNull(),
  manifestDigest: text("manifest_digest").notNull(),
  manifestMediaType: text("manifest_media_type").notNull(),
  configDigest: text("config_digest").notNull(),
  status: text("status").notNull(),
  version: integer("version").notNull(),
  acceptNewTasks: boolean("accept_new_tasks").notNull().default(false),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const outboxEvents = pgTable("outbox_events", {
  id: text("id").primaryKey(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

export const files = pgTable("files", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  filename: text("filename").notNull(),
  purpose: text("purpose").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  objectKey: text("object_key").notNull().unique(),
  status: text("status").notNull(),
  media: jsonb("media"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    endpoint: text("endpoint").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    taskId: text("task_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    projectEndpointKeyIdx: uniqueIndex("idempotency_project_endpoint_key_idx").on(
      table.projectId,
      table.endpoint,
      table.key,
    ),
  }),
);

export const taskStateEvents = pgTable("task_state_events", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reason: text("reason"),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const taskFiles = pgTable("task_files", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  fileId: text("file_id").notNull(),
  direction: text("direction").notNull(),
  role: text("role").notNull(),
  ordinal: integer("ordinal").notNull(),
});

export const models = pgTable("models", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  alias: text("alias").notNull().unique(),
  modality: text("modality").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const providerRegions = pgTable("provider_regions", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  snapshotVersion: text("snapshot_version"),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const providerInventory = pgTable("provider_inventory", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  regionId: text("region_id").notNull(),
  gpuSku: text("gpu_sku").notNull(),
  gpuMemoryBytes: bigint("gpu_memory_bytes", { mode: "number" }).notNull(),
  availableReplicas: integer("available_replicas").notNull(),
  pricePerGpuHourMinor: bigint("price_per_gpu_hour_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  snapshotVersion: text("snapshot_version").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const modelPools = pgTable("model_pools", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  releaseId: text("release_id").notNull(),
  provider: text("provider").notNull(),
  regionId: text("region_id").notNull(),
  gpuSku: text("gpu_sku").notNull(),
  executionMode: text("execution_mode").notNull(),
  status: text("status").notNull(),
  version: integer("version").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const adminIdempotencyRecords = pgTable(
  "admin_idempotency_records",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    sessionId: text("session_id").notNull(),
    endpoint: text("endpoint").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("admin_idempotency_project_endpoint_key").on(table.projectId, table.endpoint, table.idempotencyKey),
  ],
);

export const modelAliasVersions = pgTable("model_alias_versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  alias: text("alias").notNull(),
  modelId: text("model_id").notNull(),
  releaseId: text("release_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const releaseApprovals = pgTable("release_approvals", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  releaseId: text("release_id").notNull(),
  releaseVersion: integer("release_version").notNull(),
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const policyVersions = pgTable("policy_versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  poolId: text("pool_id").notNull(),
  policyType: text("policy_type").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  configuration: jsonb("configuration").notNull(),
  validation: jsonb("validation").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

export const policyImpactPreviews = pgTable("policy_impact_previews", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  policyVersionId: text("policy_version_id").notNull(),
  policyVersion: integer("policy_version").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  impact: jsonb("impact").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const replicas = pgTable("replicas", {
  id: text("id").primaryKey(),
  poolId: text("pool_id").notNull(),
  releaseId: text("release_id").notNull(),
  provider: text("provider").notNull(),
  providerResourceId: text("provider_resource_id"),
  regionId: text("region_id").notNull(),
  gpuSku: text("gpu_sku").notNull(),
  imageDigest: text("image_digest").notNull(),
  desiredState: text("desired_state").notNull(),
  observedState: text("observed_state").notNull(),
  rolloutReserved: boolean("rollout_reserved").notNull(),
  version: integer("version").notNull(),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  replicaId: text("replica_id").notNull().unique(),
  releaseId: text("release_id").notNull(),
  contractVersion: text("contract_version").notNull(),
  status: text("status").notNull(),
  capabilities: jsonb("capabilities").notNull(),
  currentAttemptId: text("current_attempt_id"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const providerOperations = pgTable("provider_operations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  provider: text("provider").notNull(),
  operationKey: text("operation_key").notNull().unique(),
  operationType: text("operation_type").notNull(),
  status: text("status").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  requestHash: text("request_hash").notNull(),
  retryCount: integer("retry_count").notNull(),
  costMinor: bigint("cost_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  error: jsonb("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const modelRollouts = pgTable("model_rollouts", {
  id: text("id").primaryKey(),
  poolId: text("pool_id").notNull(),
  sourceReleaseId: text("source_release_id"),
  targetReleaseId: text("target_release_id").notNull(),
  status: text("status").notNull(),
  progress: jsonb("progress").notNull(),
  reason: text("reason").notNull(),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
