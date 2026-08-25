import { loadEventRelayConfig } from "@astra/config";
import { createDatabase, DatabaseHealth, EventRepository, type EventSink } from "@astra/database";
import { Counter, createLogger, createMetricRegistry, Gauge, Histogram, metricResponse } from "@astra/observability";
import { RedisCandidateIndex } from "@astra/queue";
import { OutboxRelay, RedisEventPublisher, RedisRebuildCoordinator, RedisStreamsEventPublisher } from "./relay.ts";

const config = loadEventRelayConfig();
const logger = createLogger("event-relay");
const database = createDatabase(config.DATABASE_URL);
const databaseHealth = new DatabaseHealth(database.client);
const repository = new EventRepository(database.client);
const candidateIndex = new RedisCandidateIndex(config.REDIS_URL);
const instanceId = `relay_${Bun.randomUUIDv7()}`;
const redisStreamsPublisher = new RedisStreamsEventPublisher(
  config.REDIS_URL,
  {
    task: config.REDIS_EVENT_TASK_STREAM,
    capacity: config.REDIS_EVENT_CAPACITY_STREAM,
    usage: config.REDIS_EVENT_USAGE_STREAM,
    audit: config.REDIS_EVENT_AUDIT_STREAM,
    control: config.REDIS_EVENT_CONTROL_STREAM,
  },
  config.REDIS_EVENT_STREAM_MAXLEN,
  config.REDIS_EVENT_STREAM_RETENTION_SECONDS,
);
const redisPublisher = new RedisEventPublisher(repository, candidateIndex);
const relay = new OutboxRelay(
  repository,
  { redis_streams: redisStreamsPublisher, redis: redisPublisher },
  instanceId,
  config.EVENT_RELAY_BATCH_SIZE,
  config.EVENT_RELAY_LEASE_SECONDS,
  config.EVENT_RELAY_MAXIMUM_ATTEMPTS,
);
const rebuild = new RedisRebuildCoordinator(
  repository,
  candidateIndex,
  instanceId,
  config.REDIS_REBUILD_BATCH_SIZE,
  config.REDIS_REBUILD_LEASE_SECONDS,
);

const metrics = createMetricRegistry("event-relay");
const deliveryTotal = new Counter({
  name: "astra_event_relay_delivery_total",
  help: "Outbox delivery outcomes by sink",
  labelNames: ["sink", "outcome"] as const,
  registers: [metrics],
});
const deliveryDuration = new Histogram({
  name: "astra_event_relay_delivery_duration_seconds",
  help: "Outbox delivery batch duration by sink",
  labelNames: ["sink"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30],
  registers: [metrics],
});
const backlogCount = new Gauge({
  name: "astra_event_relay_backlog",
  help: "Outbox deliveries that have not reached a sink",
  labelNames: ["sink", "status"] as const,
  registers: [metrics],
});
const backlogAge = new Gauge({
  name: "astra_event_relay_oldest_age_seconds",
  help: "Age of the oldest undelivered event",
  labelNames: ["sink", "status"] as const,
  registers: [metrics],
});
const rebuildStatus = new Gauge({
  name: "astra_redis_rebuild_status",
  help: "Redis queue generation state",
  labelNames: ["status"] as const,
  registers: [metrics],
});
const rebuildTasks = new Gauge({
  name: "astra_redis_rebuild_tasks",
  help: "Tasks scanned or indexed by the latest rebuild",
  labelNames: ["kind"] as const,
  registers: [metrics],
});

const abort = new AbortController();
let redisStreamsLoopHealthy = true;
let redisLoopHealthy = true;
let rebuildHealthy = true;
let redisCountMismatchObservations = 0;

const pause = (milliseconds: number): Promise<void> => Bun.sleep(milliseconds);

const runLoop = async (sink: EventSink): Promise<void> => {
  while (!abort.signal.aborted) {
    const stopTimer = deliveryDuration.startTimer({ sink });
    try {
      const result = await relay.runOnce(sink);
      deliveryTotal.inc({ sink, outcome: "delivered" }, result.delivered);
      deliveryTotal.inc({ sink, outcome: "retry_wait" }, result.retrying);
      deliveryTotal.inc({ sink, outcome: "dead_letter" }, result.deadLettered);
      deliveryTotal.inc({ sink, outcome: "stale_lease" }, result.staleLeases);
      if (sink === "redis_streams") redisStreamsLoopHealthy = true;
      else redisLoopHealthy = true;
      if (result.claimed === 0) await pause(config.EVENT_RELAY_POLL_INTERVAL_MS);
    } catch (error) {
      if (sink === "redis_streams") redisStreamsLoopHealthy = false;
      else redisLoopHealthy = false;
      logger.error("event_delivery_loop_failed", {
        sink,
        error_code: error instanceof Error ? error.message : "event_delivery_failed",
      });
      await pause(config.EVENT_RELAY_POLL_INTERVAL_MS);
    } finally {
      stopTimer();
    }
  }
};

