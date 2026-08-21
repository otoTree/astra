import { describe, expect, test } from "bun:test";
import { taskSchema } from "@astra/contracts";
import { z } from "zod";
import { parse } from "yaml";
import { createPublicApi, type PublicFileUseCases, type PublicTaskUseCases, withErrorHandling } from "./app.ts";
import { MediaValidatorError } from "./media-validator-client.ts";

const unavailable = (): never => {
  throw new Error("dependency_unavailable");
};

const taskUseCases: PublicTaskUseCases = {
  ready: async () => false,
  create: async () => unavailable(),
  list: async () => unavailable(),
  get: async () => unavailable(),
  cancel: async () => unavailable(),
  listModels: async () => ({ object: "list", data: [], has_more: false, next_cursor: null }),
};
const fileUseCases: PublicFileUseCases = {
  reserve: async () => unavailable(),
  complete: async () => unavailable(),
  get: async () => unavailable(),
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

  test("implements every public OpenAPI operation", async () => {
    const source = await Bun.file("packages/contracts/openapi.yaml").text();
    const document = z
      .object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
      .parse(parse(source) as unknown);
    const normalize = (path: string): string => path.replace("{file_id}", ":id").replace("{task_id}", ":id");
    const declared = new Set<string>();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of Object.keys(item)) {
        if (["get", "post", "put", "patch", "delete"].includes(method)) {
          declared.add(`${method.toUpperCase()} ${normalize(path)}`);
        }
      }
    }
    const implemented = new Set(
      app.routes
        .filter((route) => route.path.startsWith("/v1/") && route.method !== "ALL")
        .map((route) => `${route.method.toUpperCase()} ${route.path}`),
    );
    expect(implemented).toEqual(declared);
  });

  test("requires an empty JSON object for completion and cancellation commands", async () => {
    const completion = await app.request("http://localhost/v1/files/file_1/complete", { method: "POST" });
    expect(completion.status).toBe(400);
    expect(((await completion.json()) as { error: { code: string } }).error.code).toBe("invalid_json");
    const cancellation = await app.request("http://localhost/v1/tasks/task_1/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "undeclared" }),
    });
    expect(cancellation.status).toBe(422);
    expect(((await cancellation.json()) as { error: { code: string } }).error.code).toBe("unknown_parameter");
  });

  test("maps deterministic media rejection to a non-retryable client error", async () => {
    const rejectingFiles: PublicFileUseCases = {
      ...fileUseCases,
      complete: async () => {
        throw new MediaValidatorError("rejected", false, 422);
      },
    };
    const rejectingApp = withErrorHandling(createPublicApi(taskUseCases, rejectingFiles));
    const response = await rejectingApp.request("http://localhost/v1/files/file_invalid/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string; retryable: boolean } }).error).toEqual(
      expect.objectContaining({ code: "media_validation_failed", retryable: false }),
    );
  });

  test("routes edit operations through their distinct persistence contract", async () => {
    let operation: string | undefined;
    const tasks: PublicTaskUseCases = {
      ...taskUseCases,
      create: async (_context, input, type, selectedOperation) => {
        operation = `${type}:${selectedOperation}`;
        return {
          replayed: false,
          task: {
            id: "task_edit",
            object: "generation.task",
            type,
            operation: selectedOperation,
            status: "queued",
            model: input.model,
            model_release: "release_local_reference",
            priority: input.priority,
            request: input,
            resolved_parameters: { width: 1152, height: 640, fps: 24 },
            progress: null,
            status_reason: null,
            output_file_ids: [],
            output: null,
            error: null,
            created_at: 1,
            updated_at: 1,
            completed_at: null,
            expires_at: null,
          },
        };
      },
    };
    const editApp = withErrorHandling(createPublicApi(tasks, fileUseCases));
    const response = await editApp.request("http://localhost/v1/videos/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "h3",
        prompt: "edit",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        input_files: [{ file_id: "file_source", type: "video", role: "source_video" }],
      }),
    });
    expect(response.status).toBe(202);
    expect(operation).toBe("video:edit");
    expect(taskSchema.safeParse(await response.json()).success).toBe(true);
  });
});
