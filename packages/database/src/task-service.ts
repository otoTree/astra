import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import Ajv from "ajv";
import {
  inputMediaTypeForContentType,
  resolveVideoGenerationRequest,
  secureRandomSeed,
  type ImageGenerationRequest,
  type TaskStatus,
  type VideoGenerationRequest,
} from "@astra/contracts";

type SqlClient = ReturnType<typeof postgres>;
type GenerationRequest = VideoGenerationRequest | ImageGenerationRequest;

export type TaskServiceContext = Readonly<{ projectId: string; organizationId: string }>;
export type CreatedTask = Readonly<{
  id: string;
  object: "generation.task";
  type: "video" | "image";
  operation: "generation";
  status: TaskStatus;
  model: string;
  model_release: string;
  priority: "online" | "batch";
  request: GenerationRequest;
  created_at: number;
  updated_at: number;
}>;
export type TaskListFilter = Readonly<{
  limit: number;
  after?: string;
  type?: "video" | "image";
  statuses?: string[];
  model?: string;
}>;

export type TaskServiceOptions = Readonly<{
  requestEncryptionKey: string;
  now?: () => Date;
  createId?: (prefix: string) => string;
  createSeed?: () => number;
}>;

const systemNow = (): Date => new Date();
const systemId = (prefix: string): string => `${prefix}_${Bun.randomUUIDv7()}`;
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  return value;
};
const canonical = (value: unknown): string => JSON.stringify(canonicalize(value));
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const unix = (value: Date | string): number => Math.floor(new Date(value).getTime() / 1000);

function taskView(row: Record<string, unknown>, request: GenerationRequest, model: string): CreatedTask {
  const created = row.created_at as Date | string;
  const updated = row.updated_at as Date | string;
  return {
    id: String(row.id),
    object: "generation.task",
    type: row.type as "video" | "image",
    operation: "generation",
    status: row.status as TaskStatus,
    model,
    model_release: String(row.model_release_id),
    priority: row.priority as "online" | "batch",
    request,
    created_at: unix(created),
    updated_at: unix(updated),
  };
}

export class TaskService {
  private readonly encryptionKey: Buffer;
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private readonly createSeed: () => number;

  constructor(
    private readonly sql: SqlClient,
    options: TaskServiceOptions,
  ) {
    this.encryptionKey = createHash("sha256").update(options.requestEncryptionKey).digest();
    this.now = options.now ?? systemNow;
    this.createId = options.createId ?? systemId;
    this.createSeed = options.createSeed ?? secureRandomSeed;
  }

