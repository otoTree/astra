import { describe, expect, test } from "bun:test";
import { capabilitiesSchema, taskSchema } from "@astra/contracts";
import { z } from "zod";
import { parse } from "yaml";
import {
  createPublicApi,
  createWorkerControlApi,
  type PublicApiSecurity,
  type PublicFileUseCases,
  type PublicTaskUseCases,
  type WorkerControlUseCases,
  withErrorHandling,
} from "./app.ts";
import { MediaValidatorError } from "./media-validator-client.ts";
import { WorkerControlError } from "@astra/database";

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
const testContext = {
  actorType: "api_key" as const,
  actorId: "key_test",
  apiKeyId: "key_test",
  organizationId: "org_test",
  projectId: "project_test",
  scopes: ["generations:create", "tasks:read", "tasks:cancel", "files:write", "files:read", "models:read"],
  ratePolicy: { requestRatePerMinute: 1000, requestBurst: 1000, taskRatePerMinute: 1000, taskBurst: 1000 },
};
const testSecurity: PublicApiSecurity = {
  authenticator: {
    authenticate: async () => testContext,
    authorize: async () => undefined,
    recordOutcome: async () => undefined,
  },
  rateLimiter: {
    consume: async () => ({ allowed: true, retryAfterSeconds: 1 }),
    ready: async () => true,
  },
};

