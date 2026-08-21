import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@astra/contracts";
import { Kafka, logLevel, type Consumer } from "kafkajs";
import { KafkaEventPublisher } from "./relay.ts";

const brokerList = process.env.ASTRA_TEST_KAFKA_BROKERS;
const topic = process.env.ASTRA_TEST_KAFKA_TASK_TOPIC ?? "astra.task-lifecycle.v1";
const integrationTest = brokerList ? test : test.skip;
let consumer: Consumer | undefined;
let publisher: KafkaEventPublisher | undefined;

afterAll(async () => {
  await Promise.allSettled([consumer?.disconnect(), publisher?.close()]);
});

describe("KafkaEventPublisher Redpanda integration", () => {
  integrationTest("publishes valid envelopes in aggregate order with stable message keys", async () => {
    if (!brokerList) throw new Error("test_kafka_unavailable");
    const suffix = randomUUID();
    const aggregateId = `task_${suffix}`;
    const eventIds = [`evt_${suffix}_1`, `evt_${suffix}_2`];
    const kafka = new Kafka({
      clientId: `astra-event-test-${suffix}`,
      brokers: brokerList.split(",").map((item) => item.trim()),
      logLevel: logLevel.NOTHING,
    });
    consumer = kafka.consumer({ groupId: `astra-event-test-${suffix}` });
    publisher = new KafkaEventPublisher(`astra-event-publisher-${suffix}`, brokerList.split(","), {
      task: topic,
      capacity: "astra.capacity.v1",
      usage: "astra.usage.v1",
      audit: "astra.audit.v1",
      control: "astra.control.v1",
    });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    const received: Array<Readonly<{ eventId: string; key: string }>> = [];
    let complete: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const envelope = JSON.parse(message.value.toString()) as EventEnvelope;
        if (!eventIds.includes(envelope.event_id)) return;
        received.push({ eventId: envelope.event_id, key: message.key?.toString() ?? "" });
        if (received.length === eventIds.length) complete?.();
      },
    });
    await publisher.connect();
    for (const [index, eventId] of eventIds.entries()) {
      await publisher.publish({
        event_id: eventId as string,
        event_type: "task.queued",
        event_version: 1,
        producer: "astra-event-relay-integration",
        aggregate_type: "generation_task",
        aggregate_id: aggregateId,
        aggregate_version: index,
        occurred_at: new Date(Date.now() + index).toISOString(),
        trace_id: `trace_${suffix}`,
        payload: { task_id: aggregateId },
      });
    }
    await Promise.race([
      completed,
      Bun.sleep(10_000).then(() => {
        throw new Error("kafka_event_receive_timeout");
      }),
    ]);

    expect(received.map((item) => item.eventId)).toEqual(eventIds);
    expect(received.every((item) => item.key === aggregateId)).toBe(true);
  });
});
