import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@astra/contracts";
import postgres from "postgres";
import { EventRepository } from "./event-repository.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const schemaName = `event_test_${randomUUID().replaceAll("-", "")}`;
const sql = databaseUrl ? postgres(databaseUrl, { prepare: false, max: 1, onnotice: () => undefined }) : undefined;

beforeAll(async () => {
  if (!sql) return;
  await sql`CREATE SCHEMA ${sql(schemaName)}`;
  await sql`SET search_path TO ${sql(schemaName)}`;
  const directory = resolve(import.meta.dir, "../drizzle");
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) await sql.unsafe(await Bun.file(resolve(directory, migration)).text());
});

afterAll(async () => {
  if (!sql) return;
  await sql`SET search_path TO public`;
  await sql`DROP SCHEMA ${sql(schemaName)} CASCADE`;
  await sql.end();
});

const insertEvent = async (
  id: string,
  aggregateId: string,
  aggregateVersion: number,
  createdAt: string,
): Promise<void> => {
  if (!sql) throw new Error("test_database_unavailable");
  await sql`INSERT INTO outbox_events (
    id, aggregate_type, aggregate_id, aggregate_version, event_type, trace_id, payload, created_at
  ) VALUES (
    ${id}, 'generation_task', ${aggregateId}, ${aggregateVersion}, 'task.queued',
    ${`trace_${id}`}, ${JSON.stringify({ task_id: aggregateId })}, ${createdAt}
  )`;
  await sql`UPDATE event_relay_deliveries SET next_attempt_at=${createdAt} WHERE event_id=${id}`;
};

const removeEvents = async (eventIds: readonly string[]): Promise<void> => {
  if (!sql) return;
  const ids = [...eventIds];
  await sql`DELETE FROM event_dead_letters WHERE event_id=ANY(${sql.array(ids)}::text[])`;
  await sql`DELETE FROM event_relay_deliveries WHERE event_id=ANY(${sql.array(ids)}::text[])`;
  await sql`DELETE FROM outbox_events WHERE id=ANY(${sql.array(ids)}::text[])`;
};

describe("EventRepository PostgreSQL integration", () => {
  integrationTest("serializes Kafka delivery by aggregate while allowing concurrent relay claims", async () => {
    if (!sql) throw new Error("test_database_unavailable");
    const eventIds = [`evt_order_a_${randomUUID()}`, `evt_order_b_${randomUUID()}`] as const;
    const aggregateId = `task_order_${randomUUID()}`;
    await insertEvent(eventIds[0], aggregateId, 1, "2020-01-01T00:00:00.000Z");
    await insertEvent(eventIds[1], aggregateId, 2, "2020-01-01T00:00:01.000Z");
    const repository = new EventRepository(sql, () => new Date("2020-01-01T00:01:00.000Z"));

    const [left, right] = await Promise.all([
      repository.claim("kafka", "relay_left", 10, 30),
      repository.claim("kafka", "relay_right", 10, 30),
    ]);
    const eventIdSet = new Set<string>(eventIds);
    const orderedClaims = [...left, ...right].filter((item) => eventIdSet.has(item.envelope.event_id));
    expect(orderedClaims).toHaveLength(1);
    const firstClaim = orderedClaims[0];
    if (!firstClaim) throw new Error("ordered_claim_missing");
    expect(firstClaim.envelope.event_id).toBe(eventIds[0]);
    expect(await repository.delivered(firstClaim, { partition: 0, offset: "1" })).toBe(true);

    const next = await repository.claim("kafka", "relay_next", 10, 30);
    expect(next.find((item) => item.envelope.event_id === eventIds[1])?.envelope.aggregate_version).toBe(2);
    await removeEvents(eventIds);
  });

  integrationTest("reclaims expired leases and sends exhausted deliveries to replayable dead letter", async () => {
    if (!sql) throw new Error("test_database_unavailable");
    const eventId = `evt_retry_${randomUUID()}`;
    await insertEvent(eventId, `task_retry_${randomUUID()}`, 1, "2020-01-02T00:00:00.000Z");
    let clock = new Date("2020-01-02T00:00:10.000Z");
    const repository = new EventRepository(sql, () => new Date(clock));
    const first = (await repository.claim("redis", "relay_first", 1, 5))[0];
    expect(first?.envelope.event_id).toBe(eventId);

    clock = new Date("2020-01-02T00:00:16.000Z");
    const reclaimed = (await repository.claim("redis", "relay_second", 1, 5))[0];
    if (!reclaimed) throw new Error("expired_lease_not_reclaimed");
    expect(reclaimed.envelope.event_id).toBe(eventId);
    expect(await repository.failed(reclaimed, "redis_unavailable", true, 2)).toBe("dead_letter");
    const deadLetters = await sql`SELECT id FROM event_dead_letters WHERE event_id=${eventId}`;
    expect(deadLetters).toHaveLength(1);
    expect(await repository.replayDeadLetter(String(deadLetters[0]?.id))).toBe(true);
    expect((await repository.claim("redis", "relay_replay", 1, 5))[0]?.envelope.event_id).toBe(eventId);
    await removeEvents([eventId]);
  });

  integrationTest("deduplicates consumers transactionally and rejects payload conflicts", async () => {
    if (!sql) throw new Error("test_database_unavailable");
    const repository = new EventRepository(sql);
    const eventId = `evt_consumer_${randomUUID()}`;
    const currentEvent: EventEnvelope = {
      event_id: eventId,
      event_type: "task.queued",
      event_version: 1,
      producer: "consumer-integration",
      aggregate_type: "generation_task",
      aggregate_id: `task_${randomUUID()}`,
      aggregate_version: 0,
      occurred_at: "2026-08-21T00:00:00.000Z",
      trace_id: "trace_consumer",
      payload: { value: 1 },
    };
    let executions = 0;
    expect(
      await repository.processOnce("consumer_integration", currentEvent, async () => {
        executions += 1;
      }),
    ).toBe("processed");
    expect(
      await repository.processOnce("consumer_integration", currentEvent, async () => {
        executions += 1;
      }),
    ).toBe("duplicate");
    expect(executions).toBe(1);
    expect(
      await repository.processOnce("consumer_integration", { ...currentEvent, payload: { value: 1 } }, async () => {
        executions += 1;
      }),
    ).toBe("duplicate");
    expect(executions).toBe(1);
    await expect(
      repository.processOnce("consumer_integration", { ...currentEvent, payload: { value: 2 } }, async () => undefined),
    ).rejects.toThrow("event_payload_conflict");
  });
});
