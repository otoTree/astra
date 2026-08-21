import { describe, expect, test } from "bun:test";
import { ProviderError } from "@astra/provider-core";
import { DeterministicProviderAdapter, ManualClock } from "./index.ts";

const context = (operationId: string) => ({
  operationId,
  requestId: "request_1",
  deadlineAt: new Date("2026-01-01T01:00:00.000Z"),
});

describe("deterministic Provider Contract adapter", () => {
  test("replays the same provision operation without creating duplicate resources", async () => {
    const adapter = new DeterministicProviderAdapter();
    const input = { imageDigest: "sha256:abc", region: "reference-region", gpuSku: "reference-gpu" };
    const first = await adapter.provisionReplica(input, context("operation_1"));
    const replay = await adapter.provisionReplica(input, context("operation_1"));
    expect(replay).toEqual(first);
    expect(adapter.replicas.size).toBe(1);
  });

  test("rejects reusing an operation id with different input", async () => {
    const adapter = new DeterministicProviderAdapter();
    await adapter.provisionReplica(
      { imageDigest: "sha256:abc", region: "reference-region", gpuSku: "reference-gpu" },
      context("operation_conflict"),
    );
    await expect(
      adapter.provisionReplica(
        { imageDigest: "sha256:def", region: "reference-region", gpuSku: "reference-gpu" },
        context("operation_conflict"),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "operation_conflict", retryable: false }));
  });

  test("returns structured retry behavior for capacity failures", async () => {
    const adapter = new DeterministicProviderAdapter();
    adapter.setFailure("inventory_exhausted");
    try {
      await adapter.getResourceSnapshot(context("operation_2"));
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toEqual(expect.objectContaining({ code: "inventory_exhausted", retryable: true }));
    }
  });

  test("honors operation deadlines from an injected clock", async () => {
    const clock = new ManualClock(new Date("2026-01-01T02:00:00.000Z"));
    const adapter = new DeterministicProviderAdapter(clock);
    await expect(adapter.getResourceSnapshot(context("operation_3"))).rejects.toEqual(
      expect.objectContaining({ code: "operation_timeout" }),
    );
  });
});
