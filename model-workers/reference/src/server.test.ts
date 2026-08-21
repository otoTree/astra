import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReferenceModelApp, deterministicPng } from "./server.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function request(type: "image" | "video", executionId: string): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), "astra-contract-"));
  directories.push(directory);
  return {
    execution_id: executionId,
    task_id: `task_${executionId}`,
    type,
    operation: "generation",
    model_release: "release_reference",
    request: {},
    inputs: [],
    output_dir: `/work/tasks/${directory.split("/").at(-1)}/outputs`,
    deadline_at: Math.floor(Date.now() / 1000) + 60,
  };
}

describe("reference Model App contract", () => {
  test("produces deterministic PNG bytes with the requested dimensions", () => {
    const first = deterministicPng(608, 352);
    const second = deterministicPng(608, 352);
    expect(first.equals(second)).toBe(true);
    expect(first.readUInt32BE(16)).toBe(608);
    expect(first.readUInt32BE(20)).toBe(352);
    expect(createHash("sha256").update(first).digest("hex")).toBe(createHash("sha256").update(second).digest("hex"));
  });

  test("rejects a release mismatch", async () => {
    const app = createReferenceModelApp({
      release: "release_reference",
      videoFixture: "fixtures/sample.mp4",
      delayMs: 0,
    });
    const body = await request("image", "execution_1");
    body.model_release = "release_other";
    const response = await app(
      new Request("http://model-app/v1/inferences", { method: "POST", body: JSON.stringify(body) }),
    );
    expect(response.status).toBe(422);
  });

  test("binds an execution id to the complete request", async () => {
    const app = createReferenceModelApp({
      release: "release_reference",
      videoFixture: "fixtures/sample.mp4",
      delayMs: 10,
    });
    const body = await request("image", "execution_2");
    const first = await app(
      new Request("http://model-app/v1/inferences", { method: "POST", body: JSON.stringify(body) }),
    );
    expect(first.status).toBe(202);
    const replay = await app(
      new Request("http://model-app/v1/inferences", { method: "POST", body: JSON.stringify(body) }),
    );
    expect(replay.status).toBe(202);
    const conflicting = { ...body, task_id: "task_other" };
    const conflict = await app(
      new Request("http://model-app/v1/inferences", { method: "POST", body: JSON.stringify(conflicting) }),
    );
    expect(conflict.status).toBe(409);
  });

  test("honors cancellation idempotently", async () => {
    const app = createReferenceModelApp({
      release: "release_reference",
      videoFixture: "fixtures/sample.mp4",
      delayMs: 10,
    });
    const body = await request("image", "execution_3");
    await app(new Request("http://model-app/v1/inferences", { method: "POST", body: JSON.stringify(body) }));
    const first = await app(new Request("http://model-app/v1/inferences/execution_3/cancel", { method: "POST" }));
    const second = await app(new Request("http://model-app/v1/inferences/execution_3/cancel", { method: "POST" }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
