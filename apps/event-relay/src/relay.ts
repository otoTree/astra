import { eventEnvelopeSchema, type EventEnvelope } from "@astra/contracts";
import type {
  ClaimedEvent,
  EventPosition,
  EventRepository,
  EventSink,
  RedisQueueCandidate,
  RedisTaskQueueState,
} from "@astra/database";
import { createCluster, type RedisClusterType } from "redis";

export type EventPublishResult = Readonly<Record<string, string | number | boolean>>;

export interface EventPublisher {
  readonly sink: EventSink;
  publish(event: EventEnvelope): Promise<EventPublishResult>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export interface RelayEventRepository {
  claim(sink: EventSink, leaseOwner: string, limit: number, leaseSeconds: number): Promise<readonly ClaimedEvent[]>;
  delivered(claim: ClaimedEvent, metadata: Record<string, unknown>): Promise<boolean>;
  failed(
    claim: ClaimedEvent,
    errorCode: string,
    retryable: boolean,
    maximumAttempts: number,
  ): Promise<"retry_wait" | "dead_letter" | "stale_lease">;
}

export interface RedisEventRepository {
  redisIndexState(): Promise<
    Readonly<{
      activeGenerationId?: string;
      buildingGenerationId?: string;
      schedulerMode: "ready" | "queue_rebuilding";
    }>
  >;
  taskQueueState(taskId: string): Promise<RedisTaskQueueState | undefined>;
}

export interface RedisRebuildRepository extends RedisEventRepository {
  startRedisRebuild(
    generationId: string,
    leaseOwner: string,
    leaseSeconds: number,
  ): Promise<Readonly<{ watermarkCreatedAt: string | null; watermarkId: string | null }> | undefined>;
  scanQueuedTasks(after: EventPosition | undefined, limit: number): Promise<readonly RedisQueueCandidate[]>;
  renewRedisRebuild(
    generationId: string,
    leaseOwner: string,
    leaseSeconds: number,
    scannedTasks: number,
    indexedTasks: number,
  ): Promise<void>;
  outboxWatermark(): Promise<EventPosition | undefined>;
  changedTaskEventsBetween(
    lower: EventPosition | undefined,
    upper: EventPosition | undefined,
    after: EventPosition | undefined,
    limit: number,
  ): ReturnType<EventRepository["changedTaskEventsBetween"]>;
  queuedTaskCount(): Promise<number>;
  taskEventCountAfter(position: EventPosition | undefined): Promise<number>;
  finishRedisRebuild(
    generationId: string,
    leaseOwner: string,
    scannedTasks: number,
    indexedTasks: number,
    validation: Record<string, unknown>,
  ): Promise<void>;
  failRedisRebuild(generationId: string, leaseOwner: string, failureCode: string): Promise<void>;
}

export interface CandidateIndex {
  put(generation: string, candidate: RedisQueueCandidate): Promise<void>;
  remove(generation: string, taskId: string, releaseId: string): Promise<void>;
  switchGeneration(generation: string): Promise<void>;
  count(generation: string): Promise<number>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export class RelayDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export type RedisStreamMap = Readonly<{
  task: string;
  capacity: string;
  usage: string;
  audit: string;
  control: string;
}>;

const streamFor = (eventType: string, streams: RedisStreamMap): string => {
  if (eventType.startsWith("task.")) return streams.task;
  if (eventType.startsWith("capacity.") || eventType.startsWith("replica.")) return streams.capacity;
  if (eventType.startsWith("usage.") || eventType.startsWith("cost.")) return streams.usage;
  if (eventType.startsWith("audit.")) return streams.audit;
  return streams.control;
};

/**
 * Redis Streams is the durable event fan-out boundary. PostgreSQL Outbox remains
 * authoritative; this publisher only appends and returns the stream entry ID.
 */
export class RedisStreamsEventPublisher implements EventPublisher {
  readonly sink = "redis_streams" as const;
  private readonly client: RedisClusterType;
  private connected = false;
  private connecting: Promise<void> | undefined;

