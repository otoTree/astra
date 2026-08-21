import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GongjiReadClient } from "./read-client.ts";
import { GongjiResourceOperator, GongjiWriteTransport } from "./resource-operator.ts";

const fixture = async (name: string): Promise<unknown> =>
  Bun.file(new URL(`../fixtures/documented/${name}.json`, import.meta.url)).json();
const observedAt = new Date("2026-08-22T00:00:00.000Z");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const credentials = () => ({ token: "contract-token", privateKeyPem });
const context = {
  operationId: "operation-provision-contract",
  requestId: "request-provision-contract",
  deadlineAt: new Date(observedAt.getTime() + 60_000),
};

describe("Gongji resource operator", () => {
  test("uses pinned image references and finds an existing deterministic task before replay", async () => {
    let existingTaskName: string | undefined;
    const readClient = new GongjiReadClient({
      endpoint: "https://provider.invalid",
      credentials,
      timeoutMilliseconds: 1_000,
      maximumRetries: 0,
      breakerFailureThreshold: 2,
      breakerCooldownMilliseconds: 10_000,
      pageSize: 100,
      maximumPages: 1,
      now: () => observedAt,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/deployment/resource/search") return Response.json(await fixture("resources"));
        if (url.pathname === "/api/deployment/task/search") {
          return Response.json(
            existingTaskName
              ? {
                  code: "0000",
                  message: "success",
                  data: {
                    count: 1,
                    results: [
                      {
                        task_id: 6799,
                        task_name: existingTaskName,
                        status: "Running",
                        points: 1,
                        runing_points: 1,
                        billing_value: 300000,
                        resources: [],
                        services: [],
                      },
                    ],
                  },
                }
              : { code: "0000", message: "success", data: { count: 0, results: [] } },
          );
        }
        throw new Error(`unexpected_read_path:${url.pathname}`);
      },
    });
    const writeBodies: Record<string, unknown>[] = [];
    const writes = new GongjiWriteTransport({
      endpoint: "https://provider.invalid",
      credentials,
      timeoutMilliseconds: 1_000,
      breakerFailureThreshold: 2,
      breakerCooldownMilliseconds: 10_000,
      now: () => observedAt,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writeBodies.push(body);
        existingTaskName = String(body.task_name);
        return Response.json(await fixture("create-operation"));
      },
    });
    const operator = new GongjiResourceOperator(readClient, writes);
    const imageDigest = `sha256:${"a".repeat(64)}`;
    const imageReference = `registry.example/astra/model@${imageDigest}`;
    const first = await operator.provisionReplica(
      { imageDigest, imageReference, region: "region-a", gpuSku: "5090" },
      context,
    );
    expect(first).toMatchObject({ id: "6799", state: "provisioning" });
    const services = writeBodies[0]?.services as Record<string, unknown>[];
    expect(services[0]?.service_image).toBe(imageReference);
    expect(JSON.stringify(writeBodies[0])).not.toContain("repository_password");

    const recovered = await operator.provisionReplica(
      { imageDigest, imageReference, region: "region-a", gpuSku: "5090" },
      context,
    );
    expect(recovered).toMatchObject({ id: "6799", state: "ready" });
    expect(writeBodies).toHaveLength(1);
  });

  test("does not automatically replay an ambiguous timed-out write", async () => {
    let calls = 0;
    const writes = new GongjiWriteTransport({
      endpoint: "https://provider.invalid",
      credentials,
      timeoutMilliseconds: 1,
      breakerFailureThreshold: 2,
      breakerCooldownMilliseconds: 10_000,
      now: () => observedAt,
      fetch: async (_input, init) => {
        calls += 1;
        await new Promise<void>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
        throw new Error("unreachable");
      },
    });
    await expect(writes.post("/api/task/deployment/create", { task_name: "contract" }, context)).rejects.toMatchObject({
      code: "operation_timeout",
      retryable: true,
    });
    expect(calls).toBe(1);
  });
});
