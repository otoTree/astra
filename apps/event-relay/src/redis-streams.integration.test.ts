import { afterAll, describe, expect, test } from "bun:test";
import { createRedisCommandClient, type RedisCommandClient, type RedisDeploymentMode } from "@astra/queue";
import { RedisStreamsEventPublisher } from "./relay.ts";

const rootUrl = process.env.ASTRA_TEST_REDIS_URL;
const redisMode: RedisDeploymentMode = process.env.ASTRA_TEST_REDIS_MODE === "standalone" ? "standalone" : "cluster";
const integrationTest = rootUrl ? test : test.skip;
let client: RedisCommandClient | undefined;
let publisher: RedisStreamsEventPublisher | undefined;
let taskStream: string | undefined;

afterAll(async () => {
  if (client && taskStream) await client.del(taskStream);
  await Promise.allSettled([publisher?.close(), client?.close()]);
});

describe("RedisStreamsEventPublisher integration", () => {
  integrationTest("appends an event to a Redis Stream", async () => {
    if (!rootUrl) throw new Error("test_redis_unavailable");
    const suffix = `integration_${Date.now()}`;
    taskStream = `astra:{events}:${suffix}:task:v1`;
    client = createRedisCommandClient(rootUrl, redisMode);
    await client.connect();
    publisher = new RedisStreamsEventPublisher(
      rootUrl,
      {
        task: taskStream,
        capacity: `astra:{events}:${suffix}:capacity:v1`,
        usage: `astra:{events}:${suffix}:usage:v1`,
        audit: `astra:{events}:${suffix}:audit:v1`,
        control: `astra:{events}:${suffix}:control:v1`,
      },
      1000,
      3600,
      redisMode,
    );
    await publisher.connect();
    const streamId = await publisher.publish({
      event_id: `evt_${suffix}`,
      event_type: "task.queued",
      event_version: 1,
      producer: "astra-event-relay-integration",
      aggregate_type: "generation_task",
      aggregate_id: `task_${suffix}`,
      aggregate_version: 1,
      occurred_at: new Date().toISOString(),
      trace_id: `trace_${suffix}`,
      payload: { task_id: `task_${suffix}` },
    });
    expect(typeof streamId.stream_id).toBe("string");
    expect(await client.xLen(taskStream)).toBe(1);
  });
});
