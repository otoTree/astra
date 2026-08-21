import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;
export type AdminQueryContext = Readonly<{ organizationId: string; projectId: string }>;
export type AdminResource =
  | "tasks"
  | "models"
  | "releases"
  | "pools"
  | "rollouts"
  | "workers"
  | "replicas"
  | "provider_operations"
  | "audit_events"
  | "regions"
  | "inventory"
  | "aliases"
  | "policies"
  | "policy_previews"
  | "release_approvals";
export type AdminListResource = Exclude<AdminResource, "tasks">;

export type AdminListResult = Readonly<{
  object: "list";
  data: readonly Record<string, unknown>[];
  has_more: boolean;
  next_after: string | null;
}>;

const tableByResource: Readonly<Record<Exclude<AdminResource, "tasks" | "regions" | "inventory">, string>> = {
  models: "models",
  releases: "model_releases",
  pools: "model_pools",
  rollouts: "model_rollouts",
  workers: "workers",
  replicas: "replicas",
  provider_operations: "provider_operations",
  audit_events: "audit_events",
  aliases: "model_alias_versions",
  policies: "policy_versions",
  policy_previews: "policy_impact_previews",
  release_approvals: "release_approvals",
};

const unix = (value: unknown): number | null =>
  value instanceof Date || typeof value === "string" ? Math.floor(new Date(value).getTime() / 1000) : null;

const jsonRecord = (row: Record<string, unknown>): Record<string, unknown> => {
  const output = { ...row };
  for (const key of [
    "created_at",
    "updated_at",
    "completed_at",
    "expires_at",
    "last_heartbeat_at",
    "last_observed_at",
    "observed_at",
  ]) {
    if (key in output) output[key] = output[key] === null ? null : unix(output[key]);
  }
  return output;
};

export class AdminQueryService {
  private readonly cursorKey: Buffer;

  constructor(
    private readonly sql: SqlClient,
    cursorSigningKey: string,
  ) {
    this.cursorKey = createHash("sha256").update(`astra-admin-cursor-v1:${cursorSigningKey}`).digest();
  }

  private encodeCursor(resource: AdminResource, context: AdminQueryContext, createdAt: string, id: string): string {
    const body = Buffer.from(
      JSON.stringify({ resource, project_id: context.projectId, created_at: createdAt, id }),
    ).toString("base64url");
    return `${body}.${createHmac("sha256", this.cursorKey).update(body).digest("base64url")}`;
  }

