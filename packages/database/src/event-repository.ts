import { createHash } from "node:crypto";
import type postgres from "postgres";
import { eventEnvelopeSchema, type EventEnvelope } from "@astra/contracts";

type SqlClient = ReturnType<typeof postgres>;
type TransactionClient = postgres.TransactionSql;
/** Durable domain-event destinations. `redis` is the rebuildable queue index. */
export type EventSink = "redis_streams" | "redis";

export type ClaimedEvent = Readonly<{
  envelope: EventEnvelope;
  sink: EventSink;
  attemptCount: number;
  leaseOwner: string;
}>;

export type RedisQueueCandidate = Readonly<{
  taskId: string;
  projectId: string;
  releaseId: string;
  lane: "online" | "batch";
  taskVersion: number;
  createdAt: string;
}>;
export type RedisTaskQueueState = Readonly<{
  releaseId: string;
  candidate?: RedisQueueCandidate;
}>;
export type EventPosition = Readonly<{ createdAt: string; id: string }>;
export type ChangedTaskEvent = Readonly<EventPosition & { taskId: string }>;

const envelope = (row: Record<string, unknown>): EventEnvelope => ({
  event_id: String(row.id),
  event_type: String(row.event_type),
  event_version: 1,
  producer: "astra-control-plane",
  aggregate_type: String(row.aggregate_type),
  aggregate_id: String(row.aggregate_id),
  aggregate_version: Number(row.aggregate_version),
  occurred_at: new Date(row.created_at as Date | string).toISOString(),
  trace_id: String(row.trace_id),
  ...(typeof (row.payload as Record<string, unknown>).organization_id === "string"
    ? { organization_id: String((row.payload as Record<string, unknown>).organization_id) }
    : {}),
  ...(typeof (row.payload as Record<string, unknown>).project_id === "string"
    ? { project_id: String((row.payload as Record<string, unknown>).project_id) }
    : {}),
  payload: row.payload as Record<string, unknown>,
});

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export class EventRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claim(
    sink: EventSink,
    leaseOwner: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly ClaimedEvent[]> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const rows = await this.sql.begin(
      async (transaction) =>
        transaction`WITH candidates AS (
        SELECT d.event_id
        FROM event_relay_deliveries d JOIN outbox_events o ON o.id=d.event_id
        WHERE d.sink=${sink}
          AND (
            (d.status IN ('pending','retry_wait') AND d.next_attempt_at<=${now.toISOString()})
            OR (d.status='leased' AND d.lease_expires_at<=${now.toISOString()})
          )
          AND (
            d.sink <> 'redis_streams' OR NOT EXISTS (
              SELECT 1
              FROM outbox_events prior_o
              JOIN event_relay_deliveries prior_d
                ON prior_d.event_id=prior_o.id AND prior_d.sink='redis_streams'
              WHERE prior_o.aggregate_id=o.aggregate_id
                AND (prior_o.created_at, prior_o.id) < (o.created_at, o.id)
                AND prior_d.status <> 'delivered'
            )
          )
        ORDER BY o.created_at, o.id
        FOR UPDATE OF d SKIP LOCKED
        LIMIT ${Math.min(Math.max(limit, 1), 500)}
      )
      UPDATE event_relay_deliveries d SET
        status='leased', lease_owner=${leaseOwner}, lease_expires_at=${expiresAt.toISOString()},
        attempt_count=d.attempt_count+1, updated_at=${now.toISOString()}
      FROM candidates c, outbox_events o
      WHERE d.event_id=c.event_id AND d.sink=${sink} AND o.id=d.event_id
      RETURNING o.*, d.sink, d.attempt_count, d.lease_owner`,
    );
    return rows.map((row) => ({
      envelope: envelope(row as Record<string, unknown>),
      sink,
      attemptCount: Number(row.attempt_count),
      leaseOwner,
    }));
  }

  async delivered(claim: ClaimedEvent, metadata: Record<string, unknown>): Promise<boolean> {
    const deliveredAt = this.now();
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`UPDATE event_relay_deliveries SET
        status='delivered', lease_owner=NULL, lease_expires_at=NULL,
        destination_metadata=${JSON.stringify(metadata)}, delivered_at=${deliveredAt.toISOString()},
        last_error_code=NULL, updated_at=${deliveredAt.toISOString()}
        WHERE event_id=${claim.envelope.event_id} AND sink=${claim.sink}
          AND status='leased' AND lease_owner=${claim.leaseOwner}
        RETURNING event_id`;
      if (!rows[0]) return false;
      if (claim.sink === "redis_streams") {
        await transaction`UPDATE outbox_events SET published_at=COALESCE(published_at, ${deliveredAt.toISOString()})
          WHERE id=${claim.envelope.event_id}`;
      }
      return true;
    });
  }

  async failed(
    claim: ClaimedEvent,
    errorCode: string,
    retryable: boolean,
    maximumAttempts: number,
  ): Promise<"retry_wait" | "dead_letter" | "stale_lease"> {
    return this.sql.begin(async (transaction) => {
      const deadLetter = !retryable || claim.attemptCount >= maximumAttempts;
      const delaySeconds = Math.min(300, 2 ** Math.min(claim.attemptCount, 8));
      const nextAttempt = new Date(this.now().getTime() + delaySeconds * 1000);
      const rows = await transaction`UPDATE event_relay_deliveries SET
        status=${deadLetter ? "dead_letter" : "retry_wait"}, lease_owner=NULL, lease_expires_at=NULL,
        next_attempt_at=${nextAttempt.toISOString()}, last_error_code=${errorCode}, updated_at=${this.now().toISOString()}
        WHERE event_id=${claim.envelope.event_id} AND sink=${claim.sink}
          AND status='leased' AND lease_owner=${claim.leaseOwner}
        RETURNING event_id`;
      if (!rows[0]) return "stale_lease";
      if (deadLetter) {
        await transaction`INSERT INTO event_dead_letters (
          id, event_id, sink, attempt_count, error_code, payload_snapshot, created_at
        ) VALUES (
          ${`dlq_${Bun.randomUUIDv7()}`}, ${claim.envelope.event_id}, ${claim.sink}, ${claim.attemptCount},
          ${errorCode}, ${JSON.stringify(claim.envelope)}, ${this.now().toISOString()}
        )`;
      }
      return deadLetter ? "dead_letter" : "retry_wait";
    });
  }

  async replayDeadLetter(deadLetterId: string): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`UPDATE event_dead_letters SET replayed_at=${this.now().toISOString()}
        WHERE id=${deadLetterId} AND replayed_at IS NULL RETURNING event_id, sink`;
      if (!rows[0]) return false;
      await transaction`UPDATE event_relay_deliveries SET
        status='pending', attempt_count=0, next_attempt_at=${this.now().toISOString()},
        last_error_code=NULL, destination_metadata=NULL, delivered_at=NULL, updated_at=${this.now().toISOString()}
        WHERE event_id=${String(rows[0].event_id)} AND sink=${String(rows[0].sink)}`;
      return true;
    });
  }

  async backlog(): Promise<readonly Record<string, unknown>[]> {
    return this.sql`SELECT sink, status, count(*)::int AS count,
      COALESCE(EXTRACT(EPOCH FROM (${this.now().toISOString()}::timestamptz - min(o.created_at))), 0)::bigint AS oldest_age_seconds
      FROM event_relay_deliveries d JOIN outbox_events o ON o.id=d.event_id
      WHERE d.status <> 'delivered' GROUP BY sink, status ORDER BY sink, status`;
  }

  async deliveryBacklogCount(sink: EventSink): Promise<number> {
    const rows = await this.sql`SELECT count(*)::int AS count FROM event_relay_deliveries
      WHERE sink=${sink} AND status <> 'delivered'`;
    return Number(rows[0]?.count ?? 0);
  }

  async processOnce(
    consumerName: string,
    event: EventEnvelope,
    handler: (transaction: TransactionClient) => Promise<void>,
  ): Promise<"processed" | "duplicate"> {
    const validated = eventEnvelopeSchema.parse(event);
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(canonicalize(validated)))
      .digest("hex");
    return this.sql.begin(async (transaction) => {
      const inserted = await transaction`INSERT INTO event_consumer_receipts (
        consumer_name, event_id, payload_hash, processed_at
      ) VALUES (${consumerName}, ${validated.event_id}, ${payloadHash}, ${this.now().toISOString()})
      ON CONFLICT (consumer_name, event_id) DO NOTHING RETURNING event_id`;
      if (!inserted[0]) {
        const existing = await transaction`SELECT payload_hash FROM event_consumer_receipts
          WHERE consumer_name=${consumerName} AND event_id=${validated.event_id}`;
        if (String(existing[0]?.payload_hash) !== payloadHash) throw new Error("event_payload_conflict");
        return "duplicate";
      }
      await handler(transaction);
      return "processed";
    });
  }

  async taskQueueState(taskId: string): Promise<RedisTaskQueueState | undefined> {
    const rows = await this.sql`SELECT t.id, t.project_id, t.model_release_id, t.priority, t.version,
      t.created_at, t.status, EXISTS (
        SELECT 1 FROM attempts a WHERE a.task_id=t.id
          AND a.status IN ('reserved', 'leased', 'running', 'unknown')
      ) AS has_active_attempt FROM tasks t WHERE t.id=${taskId}`;
    const row = rows[0];
    if (!row) return undefined;
    const releaseId = String(row.model_release_id);
    if (row.status !== "queued" || row.has_active_attempt === true) return { releaseId };
    return {
      releaseId,
      candidate: {
        taskId: String(row.id),
        projectId: String(row.project_id),
        releaseId,
        lane: row.priority === "batch" ? "batch" : "online",
        taskVersion: Number(row.version),
        createdAt: new Date(row.created_at as Date | string).toISOString(),
      },
    };
  }

  async startRedisRebuild(
    generationId: string,
    leaseOwner: string,
    leaseSeconds: number,
  ): Promise<Readonly<{ watermarkCreatedAt: string | null; watermarkId: string | null }> | undefined> {
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT * FROM redis_index_state WHERE singleton=true FOR UPDATE`;
      const now = this.now();
      const building = await transaction`SELECT id, lease_expires_at FROM redis_index_generations
        WHERE status='building' FOR UPDATE`;
      if (building[0] && new Date(building[0].lease_expires_at as Date | string) > now) return undefined;
      if (building[0]) {
        await transaction`UPDATE redis_index_generations SET status='failed', failure_code='rebuild_lease_expired',
          completed_at=${now.toISOString()}, lease_owner=NULL, lease_expires_at=NULL
          WHERE id=${String(building[0].id)} AND status='building'`;
      }
      const watermark =
        await transaction`SELECT created_at, id FROM outbox_events ORDER BY created_at DESC, id DESC LIMIT 1`;
      const createdAt = watermark[0]?.created_at
        ? new Date(watermark[0].created_at as Date | string).toISOString()
        : null;
      const watermarkId = watermark[0]?.id ? String(watermark[0].id) : null;
      await transaction`INSERT INTO redis_index_generations (
        id, status, started_outbox_created_at, started_outbox_id, lease_owner, lease_expires_at, started_at
      ) VALUES (
        ${generationId}, 'building', ${createdAt}, ${watermarkId}, ${leaseOwner},
        ${new Date(now.getTime() + leaseSeconds * 1000).toISOString()}, ${now.toISOString()}
      )`;
      await transaction`UPDATE redis_index_state SET scheduler_mode='queue_rebuilding', version=version+1,
        updated_at=${this.now().toISOString()} WHERE singleton=true`;
      return { watermarkCreatedAt: createdAt, watermarkId };
    });
  }

  async scanQueuedTasks(after: Readonly<{ createdAt: string; id: string }> | undefined, limit: number) {
    const rows = await this.sql`SELECT t.id, t.project_id, t.model_release_id, t.priority, t.version, t.created_at
      FROM tasks t WHERE t.status='queued'
        AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id=t.id
          AND a.status IN ('reserved', 'leased', 'running', 'unknown'))
        AND (${after?.createdAt ?? null}::timestamptz IS NULL OR (t.created_at, t.id) > (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? ""}))
      ORDER BY t.created_at, t.id LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
    return rows.map((row) => ({
      taskId: String(row.id),
      projectId: String(row.project_id),
      releaseId: String(row.model_release_id),
      lane: row.priority === "batch" ? ("batch" as const) : ("online" as const),
      taskVersion: Number(row.version),
      createdAt: new Date(row.created_at as Date | string).toISOString(),
    }));
  }

  async outboxWatermark(): Promise<EventPosition | undefined> {
    const rows = await this.sql`SELECT created_at, id FROM outbox_events ORDER BY created_at DESC, id DESC LIMIT 1`;
    const row = rows[0];
    return row ? { createdAt: new Date(row.created_at as Date | string).toISOString(), id: String(row.id) } : undefined;
  }

  async changedTaskEventsBetween(
    lower: EventPosition | undefined,
    upper: EventPosition | undefined,
    after: EventPosition | undefined,
    limit: number,
  ): Promise<readonly ChangedTaskEvent[]> {
    if (!upper) return [];
    const cursor = after ?? lower;
    const rows = await this.sql`SELECT created_at, id, aggregate_id FROM outbox_events
      WHERE aggregate_type='generation_task'
        AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR
          (created_at, id) > (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? ""}))
        AND (created_at, id) <= (${upper.createdAt}::timestamptz, ${upper.id})
      ORDER BY created_at, id LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
    return rows.map((row) => ({
      createdAt: new Date(row.created_at as Date | string).toISOString(),
      id: String(row.id),
      taskId: String(row.aggregate_id),
    }));
  }

  async taskEventCountAfter(position: EventPosition | undefined): Promise<number> {
    const rows = await this.sql`SELECT count(*)::int AS count FROM outbox_events
      WHERE aggregate_type='generation_task'
        AND (${position?.createdAt ?? null}::timestamptz IS NULL OR
          (created_at, id) > (${position?.createdAt ?? null}::timestamptz, ${position?.id ?? ""}))`;
    return Number(rows[0]?.count ?? 0);
  }

  async renewRedisRebuild(
    generationId: string,
    leaseOwner: string,
    leaseSeconds: number,
    scannedTasks: number,
    indexedTasks: number,
  ): Promise<void> {
    const now = this.now();
    const rows = await this.sql`UPDATE redis_index_generations SET
      lease_expires_at=${new Date(now.getTime() + leaseSeconds * 1000).toISOString()},
      scanned_tasks=${scannedTasks}, indexed_tasks=${indexedTasks}
      WHERE id=${generationId} AND status='building' AND lease_owner=${leaseOwner}
        AND lease_expires_at>${now.toISOString()} RETURNING id`;
    if (!rows[0]) throw new Error("redis_rebuild_lease_lost");
  }

  async finishRedisRebuild(
    generationId: string,
    leaseOwner: string,
    scannedTasks: number,
    indexedTasks: number,
    validation: Record<string, unknown>,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const state =
        await transaction`SELECT active_generation_id FROM redis_index_state WHERE singleton=true FOR UPDATE`;
      const current = state[0]?.active_generation_id ? String(state[0].active_generation_id) : undefined;
      if (current)
        await transaction`UPDATE redis_index_generations SET status='retired' WHERE id=${current} AND status='active'`;
      const completed = await transaction`UPDATE redis_index_generations SET
        status='active', scanned_tasks=${scannedTasks}, indexed_tasks=${indexedTasks},
        validation=${JSON.stringify(validation)}, completed_at=${this.now().toISOString()},
        lease_owner=NULL, lease_expires_at=NULL
        WHERE id=${generationId} AND status='building' AND lease_owner=${leaseOwner} RETURNING id`;
      if (!completed[0]) throw new Error("redis_rebuild_generation_conflict");
      await transaction`UPDATE redis_index_state SET active_generation_id=${generationId}, scheduler_mode='ready',
        version=version+1, updated_at=${this.now().toISOString()} WHERE singleton=true`;
    });
  }

  async activeRedisGeneration(): Promise<string | undefined> {
    const rows = await this.sql`SELECT active_generation_id FROM redis_index_state WHERE singleton=true`;
    return rows[0]?.active_generation_id ? String(rows[0].active_generation_id) : undefined;
  }

  async redisIndexState(): Promise<
    Readonly<{
      activeGenerationId?: string;
      buildingGenerationId?: string;
      schedulerMode: "ready" | "queue_rebuilding";
    }>
  > {
    const rows = await this.sql`SELECT s.active_generation_id, s.scheduler_mode,
      (SELECT id FROM redis_index_generations WHERE status='building' LIMIT 1) AS building_generation_id
      FROM redis_index_state s WHERE s.singleton=true`;
    const row = rows[0];
    if (!row) throw new Error("redis_index_state_missing");
    return {
      ...(row.active_generation_id ? { activeGenerationId: String(row.active_generation_id) } : {}),
      ...(row.building_generation_id ? { buildingGenerationId: String(row.building_generation_id) } : {}),
      schedulerMode: String(row.scheduler_mode) === "ready" ? "ready" : "queue_rebuilding",
    };
  }

  async failRedisRebuild(generationId: string, leaseOwner: string, failureCode: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const updated = await transaction`UPDATE redis_index_generations SET
        status='failed', failure_code=${failureCode}, completed_at=${this.now().toISOString()},
        lease_owner=NULL, lease_expires_at=NULL
        WHERE id=${generationId} AND status='building' AND lease_owner=${leaseOwner} RETURNING id`;
      if (!updated[0]) return;
      await transaction`UPDATE redis_index_state SET scheduler_mode='queue_rebuilding',
        version=version+1, updated_at=${this.now().toISOString()} WHERE singleton=true`;
    });
  }

  async queuedTaskCount(): Promise<number> {
    const rows = await this.sql`SELECT count(*)::int AS count FROM tasks t WHERE t.status='queued'
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id=t.id
        AND a.status IN ('reserved', 'leased', 'running', 'unknown'))`;
    return Number(rows[0]?.count ?? 0);
  }
}
