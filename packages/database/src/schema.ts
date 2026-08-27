import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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

export const adminUsers = pgTable(
  "admin_users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    status: text("status").notNull(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("admin_users_status_idx").on(table.status, table.username)],
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
  schedulingWeight: integer("scheduling_weight").notNull().default(100),
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
    schedulingProfile: jsonb("scheduling_profile").notNull(),
    baselineGpuSeconds: integer("baseline_gpu_seconds").notNull(),
    retryNotBefore: timestamp("retry_not_before", { withTimezone: true }),
    lastRetryReason: text("last_retry_reason"),
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
    attemptNo: integer("attempt_no"),
    poolId: text("pool_id"),
    replicaId: text("replica_id"),
    slotIndex: integer("slot_index"),
    decisionId: text("decision_id"),
    taskVersionAtAssignment: integer("task_version_at_assignment"),
    reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }),
    stage: text("stage"),
    progress: integer("progress"),
    outputManifest: jsonb("output_manifest"),
    outputManifestHash: text("output_manifest_hash"),
    outputsStatus: text("outputs_status").notNull().default("none"),
    usage: jsonb("usage"),
    failureCode: text("failure_code"),
    expectedGpuSeconds: integer("expected_gpu_seconds"),
    predictionSource: text("prediction_source"),
    retryDisposition: text("retry_disposition").notNull().default("none"),
    retryNotBefore: timestamp("retry_not_before", { withTimezone: true }),
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
  status: text("status").notNull().default("reserved"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  version: integer("version").notNull().default(0),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const schedulingDecisions = pgTable(
  "scheduling_decisions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    releaseId: text("release_id").notNull(),
    poolId: text("pool_id").notNull(),
    replicaId: text("replica_id").notNull(),
    workerId: text("worker_id").notNull(),
    taskVersion: integer("task_version").notNull(),
    replicaVersion: integer("replica_version").notNull(),
    slotIndex: integer("slot_index").notNull(),
    policyVersion: text("policy_version").notNull(),
    reason: text("reason").notNull(),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    outcome: text("outcome").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    taskCreatedIdx: index("scheduling_decisions_task_created_idx").on(table.taskId, table.decidedAt, table.id),
    replicaCreatedIdx: index("scheduling_decisions_replica_created_idx").on(table.replicaId, table.decidedAt, table.id),
  }),
);

export const serviceTimeSamples = pgTable(
  "service_time_samples",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id").notNull().unique(),
    taskId: text("task_id").notNull(),
    releaseId: text("release_id").notNull(),
    poolId: text("pool_id").notNull(),
    gpuSku: text("gpu_sku").notNull(),
    dimensionsHash: text("dimensions_hash").notNull(),
    dimensions: jsonb("dimensions").notNull(),
    serviceSeconds: integer("service_seconds").notNull(),
    outcome: text("outcome").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("service_time_samples_profile_idx").on(table.releaseId, table.gpuSku, table.dimensionsHash)],
);

export const serviceTimeProfiles = pgTable(
  "service_time_profiles",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id").notNull(),
    gpuSku: text("gpu_sku").notNull(),
    dimensionsHash: text("dimensions_hash").notNull(),
    dimensions: jsonb("dimensions").notNull(),
    sampleCount: bigint("sample_count", { mode: "number" }).notNull(),
    p75Seconds: integer("p75_seconds").notNull(),
    p95Seconds: integer("p95_seconds").notNull(),
    ewmaSeconds: integer("ewma_seconds").notNull(),
    lastServiceSeconds: integer("last_service_seconds").notNull(),
    lastSampleAt: timestamp("last_sample_at", { withTimezone: true }).notNull(),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("service_time_profiles_release_gpu_dimensions_key").on(
      table.releaseId,
      table.gpuSku,
      table.dimensionsHash,
    ),
  ],
);