describe("public API", () => {
  const app = withErrorHandling(createPublicApi(taskUseCases, fileUseCases, testSecurity));

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
    const rejectingApp = withErrorHandling(createPublicApi(taskUseCases, rejectingFiles, testSecurity));
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
    const editApp = withErrorHandling(createPublicApi(tasks, fileUseCases, testSecurity));
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

describe("worker control API", () => {
  const identity = {
    workerId: "worker_test",
    replicaId: "replica_test",
    releaseId: "release_test",
    poolId: "pool_test",
    instanceFingerprint: "fingerprint_worker_test",
    sessionId: "session_test",
    sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const service: WorkerControlUseCases = {
    register: async () => ({
      worker_id: identity.workerId,
      worker_token: "worker_token_with_at_least_thirty_two_characters",
      token_expires_at: Math.floor(Date.now() / 1000) + 60,
      heartbeat_interval_seconds: 10,
      lease_duration_seconds: 30,
      orphan_grace_period_seconds: 180,
      rollout_validation_required: false,
    }),
    authenticate: async (token, workerId) => {
      if (token !== "worker-session-token" || (workerId && workerId !== identity.workerId)) {
        throw new WorkerControlError("invalid_worker_token", 401);
      }
      return identity;
    },
    lease: async () => undefined,
    heartbeat: async (_identity, input) => ({
      accepted_sequence: input.sequence,
      leases: [],
      desired_state: "run",
    }),
    prepareOutputs: async () => unavailable(),
    completeOutputs: async () => unavailable(),
    complete: async () => unavailable(),
    fail: async () => unavailable(),
    drained: async () => ({ accepted: true, reclaim_token: "reclaim_token_with_at_least_thirty_two_chars" }),
    reportRolloutValidation: async () => unavailable(),
  };
  const app = withErrorHandling(createWorkerControlApi({ ready: async () => true }, service));

  test("implements every Worker OpenAPI operation", async () => {
    const source = await Bun.file("packages/contracts/openapi-worker.yaml").text();
    const document = z
      .object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
      .parse(parse(source) as unknown);
    const normalize = (path: string): string =>
      path.replace("{worker_id}", ":worker_id").replace("{attempt_id}", ":attempt_id");
    const declared = new Set<string>();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of Object.keys(item)) {
        if (["get", "post", "put", "patch", "delete"].includes(method)) {
          declared.add(`${method.toUpperCase()} /internal/v1${normalize(path)}`);
        }
      }
    }
    const implemented = new Set(
      app.routes
        .filter((route) => route.path.startsWith("/internal/v1/") && route.method !== "ALL")
        .map((route) => `${route.method.toUpperCase()} ${route.path}`),
    );
    expect(implemented).toEqual(declared);
  });

  test("keeps bootstrap and Worker session authentication in the Worker trust domain", async () => {
    const registration = await app.request("http://localhost/internal/v1/workers/register", {
      method: "POST",
      headers: { authorization: "Bearer bootstrap-token", "content-type": "application/json" },
      body: JSON.stringify({
        provider: "reference",
        region: "region_test",
        provider_instance_id: "instance_test",
        replica_id: "replica_test",
        pool_id: "pool_test",
        release_id: "release_test",
        instance_fingerprint: "fingerprint_worker_test",
        hardware: { gpu_sku: "gpu_test", gpu_count: 1, gpu_memory_bytes: 1 },
        capabilities: capabilitiesSchema.parse({
          contract_version: "1.0",
          app: { name: "test", version: "1", build: "test" },
          model_release: "release_test",
          modalities: ["video"],
          operations: ["generation"],
          max_concurrency: 1,
          capabilities: {
            aspect_ratios: ["16:9"],
            resolutions: ["0.2mp"],
            resolution_matrix: { "16:9/0.2mp": { width: 608, height: 352 } },
            durations: [15],
            fps: [24],
            input_types: ["image", "video", "audio"],
            input_roles: ["reference_image"],
            audio_modes: ["native"],
            supports_cancel: true,
            supports_progress: true,
            supports_resume: false,
          },
          artifacts: {
            output_artifacts: [{ role: "result", content_types: ["video/mp4"] }],
            max_outputs: 1,
            sidecar_manifest_allowed: false,
            post_processing: "model_app_only",
          },
        }),
      }),
    });
    expect(registration.status).toBe(201);
    const unauthenticatedLease = await app.request("http://localhost/internal/v1/workers/worker_test/lease", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sequence: 1,
        max_concurrency: 1,
        running_slots: 0,
        reserved_slots: 0,
        available_slots: 1,
        capabilities_hash: "a".repeat(64),
      }),
    });
    expect(unauthenticatedLease.status).toBe(401);
    expect(((await unauthenticatedLease.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_worker_token",
    );
    const emptyLease = await app.request("http://localhost/internal/v1/workers/worker_test/lease", {
      method: "POST",
      headers: { authorization: "Bearer worker-session-token", "content-type": "application/json" },
      body: JSON.stringify({
        sequence: 1,
        max_concurrency: 1,
        running_slots: 0,
        reserved_slots: 0,
        available_slots: 1,
        capabilities_hash: "a".repeat(64),
      }),
    });
    expect(emptyLease.status).toBe(204);
  });

  test("accepts rollout validation only from the bound Worker session", async () => {
    let reportedSequence: number | undefined;
    const validationService: WorkerControlUseCases = {
      ...service,
      reportRolloutValidation: async (_identity, input) => {
        reportedSequence = input.sequence;
        return { accepted: true as const, rollout_id: "rollout_test", rollout_step_id: "rolloutstep_test" };
      },
    };
    const validationApp = withErrorHandling(createWorkerControlApi({ ready: async () => true }, validationService));
    const report = {
      sequence: 7,
      observed_at: new Date().toISOString(),
      image_digest: `sha256:${"a".repeat(64)}`,
      status: "passed",
      capabilities_hash: "b".repeat(64),
      smoke: {
        validation_id: "validation_test",
        model_release: "release_test",
        status: "passed",
        evidence_sha256: "c".repeat(64),
        duration_ms: 125,
        checks: { readiness: true, capabilities: true, execution: true, output_contract: true },
      },
      resources: { gpu_memory_peak_bytes: 0, system_memory_peak_bytes: 1024 },
    };
    const accepted = await validationApp.request(
      "http://localhost/internal/v1/workers/worker_test/rollout-validation",
      {
        method: "POST",
        headers: { authorization: "Bearer worker-session-token", "content-type": "application/json" },
        body: JSON.stringify(report),
      },
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      accepted: true,
      rollout_id: "rollout_test",
      rollout_step_id: "rolloutstep_test",
    });
    expect(reportedSequence).toBe(7);

    const wrongWorker = await validationApp.request(
      "http://localhost/internal/v1/workers/worker_other/rollout-validation",
      {
        method: "POST",
        headers: { authorization: "Bearer worker-session-token", "content-type": "application/json" },
        body: JSON.stringify(report),
      },
    );
    expect(wrongWorker.status).toBe(401);

    const invalidEvidence = await validationApp.request(
      "http://localhost/internal/v1/workers/worker_test/rollout-validation",
      {
        method: "POST",
        headers: { authorization: "Bearer worker-session-token", "content-type": "application/json" },
        body: JSON.stringify({ ...report, status: "failed" }),
      },
    );
    expect(invalidEvidence.status).toBe(422);
  });
});