  private decodeCursor(
    cursor: string,
    resource: AdminResource,
    context: AdminQueryContext,
  ): Readonly<{ createdAt: string; id: string }> {
    const [body, signature] = cursor.split(".");
    if (!body || !signature) throw new Error("invalid_cursor");
    const expected = createHmac("sha256", this.cursorKey).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid_cursor");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("invalid_cursor");
    }
    if (
      payload.resource !== resource ||
      payload.project_id !== context.projectId ||
      typeof payload.created_at !== "string" ||
      Number.isNaN(Date.parse(payload.created_at)) ||
      typeof payload.id !== "string"
    ) {
      throw new Error("invalid_cursor");
    }
    return { createdAt: payload.created_at, id: payload.id };
  }

  async list(
    context: AdminQueryContext,
    resource: AdminListResource,
    input: Readonly<{ limit: number; after?: string }>,
  ): Promise<AdminListResult> {
    const cursor = input.after ? this.decodeCursor(input.after, resource, context) : undefined;
    const limit = Math.min(Math.max(input.limit, 1), 200);
    let rows: readonly Record<string, unknown>[];
    if (resource === "regions") {
      rows = await this.sql`SELECT * FROM provider_regions
        WHERE (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? ""}))
        ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;
    } else if (resource === "inventory") {
      rows = await this.sql`SELECT i.*, r.name AS region_name, r.status AS region_status
        FROM provider_inventory i JOIN provider_regions r ON r.id=i.region_id
        WHERE (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (i.created_at, i.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? ""}))
        ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit + 1}`;
    } else if (resource === "audit_events") {
      rows = await this.sql`SELECT id, actor_type, actor_id, organization_id, project_id, action,
          resource_type, resource_id, outcome, reason_code, source_ip, user_agent,
          request_id, trace_id, purpose, details, created_at
        FROM audit_events
        WHERE organization_id=${context.organizationId} AND project_id=${context.projectId}
          AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? ""}))
        ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;
    } else if (
      [
        "models",
        "releases",
        "pools",
        "provider_operations",
        "aliases",
        "policies",
        "policy_previews",
        "release_approvals",
      ].includes(resource)
    ) {
      const table = tableByResource[resource];
      rows = (await this.sql.unsafe(
        `SELECT * FROM ${table}
         WHERE project_id=$1
           AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [context.projectId, cursor?.createdAt ?? null, cursor?.id ?? "", limit + 1],
      )) as readonly Record<string, unknown>[];
    } else if (resource === "rollouts") {
      rows = await this.sql`SELECT r.* FROM model_rollouts r JOIN model_pools p ON p.id=r.pool_id
        WHERE p.project_id=${context.projectId}
          AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (r.created_at, r.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? ""}))
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`;
    } else if (resource === "replicas") {
      rows = await this.sql`SELECT r.* FROM replicas r JOIN model_pools p ON p.id=r.pool_id
        WHERE p.project_id=${context.projectId}
          AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (r.created_at, r.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? ""}))
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`;
    } else {
      rows = await this.sql`SELECT w.* FROM workers w
        JOIN replicas r ON r.id=w.replica_id JOIN model_pools p ON p.id=r.pool_id
        WHERE p.project_id=${context.projectId}
          AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (w.created_at, w.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? ""}))
        ORDER BY w.created_at DESC, w.id DESC LIMIT ${limit + 1}`;
    }
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(jsonRecord);
    const last = page.at(-1);
    return {
      object: "list",
      data: page,
      has_more: hasMore,
      next_after:
        hasMore && last && typeof last.id === "string"
          ? this.encodeCursor(
              resource,
              context,
              new Date(rows[Math.min(limit, rows.length) - 1]?.created_at as Date | string).toISOString(),
              last.id,
            )
          : null,
    };
  }

  async listTasks(
    context: AdminQueryContext,
    input: Readonly<{ limit: number; after?: string }>,
  ): Promise<AdminListResult> {
    const cursor = input.after ? this.decodeCursor(input.after, "tasks", context) : undefined;
    const limit = Math.min(Math.max(input.limit, 1), 200);
    const rows = (await this.sql`SELECT t.id, t.project_id, t.type, t.operation, t.status, t.priority,
        t.model_release_id, r.alias AS model, t.progress, t.error, t.version,
        t.created_at, t.updated_at, t.completed_at, t.expires_at
      FROM tasks t JOIN model_releases r ON r.id=t.model_release_id
      WHERE t.project_id=${context.projectId}
        AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (t.created_at, t.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? ""}))
      ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit + 1}`) as readonly Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(jsonRecord);
    const lastRow = rows[Math.min(limit, rows.length) - 1];
    return {
      object: "list",
      data: page,
      has_more: hasMore,
      next_after:
        hasMore && lastRow
          ? this.encodeCursor(
              "tasks",
              context,
              new Date(lastRow.created_at as Date | string).toISOString(),
              String(lastRow.id),
            )
          : null,
    };
  }

  async taskDetail(context: AdminQueryContext, taskId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await this.sql`SELECT t.id, t.project_id, t.type, t.operation, t.status, t.priority,
        t.model_release_id, r.alias AS model, t.request_hash, t.progress, t.output, t.error,
        t.version, t.created_at, t.updated_at, t.completed_at, t.expires_at
      FROM tasks t JOIN model_releases r ON r.id=t.model_release_id
      WHERE t.id=${taskId} AND t.project_id=${context.projectId}`;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const [events, attempts, files] = await Promise.all([
      this.sql`SELECT id, from_status, to_status, reason, version, created_at
        FROM task_state_events WHERE task_id=${taskId} ORDER BY created_at, id`,
      this.sql`SELECT a.id, a.release_id, a.status, a.error, a.attempt_no, a.pool_id,
          a.replica_id, a.slot_index, a.decision_id, a.task_version_at_assignment,
          a.reservation_expires_at, a.created_at, a.updated_at, a.started_at, a.completed_at,
          l.id AS lease_id, l.worker_id, l.expires_at AS lease_expires_at, l.version AS lease_version,
          l.status AS lease_status, l.heartbeat_at AS lease_heartbeat_at,
          d.replica_version, d.policy_version, d.reason AS scheduling_reason,
          d.input_snapshot AS scheduling_snapshot, d.decided_at
        FROM attempts a LEFT JOIN leases l ON l.attempt_id=a.id
        LEFT JOIN scheduling_decisions d ON d.id=a.decision_id
        WHERE a.task_id=${taskId} ORDER BY a.created_at, a.id`,
      this.sql`SELECT tf.direction, tf.role, tf.ordinal, f.id AS file_id, f.content_type,
          f.size_bytes, f.sha256, f.status, f.expires_at
        FROM task_files tf JOIN files f ON f.id=tf.file_id
        WHERE tf.task_id=${taskId} ORDER BY tf.direction, tf.ordinal`,
    ]);
    return {
      ...jsonRecord(row),
      timeline: events.map((event) => jsonRecord(event as Record<string, unknown>)),
      attempts: attempts.map((attempt) => {
        const result = jsonRecord(attempt as Record<string, unknown>);
        if ("lease_expires_at" in result)
          result.lease_expires_at = result.lease_expires_at ? unix(result.lease_expires_at) : null;
        if ("reservation_expires_at" in result)
          result.reservation_expires_at = result.reservation_expires_at ? unix(result.reservation_expires_at) : null;
        if ("lease_heartbeat_at" in result)
          result.lease_heartbeat_at = result.lease_heartbeat_at ? unix(result.lease_heartbeat_at) : null;
        if ("decided_at" in result) result.decided_at = result.decided_at ? unix(result.decided_at) : null;
        return result;
      }),
      files: files.map((file) => jsonRecord(file as Record<string, unknown>)),
    };
  }

  async costSummary(context: AdminQueryContext): Promise<Record<string, unknown>> {
    const rows = await this.sql`SELECT metric, COALESCE(sum(quantity), 0)::bigint AS quantity,
        max(currency) AS currency FROM usage_ledger
      WHERE organization_id=${context.organizationId} AND project_id=${context.projectId}
        AND occurred_at >= date_trunc('day', now())
      GROUP BY metric ORDER BY metric`;
    return {
      object: "cost.summary",
      project_id: context.projectId,
      period_start: Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000),
      metrics: rows.map((row) => ({
        metric: String(row.metric),
        quantity: Number(row.quantity),
        currency: row.currency === null ? null : String(row.currency),
      })),
    };
  }
}
