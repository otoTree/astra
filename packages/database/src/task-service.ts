import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import Ajv from "ajv";
import {
  inputMediaTypeForContentType,
  resolveVideoGenerationRequest,
  secureRandomSeed,
  type ImageEditRequest,
  type ImageGenerationRequest,
  type ResolvedVideoGenerationRequest,
  type TaskStatus,
  type VideoEditRequest,
  type VideoGenerationRequest,
} from "@astra/contracts";

type SqlClient = ReturnType<typeof postgres>;
type TaskRequest = VideoGenerationRequest | VideoEditRequest | ImageGenerationRequest | ImageEditRequest;
type TaskExecutionRequest = TaskRequest | ResolvedVideoGenerationRequest;
type TaskSnapshot = Readonly<{ request: TaskRequest; execution: TaskExecutionRequest }>;

export type TaskServiceContext = Readonly<{ projectId: string; organizationId: string }>;
export type CreatedTask = Readonly<{
  id: string;
  object: "generation.task";
  type: "video" | "image";
  operation: "generation" | "edit";
  status: TaskStatus;
  model: string;
  model_release: string;
  priority: "online" | "batch";
  request: TaskRequest;
  resolved_parameters: Readonly<{ width: number; height: number; fps?: number }>;
  progress: number | null;
  status_reason: string | null;
  output_file_ids: string[];
  output: Record<string, unknown> | null;
  error: Readonly<{ code: string; message: string; retryable: boolean }> | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  expires_at: number | null;
}>;
export type TaskListFilter = Readonly<{
  limit: number;
  after?: string;
  type?: "video" | "image";
  statuses?: string[];
  model?: string;
  priority?: "online" | "batch";
  createdAfter?: Date;
  createdBefore?: Date;
}>;

