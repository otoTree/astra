import { describe, expect, test } from "bun:test";
import { createPublicApi, type PublicFileUseCases, type PublicTaskUseCases, withErrorHandling } from "./app.ts";

const unavailable = (): never => {
  throw new Error("dependency_unavailable");
};

const taskUseCases: PublicTaskUseCases = {
  ready: async () => false,
  create: async () => unavailable(),
  list: async () => unavailable(),
  get: async () => unavailable(),
  cancel: async () => unavailable(),
};
const fileUseCases: PublicFileUseCases = {
  reserve: async () => unavailable(),
  complete: async () => unavailable(),
  contentUrl: async () => unavailable(),
};

describe("public API", () => {
  const app = withErrorHandling(createPublicApi(taskUseCases, fileUseCases));

  test("exposes liveness", async () => {
    const response = await app.request("http://localhost/health/live");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toMatch(/^req_/);
  });

  test("validates video requests before the persistence boundary", async () => {
    const response = await app.request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "h3", prompt: "test", aspect_ratio: "wide", resolution: "0.7mp", duration: 15 }),
    });
    expect(response.status).toBe(422);
  });

  test("rejects client-controlled seed as an unknown parameter", async () => {
    const response = await app.request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "h3",
        prompt: "test",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        seed: 42,
      }),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("unknown_parameter");
  });

  test("maps a persistence boundary failure to a retryable internal error", async () => {
    const response = await app.request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "image-test", prompt: "test", size: "320x180" }),
    });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string; retryable: boolean } }).error).toEqual(
      expect.objectContaining({ code: "internal_error", retryable: true }),
    );
  });

  test("preserves one request id across the response envelope and header", async () => {
    const response = await app.request("http://localhost/does-not-exist", {
      headers: { "x-request-id": "req_client_trace" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("req_client_trace");
    expect(((await response.json()) as { error: { type: string; request_id: string } }).error).toEqual(
      expect.objectContaining({ type: "not_found_error", request_id: "req_client_trace" }),
    );
  });
});