  private seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  private open<T>(sealed: string): T {
    const [version, ivValue, tagValue, ciphertextValue] = sealed.split(".");
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) throw new Error("request_decryption_failed");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8"),
    ) as T;
  }

  private encodeCursor(payload: Readonly<{ createdAt: string; id: string; filterHash: string }>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.encryptionKey).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private decodeCursor(cursor: string, filterHash: string): { createdAt: string; id: string } {
    const [body, signature] = cursor.split(".");
    if (!body || !signature) throw new Error("invalid_cursor");
    const expected = createHmac("sha256", this.encryptionKey).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid_cursor");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
      filterHash?: unknown;
    };
    if (
      typeof payload.createdAt !== "string" ||
      typeof payload.id !== "string" ||
      payload.filterHash !== filterHash ||
      Number.isNaN(Date.parse(payload.createdAt))
    )
      throw new Error("invalid_cursor");
    return { createdAt: payload.createdAt, id: payload.id };
  }

  async create(
    context: TaskServiceContext,
    input: GenerationRequest,
    type: "video" | "image",
    endpoint: string,
    idempotencyKey?: string,
  ): Promise<{ task: CreatedTask; replayed: boolean }> {
    const requestHash = hash(input);
    const task = await this.sql.begin(async (transaction) => {
      if (idempotencyKey) {
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.projectId}:${endpoint}:${idempotencyKey}`}, 0))`;
        const existing =
          await transaction`SELECT * FROM idempotency_records WHERE project_id=${context.projectId} AND endpoint=${endpoint} AND key=${idempotencyKey} FOR UPDATE`;
        const record = existing[0] as Record<string, unknown> | undefined;
        if (record) {
          if (record.request_hash !== requestHash) throw new Error("idempotency_conflict");
          if (!record.task_id) throw new Error("idempotency_incomplete");
          const rows =
            await transaction`SELECT t.*, r.alias AS model FROM tasks t JOIN model_releases r ON r.id=t.model_release_id WHERE t.id=${String(record.task_id)}`;
          const row = rows[0] as Record<string, unknown> | undefined;
          if (!row) throw new Error("task_not_found");
          return { row, replayed: true };
        }
      }

      const model = String(input.model);
      const releases =
        await transaction`SELECT id, alias, manifest FROM model_releases WHERE (alias=${model} OR id=${model}) AND accept_new_tasks=true ORDER BY created_at DESC LIMIT 1`;
      const release = releases[0] as Record<string, unknown> | undefined;
      if (!release) throw new Error("model_not_found");
      const manifest = release.manifest as {
        capabilities?: { resolution_matrix?: Record<string, unknown>; durations?: number[] };
      };
      const optionsSchema = (release.manifest as { model_options_schema?: Record<string, unknown> })
        .model_options_schema;
      if (optionsSchema) {
        if (!this.ajv.validate(optionsSchema, input.model_options)) throw new Error("invalid_model_options");
      } else if (Object.keys(input.model_options).length > 0) {
        throw new Error("invalid_model_options");
      }
      if (type === "video") {
        const video = input as VideoGenerationRequest;
        if (!manifest.capabilities?.resolution_matrix?.[`${video.aspect_ratio}/${video.resolution}`])
          throw new Error("model_capability_mismatch");
        if (manifest.capabilities.durations && !manifest.capabilities.durations.includes(video.duration))
          throw new Error("model_capability_mismatch");
      }
      const timestamp = this.now();
      const taskId = this.createId("task");
      const minimumExpiry = new Date(timestamp.getTime() + 60 * 60 * 1000);
      const validatedInputs: Array<{ fileId: string; role: string; ordinal: number }> = [];
      for (const [ordinal, inputFile] of input.input_files.entries()) {
        const fileRows =
          await transaction`SELECT id, content_type, status, expires_at FROM files WHERE id=${inputFile.file_id} AND project_id=${context.projectId} FOR SHARE`;
        const file = fileRows[0] as Record<string, unknown> | undefined;
        if (file?.status !== "available") throw new Error("invalid_input_media");
        if (new Date(file.expires_at as Date | string) < minimumExpiry) throw new Error("input_ttl_too_short");
        if ("type" in inputFile && inputMediaTypeForContentType(String(file.content_type)) !== inputFile.type)
          throw new Error("invalid_input_media");
        validatedInputs.push({ fileId: inputFile.file_id, role: inputFile.role, ordinal });
      }
      const resolved =
        type === "video"
          ? resolveVideoGenerationRequest(
              input as VideoGenerationRequest,
              {
                fps: Number((manifest as { fps?: number[] }).fps?.[0] ?? 24),
                resolutionMatrix: manifest.capabilities?.resolution_matrix as Record<
                  string,
                  { width: number; height: number }
                >,
              },
              this.createSeed,
            )
          : input;
      const sealed = this.seal({ request: input, execution: resolved });
      const rows =
        await transaction`INSERT INTO tasks (id, project_id, type, operation, status, priority, model_release_id, request_ciphertext, request_hash, version, created_at, updated_at)
        VALUES (${taskId}, ${context.projectId}, ${type}, 'generation', 'queued', ${input.priority ?? "online"}, ${String(release.id)}, ${sealed}, ${requestHash}, 0, ${timestamp.toISOString()}, ${timestamp.toISOString()}) RETURNING *`;
      const row = rows[0] as Record<string, unknown>;
      row.model = model;
      for (const inputFile of validatedInputs) {
        await transaction`INSERT INTO task_files (id, task_id, file_id, direction, role, ordinal) VALUES (${this.createId("taskfile")}, ${taskId}, ${inputFile.fileId}, 'input', ${inputFile.role}, ${inputFile.ordinal})`;
      }
      await transaction`INSERT INTO task_state_events (id, task_id, from_status, to_status, reason, version, created_at) VALUES (${this.createId("evt")}, ${taskId}, NULL, 'queued', 'created', 0, ${timestamp.toISOString()})`;
      await transaction`INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at) VALUES (${this.createId("evt")}, 'generation_task', ${taskId}, 'task.queued', ${JSON.stringify({ task_id: taskId, project_id: context.projectId, type })}, ${timestamp.toISOString()})`;
      if (idempotencyKey)
        await transaction`INSERT INTO idempotency_records (id, project_id, endpoint, key, request_hash, task_id, created_at) VALUES (${this.createId("idem")}, ${context.projectId}, ${endpoint}, ${idempotencyKey}, ${requestHash}, ${taskId}, ${timestamp.toISOString()})`;
      return { row, replayed: false };
    });
    const row = task.row as Record<string, unknown>;
    return { task: taskView(row, input, String(row.model)), replayed: task.replayed };
  }

  async get(context: TaskServiceContext, taskId: string): Promise<CreatedTask | undefined> {
    const rows = await this
      .sql`SELECT t.*, r.alias AS model FROM tasks t JOIN model_releases r ON r.id=t.model_release_id WHERE t.id=${taskId} AND t.project_id=${context.projectId}`;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const request = this.open<{ request: GenerationRequest }>(String(row.request_ciphertext)).request;
    return taskView(row, request, String(row.model));
  }

  async ready(): Promise<boolean> {
    try {
      const rows = await this.sql`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS migrated`;
      return rows[0]?.migrated === true;
    } catch {
      return false;
    }
  }

  async list(
    context: TaskServiceContext,
    filter: TaskListFilter,
  ): Promise<{ object: "list"; data: CreatedTask[]; has_more: boolean; next_cursor: string | null }> {
    const filterHash = hash({
      projectId: context.projectId,
      type: filter.type ?? null,
      statuses: [...(filter.statuses ?? [])].sort(),
      model: filter.model ?? null,
    });
    const position = filter.after ? this.decodeCursor(filter.after, filterHash) : undefined;
    const statuses = filter.statuses ?? [];
    const rows = await this
      .sql`SELECT t.*, r.alias AS model FROM tasks t JOIN model_releases r ON r.id=t.model_release_id
      WHERE t.project_id=${context.projectId}
        AND (${filter.type ?? null}::text IS NULL OR t.type=${filter.type ?? null})
        AND (${filter.model ?? null}::text IS NULL OR r.alias=${filter.model ?? null} OR r.id=${filter.model ?? null})
        AND (${statuses.length === 0} OR t.status=ANY(${this.sql.array(statuses)}::text[]))
        AND (${position?.createdAt ?? null}::timestamptz IS NULL OR (t.created_at, t.id) < (${position?.createdAt ?? null}::timestamptz, ${position?.id ?? null}::text))
      ORDER BY t.created_at DESC, t.id DESC LIMIT ${filter.limit + 1}`;
    const hasMore = rows.length > filter.limit;
    const selected = rows.slice(0, filter.limit) as Array<Record<string, unknown>>;
    const data = selected.map((row) =>
      taskView(
        row,
        this.open<{ request: GenerationRequest }>(String(row.request_ciphertext)).request,
        String(row.model),
      ),
    );
    const last = selected.at(-1);
    return {
      object: "list",
      data,
      has_more: hasMore,
      next_cursor:
        hasMore && last
          ? this.encodeCursor({
              createdAt: new Date(last.created_at as Date | string).toISOString(),
              id: String(last.id),
              filterHash,
            })
          : null,
    };
  }

  async cancel(context: TaskServiceContext, taskId: string): Promise<CreatedTask | undefined> {
    const result = await this.sql.begin(async (transaction) => {
      const rows =
        await transaction`SELECT t.*, r.alias AS model FROM tasks t JOIN model_releases r ON r.id=t.model_release_id WHERE t.id=${taskId} AND t.project_id=${context.projectId} FOR UPDATE`;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const current = String(row.status);
      const next = ["queued", "scheduling", "provisioning"].includes(current)
        ? "canceled"
        : current === "running" || current === "post_processing" || current === "uploading"
          ? "canceling"
          : current;
      if (next !== current) {
        const version = Number(row.version) + 1;
        const changedAt = this.now().toISOString();
        await transaction`UPDATE tasks SET status=${next}, version=${version}, updated_at=${changedAt} WHERE id=${taskId} AND version=${Number(row.version)}`;
        await transaction`INSERT INTO task_state_events (id, task_id, from_status, to_status, reason, version, created_at) VALUES (${this.createId("evt")}, ${taskId}, ${current}, ${next}, 'client_cancel', ${version}, ${changedAt})`;
        await transaction`INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at) VALUES (${this.createId("evt")}, 'generation_task', ${taskId}, 'task.' || ${next}, ${JSON.stringify({ task_id: taskId })}, ${changedAt})`;
        row.status = next;
        row.version = version;
      }
      return taskView(
        row,
        this.open<{ request: GenerationRequest }>(String(row.request_ciphertext)).request,
        String(row.model),
      );
    });
    return result;
  }
}