  constructor(
    rootUrl: string,
    private readonly streams: RedisStreamMap,
    private readonly maximumLength = 100_000,
    private readonly retentionSeconds = 604_800,
  ) {
    if (!Number.isInteger(maximumLength) || maximumLength < 1) throw new Error("invalid_redis_stream_max_length");
    if (!Number.isInteger(retentionSeconds) || retentionSeconds < 60) throw new Error("invalid_redis_stream_retention");
    this.client = createCluster({ rootNodes: [{ url: rootUrl }] });
    this.client.on("error", () => undefined);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connecting ??= this.client.connect().then(() => {
      this.connected = true;
    });
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async publish(input: EventEnvelope): Promise<EventPublishResult> {
    const event = eventEnvelopeSchema.parse(input);
    if (!this.connected) await this.connect();
    try {
      const stream = streamFor(event.event_type, this.streams);
      const streamId = await this.client.xAdd(
        stream,
        "*",
        {
          event_id: event.event_id,
          event_type: event.event_type,
          event_version: String(event.event_version),
          producer: event.producer,
          aggregate_type: event.aggregate_type,
          aggregate_id: event.aggregate_id,
          aggregate_version: String(event.aggregate_version),
          occurred_at: event.occurred_at,
          trace_id: event.trace_id,
          payload_json: JSON.stringify(event.payload),
        },
        {
          TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maximumLength },
        },
      );
      // Time-based retention is deliberately best effort. A stream length cap
      // is the hard bound, while this trim keeps idle streams from retaining
      // old entries forever when the cap is not reached.
      try {
        await this.client.xTrim(stream, "MINID", `${Date.now() - this.retentionSeconds * 1000}-0`, {
          strategyModifier: "~",
        });
      } catch {
        // XADD already applied the hard MAXLEN bound. Time trimming is a
        // best-effort optimization and must not cause a duplicate retry.
      }
      return {
        stream,
        stream_id: streamId,
      };
    } catch {
      throw new RelayDeliveryError("redis_stream_publish_failed", true);
    }
  }

  async ready(): Promise<boolean> {
    try {
      if (!this.connected) await this.connect();
      await this.client.xLen(this.streams.task);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.connected) await this.client.close();
    this.connected = false;
  }
}

export class RedisEventPublisher implements EventPublisher {
  readonly sink = "redis" as const;

  constructor(
    private readonly repository: RedisEventRepository,
    private readonly index: CandidateIndex,
  ) {}

  async publish(event: EventEnvelope): Promise<EventPublishResult> {
    eventEnvelopeSchema.parse(event);
    if (event.aggregate_type !== "generation_task") return { indexed: false, reason: "not_queue_event" };
    const state = await this.repository.redisIndexState();
    if (state.schedulerMode !== "ready" || !state.activeGenerationId) {
      throw new RelayDeliveryError("redis_queue_rebuilding", true);
    }
    const task = await this.repository.taskQueueState(event.aggregate_id);
    if (!task) return { indexed: false, reason: "task_not_found" };
    if (task.candidate) await this.index.put(state.activeGenerationId, task.candidate);
    else await this.index.remove(state.activeGenerationId, event.aggregate_id, task.releaseId);
    return {
      indexed: Boolean(task.candidate),
      generation: state.activeGenerationId,
      task_version: task.candidate?.taskVersion ?? event.aggregate_version,
    };
  }

  ready(): Promise<boolean> {
    return this.index.ready();
  }

  close(): Promise<void> {
    return this.index.close();
  }
}

export type RelayRunResult = Readonly<{
  claimed: number;
  delivered: number;
  retrying: number;
  deadLettered: number;
  staleLeases: number;
}>;

export class OutboxRelay {
  constructor(
    private readonly repository: RelayEventRepository,
    private readonly publishers: Readonly<Record<EventSink, EventPublisher>>,
    private readonly leaseOwner: string,
    private readonly batchSize: number,
    private readonly leaseSeconds: number,
    private readonly maximumAttempts: number,
  ) {}