export const projectSchedulingAccounts = pgTable("project_scheduling_accounts", {
  releaseId: text("release_id").notNull(),
  projectId: text("project_id").notNull(),
  lane: text("lane").notNull(),
  projectWeight: integer("project_weight").notNull(),
  virtualGpuMilliseconds: bigint("virtual_gpu_milliseconds", { mode: "number" }).notNull(),
  assignedGpuSeconds: bigint("assigned_gpu_seconds", { mode: "number" }).notNull(),
  version: bigint("version", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const schedulerLaneAccounts = pgTable("scheduler_lane_accounts", {
  releaseId: text("release_id").notNull(),
  lane: text("lane").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  assignedGpuSeconds: bigint("assigned_gpu_seconds", { mode: "number" }).notNull(),
  version: bigint("version", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
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
  acceptExistingTasks: boolean("accept_existing_tasks").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const outboxEvents = pgTable("outbox_events", {
  id: text("id").primaryKey(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  aggregateVersion: integer("aggregate_version").notNull(),
  traceId: text("trace_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

export const eventRelayDeliveries = pgTable("event_relay_deliveries", {
  eventId: text("event_id").notNull(),
  sink: text("sink").notNull(),
  status: text("status").notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
  lastErrorCode: text("last_error_code"),
  destinationMetadata: jsonb("destination_metadata"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const eventDeadLetters = pgTable("event_dead_letters", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  sink: text("sink").notNull(),
  attemptCount: integer("attempt_count").notNull(),
  errorCode: text("error_code").notNull(),
  payloadSnapshot: jsonb("payload_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  replayedAt: timestamp("replayed_at", { withTimezone: true }),
});

export const eventConsumerReceipts = pgTable("event_consumer_receipts", {
  consumerName: text("consumer_name").notNull(),
  eventId: text("event_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull(),
});

export const providerCredentials = pgTable("provider_credentials", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  credentialName: text("credential_name").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenFingerprint: text("token_fingerprint").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const redisIndexGenerations = pgTable("redis_index_generations", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  startedOutboxCreatedAt: timestamp("started_outbox_created_at", { withTimezone: true }),
  startedOutboxId: text("started_outbox_id"),
  scannedTasks: bigint("scanned_tasks", { mode: "number" }).notNull(),
  indexedTasks: bigint("indexed_tasks", { mode: "number" }).notNull(),
  validation: jsonb("validation"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failureCode: text("failure_code"),
});

export const redisIndexState = pgTable("redis_index_state", {
  singleton: boolean("singleton").primaryKey(),
  activeGenerationId: text("active_generation_id"),
  schedulerMode: text("scheduler_mode").notNull(),
  version: integer("version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
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

export const providerSnapshotRuns = pgTable("provider_snapshot_runs", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  contractVersion: text("contract_version").notNull(),
  status: text("status").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  payloadHash: text("payload_hash"),
  objectCount: integer("object_count").notNull(),
  quarantineReasons: jsonb("quarantine_reasons").notNull(),
  errorCode: text("error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const providerSnapshotObjects = pgTable("provider_snapshot_objects", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  providerResourceId: text("provider_resource_id").notNull(),
  normalized: jsonb("normalized").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const providerSnapshotPages = pgTable("provider_snapshot_pages", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(),
  endpoint: text("endpoint").notNull(),
  payloadHash: text("payload_hash").notNull(),
  redactedPayload: jsonb("redacted_payload").notNull(),
  quarantineReasons: jsonb("quarantine_reasons").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const providerSnapshotState = pgTable("provider_snapshot_state", {
  provider: text("provider").primaryKey(),
  latestAttemptRunId: text("latest_attempt_run_id").notNull(),
  latestPublishedRunId: text("latest_published_run_id"),
  status: text("status").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  version: integer("version").notNull(),
  lastErrorCode: text("last_error_code"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const providerSyncRequests = pgTable("provider_sync_requests", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  projectId: text("project_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  requestedBy: text("requested_by").notNull(),
  attemptCount: integer("attempt_count").notNull(),
  snapshotRunId: text("snapshot_run_id"),
  errorCode: text("error_code"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  version: integer("version").notNull(),
});

export const modelPools = pgTable("model_pools", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  releaseId: text("release_id").notNull(),
  provider: text("provider").notNull(),
  regionId: text("region_id").notNull(),
  gpuSku: text("gpu_sku").notNull(),
  gpuTargets: jsonb("gpu_targets").notNull().default([]),
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
  rolloutId: text("rollout_id"),
  rolloutStepId: text("rollout_step_id"),
  desiredState: text("desired_state").notNull(),
  observedState: text("observed_state").notNull(),
  rolloutReserved: boolean("rollout_reserved").notNull(),
  version: integer("version").notNull(),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
  idleSince: timestamp("idle_since", { withTimezone: true }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  lastScaleActionAt: timestamp("last_scale_action_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const capacityPlans = pgTable("capacity_plans", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  poolId: text("pool_id").notNull(),
  policyVersionId: text("policy_version_id"),
  status: text("status").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  inputSnapshot: jsonb("input_snapshot").notNull(),
  result: jsonb("result").notNull(),
  currentReplicas: integer("current_replicas").notNull(),
  desiredReplicas: integer("desired_replicas").notNull(),
  workloadReplicas: integer("workload_replicas").notNull(),
  queueSloReplicas: integer("queue_slo_replicas").notNull(),
  costMinor: bigint("cost_minor", { mode: "number" }).notNull(),
  benefitMinor: bigint("benefit_minor", { mode: "number" }).notNull(),
  netBenefitMinor: bigint("net_benefit_minor", { mode: "number" }).notNull(),
  admissionControl: boolean("admission_control").notNull(),
  suppressionReason: text("suppression_reason"),
  strategyVersion: text("strategy_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  replicaId: text("replica_id").notNull().unique(),
  releaseId: text("release_id").notNull(),
  contractVersion: text("contract_version").notNull(),
  status: text("status").notNull(),
  capabilities: jsonb("capabilities").notNull(),
  currentAttemptId: text("current_attempt_id"),
  provider: text("provider"),
  regionId: text("region_id"),
  providerInstanceId: text("provider_instance_id"),
  poolId: text("pool_id"),
  instanceFingerprint: text("instance_fingerprint"),
  hardware: jsonb("hardware"),
  capabilitiesHash: text("capabilities_hash"),
  desiredState: text("desired_state").notNull().default("run"),
  lastSequence: bigint("last_sequence", { mode: "number" }).notNull().default(0),
  unknownSince: timestamp("unknown_since", { withTimezone: true }),
  drainedAt: timestamp("drained_at", { withTimezone: true }),
  reclaimTokenHash: text("reclaim_token_hash"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const workerBootstrapTokens = pgTable("worker_bootstrap_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  replicaId: text("replica_id").notNull(),
  releaseId: text("release_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const workerSessions = pgTable("worker_sessions", {
  id: text("id").primaryKey(),
  workerId: text("worker_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  instanceFingerprint: text("instance_fingerprint").notNull(),
  status: text("status").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  replacedById: text("replaced_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const workerRequestReceipts = pgTable("worker_request_receipts", {
  workerId: text("worker_id").notNull(),
  operation: text("operation").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: jsonb("response_body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const attemptOutputFiles = pgTable("attempt_output_files", {
  attemptId: text("attempt_id").notNull(),
  outputIndex: integer("output_index").notNull(),
  fileId: text("file_id").notNull().unique(),
  role: text("role").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  media: jsonb("media").notNull(),
  provenance: jsonb("provenance").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
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
  desiredPayload: jsonb("desired_payload").notNull(),
  providerResourceId: text("provider_resource_id"),
  providerState: text("provider_state"),
  responseSnapshot: jsonb("response_snapshot"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
  maximumAttempts: integer("maximum_attempts").notNull(),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const modelRollouts = pgTable("model_rollouts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  poolId: text("pool_id").notNull(),
  modelId: text("model_id").notNull(),
  alias: text("alias").notNull(),
  provider: text("provider").notNull(),
  regionId: text("region_id").notNull(),
  gpuSku: text("gpu_sku").notNull(),
  previewId: text("preview_id"),
  sourceReleaseId: text("source_release_id"),
  targetReleaseId: text("target_release_id").notNull(),
  sourceImageDigest: text("source_image_digest").notNull(),
  targetImageDigest: text("target_image_digest").notNull(),
  direction: text("direction").notNull(),
  status: text("status").notNull(),
  strategy: jsonb("strategy").notNull(),
  progress: jsonb("progress").notNull(),
  spentExtraCostMinor: bigint("spent_extra_cost_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  pauseCode: text("pause_code"),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  rollbackRequestedAt: timestamp("rollback_requested_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const rolloutImpactPreviews = pgTable("rollout_impact_previews", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  poolId: text("pool_id").notNull(),
  sourceReleaseId: text("source_release_id").notNull(),
  targetReleaseId: text("target_release_id").notNull(),
  poolVersion: integer("pool_version").notNull(),
  sourceImageDigest: text("source_image_digest").notNull(),
  targetImageDigest: text("target_image_digest").notNull(),
  strategy: jsonb("strategy").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  impact: jsonb("impact").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const rolloutSteps = pgTable("rollout_steps", {
  id: text("id").primaryKey(),
  rolloutId: text("rollout_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  direction: text("direction").notNull(),
  sourceReplicaId: text("source_replica_id"),
  targetReplicaId: text("target_replica_id"),
  prewarmOperationId: text("prewarm_operation_id"),
  terminateOperationId: text("terminate_operation_id"),
  status: text("status").notNull(),
  gates: jsonb("gates").notNull(),
  failure: jsonb("failure"),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const rolloutEvents = pgTable("rollout_events", {
  id: text("id").primaryKey(),
  rolloutId: text("rollout_id").notNull(),
  rolloutVersion: integer("rollout_version").notNull(),
  eventType: text("event_type").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  reason: text("reason").notNull(),
  details: jsonb("details").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