export type PublicModel = Readonly<{
  id: string;
  object: "model";
  type: "video" | "image";
  release: string;
  maturity: "candidate" | "stable" | "deprecated";
  operations: Array<"generation" | "edit">;
  capabilities: Record<string, unknown>;
  created_at: number;
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

function resolvedParameters(
  type: "video" | "image",
  execution: TaskExecutionRequest,
): Readonly<{ width: number; height: number; fps?: number }> {
  if (type === "video") {
    const video = execution as Partial<ResolvedVideoGenerationRequest>;
    if (
      !Number.isInteger(video.width) ||
      Number(video.width) <= 0 ||
      !Number.isInteger(video.height) ||
      Number(video.height) <= 0 ||
      typeof video.fps !== "number" ||
      !Number.isFinite(video.fps) ||
      video.fps <= 0
    ) {
      throw new Error("request_decryption_failed");
    }
    return { width: Number(video.width), height: Number(video.height), fps: video.fps };
  }
  const dimensions = String((execution as ImageGenerationRequest | ImageEditRequest).size).split("x");
  const width = Number(dimensions[0]);
  const height = Number(dimensions[1]);
  if (dimensions.length !== 2 || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("request_decryption_failed");
  }
  return { width, height };
}

function taskView(row: Record<string, unknown>, snapshot: TaskSnapshot, model: string): CreatedTask {
  const created = row.created_at as Date | string;
  const updated = row.updated_at as Date | string;
  const type = row.type as "video" | "image";
  return {
    id: String(row.id),
    object: "generation.task",
    type,
    operation: row.operation as "generation" | "edit",
    status: row.status as TaskStatus,
    model,
    model_release: String(row.model_release_id),
    priority: row.priority as "online" | "batch",
    request: snapshot.request,
    resolved_parameters: resolvedParameters(type, snapshot.execution),
    progress: row.progress === null || row.progress === undefined ? null : Number(row.progress),
    status_reason: null,
    output_file_ids: Array.isArray(row.output_file_ids) ? row.output_file_ids.map(String) : [],
    output: (row.output as Record<string, unknown> | null) ?? null,
    error: (row.error as CreatedTask["error"]) ?? null,
    created_at: unix(created),
    updated_at: unix(updated),
    completed_at: row.completed_at ? unix(row.completed_at as Date | string) : null,
    expires_at: row.expires_at ? unix(row.expires_at as Date | string) : null,
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
    input: TaskRequest,
    type: "video" | "image",
    operation: "generation" | "edit",
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
          const rows = await transaction`SELECT t.*, r.alias AS model,
            ARRAY(SELECT tf.file_id FROM task_files tf WHERE tf.task_id=t.id AND tf.direction='output' ORDER BY tf.ordinal) AS output_file_ids
            FROM tasks t JOIN model_releases r ON r.id=t.model_release_id WHERE t.id=${String(record.task_id)}`;
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
        modalities?: string[];
        operations?: string[];
        capabilities?: {
          resolution_matrix?: Record<string, unknown>;
          durations?: number[];
          input_roles?: string[];
          audio_modes?: string[];
          image?: {
            sizes?: string[];
            qualities?: string[];
            formats?: string[];
            max_outputs?: number;
            input_roles?: string[];
          };
        };
      };
      if (!manifest.modalities?.includes(type) || !manifest.operations?.includes(operation)) {
        throw new Error("model_capability_mismatch");
      }
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
        if (manifest.capabilities.audio_modes && !manifest.capabilities.audio_modes.includes(video.audio.mode)) {
          throw new Error("model_capability_mismatch");
        }
        const roles = manifest.capabilities.input_roles ?? [];
        if (video.input_files.some((file) => !roles.includes(file.role))) throw new Error("model_capability_mismatch");
      } else {
        const image = input as ImageGenerationRequest | ImageEditRequest;
        const capability = manifest.capabilities?.image;
        if (!capability?.sizes?.includes(image.size)) throw new Error("model_capability_mismatch");
        if (image.quality && !capability.qualities?.includes(image.quality))
          throw new Error("model_capability_mismatch");
        if (!capability.formats?.includes(image.output_format)) throw new Error("model_capability_mismatch");
        if (image.n > (capability.max_outputs ?? 1)) throw new Error("model_capability_mismatch");
        if (image.input_files.some((file) => !capability.input_roles?.includes(file.role))) {
          throw new Error("model_capability_mismatch");
        }
      }
      const timestamp = this.now();
      const taskId = this.createId("task");
      const minimumExpiry = new Date(timestamp.getTime() + 60 * 60 * 1000);
      const validatedInputs: Array<{ fileId: string; role: string; ordinal: number }> = [];
      for (const [ordinal, inputFile] of input.input_files.entries()) {
        const fileRows =
          await transaction`SELECT id, content_type, media, status, expires_at FROM files WHERE id=${inputFile.file_id} AND project_id=${context.projectId} FOR SHARE`;
        const file = fileRows[0] as Record<string, unknown> | undefined;
        if (file?.status !== "available") throw new Error("invalid_input_media");
        if (new Date(file.expires_at as Date | string) < minimumExpiry) throw new Error("input_ttl_too_short");
        if ("type" in inputFile) {
          const media = file.media as { media_type?: unknown } | null;
          if (
            inputMediaTypeForContentType(String(file.content_type)) !== inputFile.type ||
            media?.media_type !== inputFile.type
          ) {
            throw new Error("invalid_input_media");
          }
        }
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
        VALUES (${taskId}, ${context.projectId}, ${type}, ${operation}, 'queued', ${input.priority ?? "online"}, ${String(release.id)}, ${sealed}, ${requestHash}, 0, ${timestamp.toISOString()}, ${timestamp.toISOString()}) RETURNING *`;
      const row = rows[0] as Record<string, unknown>;
      row.model = String(release.alias);
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
    const snapshot = this.open<TaskSnapshot>(String(row.request_ciphertext));
    return { task: taskView(row, snapshot, String(row.model)), replayed: task.replayed };
  }

  async get(context: TaskServiceContext, taskId: string): Promise<CreatedTask | undefined> {
    const rows = await this.sql`SELECT t.*, r.alias AS model,
      ARRAY(SELECT tf.file_id FROM task_files tf WHERE tf.task_id=t.id AND tf.direction='output' ORDER BY tf.ordinal) AS output_file_ids
      FROM tasks t JOIN model_releases r ON r.id=t.model_release_id
      WHERE t.id=${taskId} AND t.project_id=${context.projectId}`;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const snapshot = this.open<TaskSnapshot>(String(row.request_ciphertext));
    return taskView(row, snapshot, String(row.model));
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
      priority: filter.priority ?? null,
      createdAfter: filter.createdAfter?.toISOString() ?? null,
      createdBefore: filter.createdBefore?.toISOString() ?? null,
    });
    const position = filter.after ? this.decodeCursor(filter.after, filterHash) : undefined;
    const statuses = filter.statuses ?? [];
    const rows = await this.sql`SELECT t.*, r.alias AS model,
      ARRAY(SELECT tf.file_id FROM task_files tf WHERE tf.task_id=t.id AND tf.direction='output' ORDER BY tf.ordinal) AS output_file_ids
      FROM tasks t JOIN model_releases r ON r.id=t.model_release_id
      WHERE t.project_id=${context.projectId}
        AND (${filter.type ?? null}::text IS NULL OR t.type=${filter.type ?? null})
        AND (${filter.model ?? null}::text IS NULL OR r.alias=${filter.model ?? null} OR r.id=${filter.model ?? null})
        AND (${filter.priority ?? null}::text IS NULL OR t.priority=${filter.priority ?? null})
        AND (${statuses.length === 0} OR t.status=ANY(${this.sql.array(statuses)}::text[]))
        AND (${filter.createdAfter?.toISOString() ?? null}::timestamptz IS NULL OR t.created_at >= ${filter.createdAfter?.toISOString() ?? null}::timestamptz)
        AND (${filter.createdBefore?.toISOString() ?? null}::timestamptz IS NULL OR t.created_at <= ${filter.createdBefore?.toISOString() ?? null}::timestamptz)
        AND (${position?.createdAt ?? null}::timestamptz IS NULL OR (t.created_at, t.id) < (${position?.createdAt ?? null}::timestamptz, ${position?.id ?? null}::text))
      ORDER BY t.created_at DESC, t.id DESC LIMIT ${filter.limit + 1}`;
    const hasMore = rows.length > filter.limit;
    const selected = rows.slice(0, filter.limit) as Array<Record<string, unknown>>;
    const data = selected.map((row) =>
      taskView(row, this.open<TaskSnapshot>(String(row.request_ciphertext)), String(row.model)),
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
      const rows = await transaction`SELECT t.*, r.alias AS model,
        ARRAY(SELECT tf.file_id FROM task_files tf WHERE tf.task_id=t.id AND tf.direction='output' ORDER BY tf.ordinal) AS output_file_ids
        FROM tasks t JOIN model_releases r ON r.id=t.model_release_id
        WHERE t.id=${taskId} AND t.project_id=${context.projectId} FOR UPDATE OF t`;
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
      return taskView(row, this.open<TaskSnapshot>(String(row.request_ciphertext)), String(row.model));
    });
    return result;
  }

  async listModels(
    _context: TaskServiceContext,
    type?: "video" | "image",
  ): Promise<{ object: "list"; data: PublicModel[]; has_more: false; next_cursor: null }> {
    const rows = await this.sql`SELECT id, alias, maturity, manifest, created_at
      FROM model_releases
      WHERE accept_new_tasks=true
      ORDER BY alias ASC, created_at DESC, id DESC`;
    const seen = new Set<string>();
    const data: PublicModel[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const alias = String(row.alias);
      const manifest = row.manifest as {
        modalities?: string[];
        operations?: string[];
        capabilities?: Record<string, unknown>;
      };
      const modalities = (manifest.modalities ?? []).filter(
        (item): item is "video" | "image" => item === "video" || item === "image",
      );
      const selectedTypes = type ? modalities.filter((item) => item === type) : modalities;
      for (const selectedType of selectedTypes) {
        const key = `${alias}:${selectedType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        data.push({
          id: alias,
          object: "model",
          type: selectedType,
          release: String(row.id),
          maturity: row.maturity as PublicModel["maturity"],
          operations: (manifest.operations ?? []).filter(
            (item): item is "generation" | "edit" => item === "generation" || item === "edit",
          ),
          capabilities: manifest.capabilities ?? {},
          created_at: unix(row.created_at as Date | string),
        });
      }
    }
    return { object: "list", data, has_more: false, next_cursor: null };
  }
}
