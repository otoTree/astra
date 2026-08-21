import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@astra/contracts";
import type { ClaimedEvent, RedisQueueCandidate } from "@astra/database";
import {
  type CandidateIndex,
  type EventPublisher,
  OutboxRelay,
  RedisEventPublisher,
  RedisRebuildCoordinator,
  RelayDeliveryError,
  type RelayEventRepository,
  type RedisEventRepository,
  type RedisRebuildRepository,
} from "./relay.ts";

const event: EventEnvelope = {
  event_id: "evt_001",
  event_type: "task.queued",
  event_version: 1,
  producer: "astra-control-plane",
  aggregate_type: "generation_task",
  aggregate_id: "task_001",
  aggregate_version: 1,
  occurred_at: "2026-08-21T00:00:00.000Z",
  trace_id: "req_001",
  payload: { task_id: "task_001" },
};

const claim: ClaimedEvent = { envelope: event, sink: "kafka", attemptCount: 1, leaseOwner: "relay_001" };

const idlePublisher = (sink: "kafka" | "redis"): EventPublisher => ({
  sink,
  publish: async () => ({ accepted: true }),
  ready: async () => true,
  close: async () => undefined,
});

describe("OutboxRelay", () => {
  test("marks a claim delivered only after the publisher succeeds", async () => {
    let deliveredEventId: string | undefined;
    const repository: RelayEventRepository = {
      claim: async () => [claim],
      delivered: async (current) => {
        deliveredEventId = current.envelope.event_id;
        return true;
      },
      failed: async () => {
        throw new Error("failure_path_not_expected");
      },
    };
    const relay = new OutboxRelay(
      repository,
      { kafka: idlePublisher("kafka"), redis: idlePublisher("redis") },
      "relay_001",
      10,
      30,
      5,
    );

    expect(await relay.runOnce("kafka")).toEqual({
      claimed: 1,
      delivered: 1,
      retrying: 0,
      deadLettered: 0,
      staleLeases: 0,
    });
    expect(deliveredEventId).toBe("evt_001");
  });

  test("classifies retryable delivery errors without acknowledging the claim", async () => {
    let failure: Readonly<{ code: string; retryable: boolean }> | undefined;
    const repository: RelayEventRepository = {
      claim: async () => [claim],
      delivered: async () => {
        throw new Error("delivery_path_not_expected");
      },
      failed: async (_current, code, retryable) => {
        failure = { code, retryable };
        return "retry_wait";
      },
    };
    const publisher: EventPublisher = {
      ...idlePublisher("kafka"),
      publish: async () => {
        throw new RelayDeliveryError("kafka_publish_failed", true);
      },
    };
    const relay = new OutboxRelay(
      repository,
      { kafka: publisher, redis: idlePublisher("redis") },
      "relay_001",
      10,
      30,
      5,
    );

    expect((await relay.runOnce("kafka")).retrying).toBe(1);
    expect(failure).toEqual({ code: "kafka_publish_failed", retryable: true });
  });
});

describe("RedisEventPublisher", () => {
  const candidate: RedisQueueCandidate = {
    taskId: "task_001",
    projectId: "project_001",
    releaseId: "release_001",
    lane: "online",
    taskVersion: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
  };

  test("does not acknowledge queue events while a generation is rebuilding", async () => {
    const repository: RedisEventRepository = {
      redisIndexState: async () => ({ schedulerMode: "queue_rebuilding" }),
      taskQueueState: async () => ({ releaseId: "release_001", candidate }),
    };
    let writes = 0;
    const index: CandidateIndex = {
      put: async () => {
        writes += 1;
      },
      remove: async () => undefined,
      switchGeneration: async () => undefined,
      count: async () => 0,
      ready: async () => true,
      close: async () => undefined,
    };

    await expect(new RedisEventPublisher(repository, index).publish(event)).rejects.toThrow("redis_queue_rebuilding");
    expect(writes).toBe(0);
  });

  test("converges queued and terminal task state idempotently", async () => {
    let queued = true;
    let writes = 0;
    let removals = 0;
    const repository: RedisEventRepository = {
      redisIndexState: async () => ({ schedulerMode: "ready", activeGenerationId: "generation_001" }),
      taskQueueState: async () => ({
        releaseId: "release_001",
        ...(queued ? { candidate } : {}),
      }),
    };
    const index: CandidateIndex = {
      put: async () => {
        writes += 1;
      },
      remove: async () => {
        removals += 1;
      },
      switchGeneration: async () => undefined,
      count: async () => 0,
      ready: async () => true,
      close: async () => undefined,
    };
    const publisher = new RedisEventPublisher(repository, index);

    await publisher.publish(event);
    await publisher.publish(event);
    queued = false;
    await publisher.publish({ ...event, event_type: "task.canceled", aggregate_version: 2 });
    expect({ writes, removals }).toEqual({ writes: 2, removals: 1 });
  });
});

describe("RedisRebuildCoordinator", () => {
  test("builds, validates and switches an isolated generation", async () => {
    const candidates: RedisQueueCandidate[] = [
      {
        taskId: "task_001",
        projectId: "project_001",
        releaseId: "release_001",
        lane: "online",
        taskVersion: 0,
        createdAt: "2026-08-21T00:00:00.000Z",
      },
      {
        taskId: "task_002",
        projectId: "project_001",
        releaseId: "release_001",
        lane: "batch",
        taskVersion: 0,
        createdAt: "2026-08-21T00:00:01.000Z",
      },
    ];
    let scanCalls = 0;
    let completed = false;
    const repository: RedisRebuildRepository = {
      redisIndexState: async () => ({ schedulerMode: "queue_rebuilding" }),
      taskQueueState: async () => undefined,
      startRedisRebuild: async () => ({ watermarkCreatedAt: null, watermarkId: null }),
      scanQueuedTasks: async () => {
        scanCalls += 1;
        return scanCalls === 1 ? candidates : [];
      },
      renewRedisRebuild: async () => undefined,
      outboxWatermark: async () => undefined,
      changedTaskEventsBetween: async () => [],
      queuedTaskCount: async () => 2,
      taskEventCountAfter: async () => 0,
      finishRedisRebuild: async () => {
        completed = true;
      },
      failRedisRebuild: async () => {
        throw new Error("failure_path_not_expected");
      },
    };
    const indexed = new Set<string>();
    let activeGeneration: string | undefined;
    const index: CandidateIndex = {
      put: async (_generation, current) => {
        indexed.add(current.taskId);
      },
      remove: async () => undefined,
      switchGeneration: async (generation) => {
        activeGeneration = generation;
      },
      count: async () => indexed.size,
      ready: async () => true,
      close: async () => undefined,
    };
    const coordinator = new RedisRebuildCoordinator(repository, index, "relay_001", 100, 900, () => "generation_001");

    expect(await coordinator.rebuild()).toEqual({
      status: "completed",
      generationId: "generation_001",
      scannedTasks: 2,
      indexedTasks: 2,
    });
    expect(activeGeneration).toBe("generation_001");
    expect(completed).toBe(true);
  });
});