  async runOnce(sink: EventSink): Promise<RelayRunResult> {
    const claims = await this.repository.claim(sink, this.leaseOwner, this.batchSize, this.leaseSeconds);
    let delivered = 0;
    let retrying = 0;
    let deadLettered = 0;
    let staleLeases = 0;
    for (const claim of claims) {
      try {
        const metadata = await this.publishers[sink].publish(claim.envelope);
        if (await this.repository.delivered(claim, metadata)) delivered += 1;
        else staleLeases += 1;
      } catch (error) {
        const failure = classifyDeliveryError(error);
        const outcome = await this.repository.failed(claim, failure.code, failure.retryable, this.maximumAttempts);
        if (outcome === "retry_wait") retrying += 1;
        else if (outcome === "dead_letter") deadLettered += 1;
        else staleLeases += 1;
      }
    }
    return { claimed: claims.length, delivered, retrying, deadLettered, staleLeases };
  }
}

const classifyDeliveryError = (error: unknown): RelayDeliveryError => {
  if (error instanceof RelayDeliveryError) return error;
  if (error instanceof Error && error.name === "ZodError")
    return new RelayDeliveryError("invalid_event_envelope", false);
  return new RelayDeliveryError("event_delivery_failed", true);
};

export type RedisRebuildResult = Readonly<{
  status: "completed" | "already_running";
  generationId?: string;
  scannedTasks: number;
  indexedTasks: number;
}>;

export class RedisRebuildCoordinator {
  constructor(
    private readonly repository: RedisRebuildRepository,
    private readonly index: CandidateIndex,
    private readonly leaseOwner: string,
    private readonly batchSize: number,
    private readonly leaseSeconds: number,
    private readonly createId: () => string = () => `queuegen_${Bun.randomUUIDv7()}`,
  ) {}

  async rebuild(): Promise<RedisRebuildResult> {
    const generationId = this.createId();
    const started = await this.repository.startRedisRebuild(generationId, this.leaseOwner, this.leaseSeconds);
    if (!started) return { status: "already_running", scannedTasks: 0, indexedTasks: 0 };
    let scannedTasks = 0;
    let indexedTasks = 0;
    try {
      let cursor: Readonly<{ createdAt: string; id: string }> | undefined;
      while (true) {
        const tasks = await this.repository.scanQueuedTasks(cursor, this.batchSize);
        if (tasks.length === 0) break;
        for (const candidate of tasks) {
          await this.index.put(generationId, candidate);
          indexedTasks += 1;
        }
        scannedTasks += tasks.length;
        const last = tasks.at(-1);
        if (!last) throw new RelayDeliveryError("redis_rebuild_cursor_missing", false);
        cursor = { createdAt: last.createdAt, id: last.taskId };
        await this.repository.renewRedisRebuild(
          generationId,
          this.leaseOwner,
          this.leaseSeconds,
          scannedTasks,
          indexedTasks,
        );
      }

      const replayUpper = await this.repository.outboxWatermark();
      let changedAfter:
        | Readonly<{
            createdAt: string;
            id: string;
          }>
        | undefined;
      while (true) {
        const changes = await this.repository.changedTaskEventsBetween(
          started.watermarkCreatedAt && started.watermarkId
            ? { createdAt: started.watermarkCreatedAt, id: started.watermarkId }
            : undefined,
          replayUpper,
          changedAfter,
          this.batchSize,
        );
        if (changes.length === 0) break;
        for (const change of changes) {
          const task = await this.repository.taskQueueState(change.taskId);
          if (!task) continue;
          if (task.candidate) await this.index.put(generationId, task.candidate);
          else await this.index.remove(generationId, change.taskId, task.releaseId);
        }
        const last = changes.at(-1);
        changedAfter = last ? { createdAt: last.createdAt, id: last.id } : changedAfter;
        await this.repository.renewRedisRebuild(
          generationId,
          this.leaseOwner,
          this.leaseSeconds,
          scannedTasks,
          indexedTasks,
        );
      }

      const expectedCount = await this.repository.queuedTaskCount();
      const actualCount = await this.index.count(generationId);
      const pendingAfterWatermark = await this.repository.taskEventCountAfter(replayUpper);
      if (expectedCount !== actualCount && pendingAfterWatermark === 0) {
        throw new RelayDeliveryError("redis_rebuild_count_mismatch", true);
      }
      await this.index.switchGeneration(generationId);
      await this.repository.finishRedisRebuild(generationId, this.leaseOwner, scannedTasks, actualCount, {
        expected_count: expectedCount,
        actual_count: actualCount,
        pending_events_after_watermark: pendingAfterWatermark,
        replay_watermark: replayUpper ?? null,
      });
      return { status: "completed", generationId, scannedTasks, indexedTasks: actualCount };
    } catch (error) {
      const failure = classifyDeliveryError(error);
      await this.repository.failRedisRebuild(generationId, this.leaseOwner, failure.code);
      throw failure;
    }
  }
}
