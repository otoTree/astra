import { describe, expect, test } from "bun:test";
import { ReferenceProviderOperator } from "./index.ts";

const context = (operationId: string) => ({
  operationId,
  requestId: "request-contract",
  deadlineAt: new Date("2026-08-22T01:00:00.000Z"),
});

describe("reference Provider resource operator", () => {
  test("converges repeated operation keys to one resource", async () => {
    const operator = new ReferenceProviderOperator(() => new Date("2026-08-22T00:00:00.000Z"));
    const input = { imageDigest: `sha256:${"a".repeat(64)}`, region: "region_local", gpuSku: "reference-gpu" };
    const first = await operator.provisionReplica(input, context("provision:replica-1"));
    const replay = await operator.provisionReplica(input, context("provision:replica-1"));
    expect(replay).toEqual(first);
    expect(operator.replicas.size).toBe(1);
    await operator.drainReplica(first.id, context("drain:replica-1"));
    expect((await operator.observeReplica(first.id, context("observe:replica-1"))).state).toBe("draining");
    await operator.terminateReplica(first.id, context("terminate:replica-1"));
    expect((await operator.observeReplica(first.id, context("observe:replica-1"))).state).toBe("terminated");
  });
});
