import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RedisCandidateIndex } from "./index.ts";

const redisUrl = process.env.ASTRA_TEST_REDIS_URL;
const integrationTest = redisUrl ? test : test.skip;
const namespace = `astra:test:${randomUUID()}`;
const index = redisUrl ? new RedisCandidateIndex(redisUrl, namespace) : undefined;
const generations = new Set<string>();

afterAll(async () => {
  if (!index) return;
  for (const generation of generations) await index.deleteGeneration(generation);
  await index.close();
});

describe("RedisCandidateIndex Cluster integration", () => {
  integrationTest("keeps duplicate queue events idempotent and removes terminal tasks", async () => {
    if (!index) throw new Error("test_redis_unavailable");
    const generation = `generation_${randomUUID()}`;
    generations.add(generation);
    const candidate = {
      taskId: `task_${randomUUID()}`,
      projectId: `project_${randomUUID()}`,
      releaseId: `release_${randomUUID()}`,
      lane: "online" as const,
      taskVersion: 3,
      createdAt: "2026-08-21T00:00:00.000Z",
    };

    await index.put(generation, candidate);
    await index.put(generation, candidate);
    expect(await index.count(generation)).toBe(1);
    expect(await index.candidate(generation, candidate.releaseId, candidate.taskId)).toEqual(candidate);

    await index.remove(generation, candidate.taskId, candidate.releaseId);
    await index.remove(generation, candidate.taskId, candidate.releaseId);
    expect(await index.count(generation)).toBe(0);
  });

  integrationTest("switches the active generation through a dedicated pointer", async () => {
    if (!index) throw new Error("test_redis_unavailable");
    const generation = `generation_${randomUUID()}`;
    generations.add(generation);
    await index.switchGeneration(generation);
    expect(await index.activeGeneration()).toBe(generation);
  });
});
