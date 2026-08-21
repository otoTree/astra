import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { RedisQueueCandidate } from "@astra/database";
import { RedisCandidateIndex } from "@astra/queue";
import { RedisRebuildCoordinator, type RedisRebuildRepository } from "./relay.ts";

const redisUrl = process.env.ASTRA_TEST_REDIS_URL;
const integrationTest = redisUrl ? test : test.skip;
const namespace = `astra:test:rebuild:${randomUUID()}`;
const index = redisUrl ? new RedisCandidateIndex(redisUrl, namespace) : undefined;
const generations = new Set<string>();

afterAll(async () => {
  if (!index) return;
  for (const generation of generations) await index.deleteGeneration(generation);
  await index.close();
});

describe("RedisRebuildCoordinator Cluster recovery", () => {
  integrationTest("restores candidates into a new generation after complete namespace loss", async () => {
    if (!index) throw new Error("test_redis_unavailable");
    const candidate: RedisQueueCandidate = {
      taskId: `task_${randomUUID()}`,
      projectId: `project_${randomUUID()}`,
      releaseId: `release_${randomUUID()}`,
      lane: "online",
      taskVersion: 4,
      createdAt: "2026-08-21T00:00:00.000Z",
    };
    let scanStarts = 0;
    const repository: RedisRebuildRepository = {
      redisIndexState: async () => ({ schedulerMode: "queue_rebuilding" }),
      taskQueueState: async () => ({ releaseId: candidate.releaseId, candidate }),
      startRedisRebuild: async () => {
        scanStarts += 1;
        return { watermarkCreatedAt: null, watermarkId: null };
      },
      scanQueuedTasks: async (after) => (after ? [] : [candidate]),
      renewRedisRebuild: async () => undefined,
      outboxWatermark: async () => undefined,
      changedTaskEventsBetween: async () => [],
      queuedTaskCount: async () => 1,
      taskEventCountAfter: async () => 0,
      finishRedisRebuild: async () => undefined,
      failRedisRebuild: async () => undefined,
    };
    const firstGeneration = `generation_${randomUUID()}`;
    generations.add(firstGeneration);
    const first = new RedisRebuildCoordinator(repository, index, "relay_recovery", 100, 900, () => firstGeneration);
    expect((await first.rebuild()).status).toBe("completed");
    expect(await index.candidate(firstGeneration, candidate.releaseId, candidate.taskId)).toEqual(candidate);

    await index.deleteGeneration(firstGeneration);
    expect(await index.activeGeneration()).toBeUndefined();
    const secondGeneration = `generation_${randomUUID()}`;
    generations.add(secondGeneration);
    const second = new RedisRebuildCoordinator(repository, index, "relay_recovery", 100, 900, () => secondGeneration);
    expect((await second.rebuild()).status).toBe("completed");
    expect(await index.activeGeneration()).toBe(secondGeneration);
    expect(await index.candidate(secondGeneration, candidate.releaseId, candidate.taskId)).toEqual(candidate);
    expect(scanStarts).toBe(2);
  });
});