const refreshMetrics = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    try {
      backlogCount.reset();
      backlogAge.reset();
      for (const row of await repository.backlog()) {
        const labels = { sink: String(row.sink), status: String(row.status) };
        backlogCount.set(labels, Number(row.count));
        backlogAge.set(labels, Number(row.oldest_age_seconds));
      }
      const state = await repository.redisIndexState();
      rebuildStatus.set({ status: "ready" }, state.schedulerMode === "ready" ? 1 : 0);
      rebuildStatus.set({ status: "queue_rebuilding" }, state.schedulerMode === "queue_rebuilding" ? 1 : 0);
    } catch (error) {
      logger.error("event_metrics_refresh_failed", {
        error_code: error instanceof Error ? error.message : "metrics_refresh_failed",
      });
    }
    await pause(5_000);
  }
};

const ensureRedisIndex = async (): Promise<void> => {
  const state = await repository.redisIndexState();
  const redisGeneration = await candidateIndex.activeGeneration();
  const expectedCount = await repository.queuedTaskCount();
  const actualCount = redisGeneration ? await candidateIndex.count(redisGeneration) : -1;
  if (
    state.schedulerMode === "ready" &&
    state.activeGenerationId === redisGeneration &&
    expectedCount === actualCount
  ) {
    redisCountMismatchObservations = 0;
    return;
  }
  const pointerMismatch = state.schedulerMode !== "ready" || state.activeGenerationId !== redisGeneration;
  if (!pointerMismatch) {
    const deliveryBacklog = await repository.deliveryBacklogCount("redis");
    if (deliveryBacklog > 0) {
      redisCountMismatchObservations = 0;
      return;
    }
    redisCountMismatchObservations += 1;
    if (redisCountMismatchObservations < 2) {
      logger.warn("redis_queue_count_mismatch_observed", {
        expected_count: expectedCount,
        actual_count: actualCount,
      });
      return;
    }
  }
  const result = await rebuild.rebuild();
  if (result.status === "completed") {
    rebuildTasks.set({ kind: "scanned" }, result.scannedTasks);
    rebuildTasks.set({ kind: "indexed" }, result.indexedTasks);
    logger.info("redis_queue_rebuild_completed", {
      generation_id: result.generationId,
      scanned_tasks: result.scannedTasks,
      indexed_tasks: result.indexedTasks,
    });
    redisCountMismatchObservations = 0;
  } else {
    logger.info("redis_queue_rebuild_owned_by_peer");
  }
};

const monitorRedisIndex = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    await pause(config.REDIS_REBUILD_CHECK_INTERVAL_SECONDS * 1000);
    if (abort.signal.aborted) break;
    try {
      await ensureRedisIndex();
      rebuildHealthy = true;
    } catch (error) {
      rebuildHealthy = false;
      logger.error("redis_queue_integrity_check_failed", {
        error_code: error instanceof Error ? error.message : "redis_integrity_check_failed",
      });
    }
  }
};

await redisStreamsPublisher.connect();
try {
  await ensureRedisIndex();
} catch (error) {
  rebuildHealthy = false;
  logger.error("redis_queue_rebuild_failed", {
    error_code: error instanceof Error ? error.message : "redis_rebuild_failed",
  });
}

void runLoop("redis_streams");
void runLoop("redis");
void refreshMetrics();
void monitorRedisIndex();

const server = Bun.serve({
  port: config.EVENT_RELAY_METRICS_PORT,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health/live") return Response.json({ status: "live", component: "event-relay" });
    if (path === "/health/ready") {
      const [databaseReady, redisReady, redisStreamsReady] = await Promise.all([
        databaseHealth.ready(),
        redisPublisher.ready(),
        redisStreamsPublisher.ready(),
      ]);
      const ready =
        databaseReady &&
        redisReady &&
        redisStreamsReady &&
        redisStreamsLoopHealthy &&
        redisLoopHealthy &&
        rebuildHealthy;
      return Response.json(
        {
          status: ready ? "ready" : "not_ready",
          database: databaseReady ? "ready" : "unavailable",
          redis: redisReady ? "ready" : "unavailable",
          redis_streams: redisStreamsReady ? "ready" : "unavailable",
          delivery_loops: redisStreamsLoopHealthy && redisLoopHealthy ? "ready" : "degraded",
          redis_rebuild: rebuildHealthy ? "ready" : "failed",
        },
        { status: ready ? 200 : 503 },
      );
    }
    if (path === "/metrics") return metricResponse(metrics);
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

const shutdown = async (): Promise<void> => {
  if (abort.signal.aborted) return;
  abort.abort();
  server.stop(false);
  await Promise.allSettled([redisStreamsPublisher.close(), redisPublisher.close(), database.client.end()]);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

logger.info("event_relay_started", { port: config.EVENT_RELAY_METRICS_PORT, instance_id: instanceId });
