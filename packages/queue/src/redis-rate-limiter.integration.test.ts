import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createRedisCommandClient,
  RedisPublicApiRateLimiter,
  type RedisCommandClient,
  type RedisDeploymentMode,
} from "./index.ts";

const redisUrl = process.env.ASTRA_TEST_REDIS_URL;
const redisMode: RedisDeploymentMode = process.env.ASTRA_TEST_REDIS_MODE === "standalone" ? "standalone" : "cluster";
const integrationTest = redisUrl ? test : test.skip;
const suffix = randomUUID();
const projectId = `project_${suffix}`;
const apiKeyId = `key_${suffix}`;
const key = `astra:rate:{${projectId}}:${apiKeyId}:request`;
const limiter = redisUrl ? new RedisPublicApiRateLimiter(redisUrl, redisMode) : undefined;
let cleanup: RedisCommandClient | undefined;

afterAll(async () => {
  await limiter?.close();
  if (!redisUrl) return;
  cleanup = createRedisCommandClient(redisUrl, redisMode);
  await cleanup.connect();
  await cleanup.del(key);
  await cleanup.close();
});

describe("RedisPublicApiRateLimiter integration", () => {
  integrationTest("enforces a token bucket through the selected Redis deployment mode", async () => {
    if (!limiter) throw new Error("test_redis_unavailable");
    const context = {
      actorType: "api_key" as const,
      actorId: apiKeyId,
      apiKeyId,
      organizationId: "org_test",
      projectId,
      scopes: ["models:read"],
      ratePolicy: { requestRatePerMinute: 1, requestBurst: 1, taskRatePerMinute: 1, taskBurst: 1 },
    };
    expect((await limiter.consume(context, "request", "operation_1")).allowed).toBeTrue();
    expect((await limiter.consume(context, "request", "operation_2")).allowed).toBeFalse();
    expect(await limiter.ready()).toBeTrue();
  });
});
