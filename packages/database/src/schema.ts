import { pgTable, text, integer, timestamp, jsonb, boolean, index, uniqueIndex, bigint } from "drizzle-orm/pg-core";

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
  modelId: text("model_id").notNull(),
  alias: text("alias").notNull(),
  maturity: text("maturity").notNull(),
  imageDigest: text("image_digest").notNull(),
  workflowHash: text("workflow_hash").notNull(),
  manifest: jsonb("manifest").notNull(),
  acceptNewTasks: boolean("accept_new_tasks").notNull().default(false),
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
