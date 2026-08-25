import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { decodeResources, decodeTaskList } from "./dto.ts";
import { GongjiReadClient } from "./read-client.ts";
import { redactProviderPayload } from "./redaction.ts";
import { gongjiSigningInput, signGongjiRequest } from "./signing.ts";

const fixture = async (name: string): Promise<unknown> =>
  Bun.file(new URL(`../fixtures/documented/${name}.json`, import.meta.url)).json();

const observedAt = new Date("2026-08-22T00:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("Gongji read transport", () => {
  test("signs the documented canonical request using RSA-SHA256 PKCS1 v1.5", () => {
    const input = {
      path: "/api/deployment/resource/search",
      version: "1.0.0",
      timestampMilliseconds: observedAt.getTime(),
      token: "contract-token",
      body: "",
      privateKeyPem,
    };
    const signature = signGongjiRequest(input);
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(
          gongjiSigningInput(input.path, input.version, input.timestampMilliseconds, input.token, input.body),
        ),
        publicKey,
        Buffer.from(signature, "base64"),
      ),
    ).toBe(true);
  });

  test("decodes resource units and quarantines undocumented fields and states", async () => {
    const resource = decodeResources("/resources", await fixture("resources"), observedAt);
    expect(resource.offers[0]?.gpuMemoryBytes).toBe(32 * 1024 * 1024 * 1024);
    expect(resource.offers[0]?.pricePerGpuHourMinor).toBe(300);
    expect(resource.page.quarantineReasons).toEqual([]);

    const deployment = (await fixture("deployments")) as Record<string, unknown>;
    const data = deployment.data as Record<string, unknown>;
    const result = (data.results as Record<string, unknown>[])[0];
    if (!result) throw new Error("fixture_missing_result");
    result.status = "FutureState";
    result.future_field = true;
    const decoded = decodeTaskList("deployment", "/deployments", deployment, observedAt);
    expect(decoded.quarantineReasons).toContain("unknown_state:deployment:FutureState");
    expect(decoded.quarantineReasons).toContain("unknown_field:deployment.results[0].future_field");
  });

  test("redacts credentials, repository secrets and URL-bearing values recursively", () => {
    const redacted = redactProviderPayload({
      token: "secret",
      nested: { repository_password: "secret", callback_url: "https://secret.example/path" },
    });
    expect(redacted).toEqual({
      token: "[REDACTED]",
      nested: { repository_password: "[REDACTED]", callback_url: "[REDACTED]" },
    });
  });

  test("observes every phase-eight read endpoint without an external request", async () => {
    const requestedPaths: string[] = [];
    const responseByPath: Readonly<Record<string, string>> = {
      "/api/deployment/resource/search": "resources",
      "/api/deployment/task/search": "deployments",
      "/api/deployment/task/points": "nodes",
      "/api/task/job/search": "jobs",
      "/api/task/image_preheat/get_regions": "warmup-regions",
      "/api/task/image_preheat/search": "warmups",
      "/api/billing/get_billing_record": "billing",
    };
    const client = new GongjiReadClient({
      endpoint: "https://provider.invalid",
      credentials: () => ({ token: "contract-token", privateKeyPem }),
      timeoutMilliseconds: 1_000,
      maximumRetries: 0,
      breakerFailureThreshold: 2,
      breakerCooldownMilliseconds: 10_000,
      pageSize: 100,
      maximumPages: 2,
      now: () => observedAt,
      fetch: async (input) => {
        const url = new URL(String(input));
        requestedPaths.push(url.pathname);
        const name = responseByPath[url.pathname];
        if (!name) return Response.json({ code: "C999", message: "missing", data: null }, { status: 404 });
        return Response.json(await fixture(name));
      },
    });
    const bundle = await client.observe({
      operationId: "operation-contract",
      requestId: "request-contract",
      deadlineAt: new Date(observedAt.getTime() + 60_000),
    });
    expect(new Set(requestedPaths)).toEqual(new Set(Object.keys(responseByPath)));
    expect(bundle.resources.offers).toHaveLength(1);
    expect(bundle.pages.flatMap((page) => page.objects)).toHaveLength(5);
    expect(bundle.pages.every((page) => page.quarantineReasons.length === 0)).toBe(true);
  });

  test("opens the circuit immediately on authentication failures", async () => {
    let calls = 0;
    const client = new GongjiReadClient({
      endpoint: "https://provider.invalid",
      credentials: () => ({ token: "contract-token", privateKeyPem }),
      timeoutMilliseconds: 1_000,
      maximumRetries: 3,
      breakerFailureThreshold: 5,
      breakerCooldownMilliseconds: 10_000,
      pageSize: 100,
      maximumPages: 1,
      now: () => observedAt,
      fetch: async () => {
        calls += 1;
        return Response.json({ code: "C001", message: "denied", data: null }, { status: 401 });
      },
    });
    const context = {
      operationId: "operation-auth",
      requestId: "request-auth",
      deadlineAt: new Date(observedAt.getTime() + 60_000),
    };
    await expect(client.observe(context)).rejects.toMatchObject({
      code: "authentication_failed",
      retryable: false,
    });
    await expect(client.observe(context)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(calls).toBe(1);
  });

  test("supports the documented token-only request mode", async () => {
    let capturedHeaders: Headers | undefined;
    const client = new GongjiReadClient({
      endpoint: "https://provider.invalid",
      credentials: () => ({ token: "contract-token" }),
      timeoutMilliseconds: 1_000,
      maximumRetries: 0,
      breakerFailureThreshold: 2,
      breakerCooldownMilliseconds: 10_000,
      pageSize: 100,
      maximumPages: 1,
      now: () => observedAt,
      fetch: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return Response.json(await fixture("resources"));
      },
    });
    await client.selectResource("region-a", "5090", {
      operationId: "operation-token-only",
      requestId: "request-token-only",
      deadlineAt: new Date(observedAt.getTime() + 60_000),
    });
    expect(capturedHeaders?.get("token")).toBe("contract-token");
    expect(capturedHeaders?.get("sign_str")).toBeNull();
    expect(capturedHeaders?.get("timestamp")).toBeNull();
    expect(capturedHeaders?.get("version")).toBeNull();
  });
});
