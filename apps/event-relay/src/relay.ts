import { eventEnvelopeSchema, type EventEnvelope } from "@astra/contracts";
import type {
  ClaimedEvent,
  EventPosition,
  EventRepository,
  EventSink,
  RedisQueueCandidate,
  RedisTaskQueueState,
} from "@astra/database";
import { type Admin, Kafka, logLevel, type Producer } from "kafkajs";

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

export type KafkaTopicMap = Readonly<{
  task: string;
  capacity: string;
  usage: string;
  audit: string;
  control: string;
}>;

const topicFor = (eventType: string, topics: KafkaTopicMap): string => {
  if (eventType.startsWith("task.")) return topics.task;
  if (eventType.startsWith("capacity.") || eventType.startsWith("replica.")) return topics.capacity;
  if (eventType.startsWith("usage.") || eventType.startsWith("cost.")) return topics.usage;
  if (eventType.startsWith("audit.")) return topics.audit;
  return topics.control;
};

export class KafkaEventPublisher implements EventPublisher {
  readonly sink = "kafka" as const;
  private readonly producer: Producer;
  private readonly admin: Admin;
  private connected = false;
  private connecting: Promise<void> | undefined;

  constructor(
    clientId: string,
    brokers: readonly string[],
    private readonly topics: KafkaTopicMap,
  ) {
    const kafka = new Kafka({
      clientId,
      brokers: [...brokers],
      logLevel: logLevel.NOTHING,
      retry: { initialRetryTime: 300, retries: 8 },
    });
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 });
    this.admin = kafka.admin();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connecting ??= Promise.all([this.producer.connect(), this.admin.connect()]).then(() => {
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
      const metadata = await this.producer.send({
        topic: topicFor(event.event_type, this.topics),
        acks: -1,
        timeout: 30_000,
        messages: [
          {
            key: event.aggregate_id,
            value: JSON.stringify(event),
            headers: {
              event_id: event.event_id,
              event_type: event.event_type,
              event_version: String(event.event_version),
              trace_id: event.trace_id,
            },
          },
        ],
      });
      const destination = metadata[0];
      return {
        topic: destination?.topicName ?? topicFor(event.event_type, this.topics),
        partition: destination?.partition ?? -1,
        offset: destination?.baseOffset ?? "unknown",
      };
    } catch {
      throw new RelayDeliveryError("kafka_publish_failed", true);
    }
  }

  async ready(): Promise<boolean> {
    try {
      if (!this.connected) await this.connect();
      await this.admin.fetchTopicMetadata({ topics: [this.topics.task] });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.producer.disconnect(), this.admin.disconnect()]);
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
