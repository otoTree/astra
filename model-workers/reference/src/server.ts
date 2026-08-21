import { createHash } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadModelAppConfig } from "@astra/config";
import {
  capabilitiesSchema,
  inferenceRequestSchema,
  outputManifestSchema,
  type ExecutionView,
  type InferenceRequest,
  type OutputManifest,
} from "@astra/contracts";

type StoredExecution = ExecutionView & {
  request: InferenceRequest;
  requestHash: string;
  cancelRequested: boolean;
  manifest?: OutputManifest;
};

export type ReferenceModelAppOptions = Readonly<{
  release: string;
  videoFixture: string;
  delayMs: number;
}>;

const imageFixture = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};
const hash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", "content-type": "application/json" } });
const error = (code: string, message: string, status: number, retryable = false) =>
  json(
    {
      error: {
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code,
        message,
        retryable,
        request_id: `req_${Bun.randomUUIDv7()}`,
      },
    },
    status,
  );

export function createReferenceModelApp(options: ReferenceModelAppOptions): (request: Request) => Promise<Response> {
  const executions = new Map<string, StoredExecution>();
  const maxConcurrency = 1;
  const capabilities = capabilitiesSchema.parse({
    contract_version: "1.0",
    app: { name: "reference-model-app", version: "1.0.0", build: "deterministic" },
    model_release: options.release,
    modalities: ["video", "image"],
    operations: ["generation", "edit"],
    max_concurrency: maxConcurrency,
    capabilities: {
      aspect_ratios: ["16:9", "1:1"],
      resolutions: ["0.2mp"],
      resolution_matrix: {
        "16:9/0.2mp": { width: 608, height: 352 },
        "1:1/0.2mp": { width: 448, height: 448 },
      },
      durations: [5, 15],
      fps: [24],
      input_types: ["image", "video", "audio"],
      input_roles: [
        "reference_image",
        "first_frame",
        "last_frame",
        "reference_video",
        "reference_audio",
        "source_video",
        "mask",
      ],
      audio_modes: ["none", "native", "reference"],
      supports_cancel: true,
      supports_progress: true,
      supports_resume: false,
    },
    artifacts: {
      output_artifacts: [{ role: "result", content_types: ["video/mp4", "image/png"] }],
      max_outputs: 1,
      sidecar_manifest_allowed: true,
      post_processing: "model_app_only",
    },
  });

  const activeCount = () =>
    [...executions.values()].filter((item) =>
      ["accepted", "running", "post_processing", "canceling"].includes(item.status),
    ).length;
  const view = (item: StoredExecution): ExecutionView | OutputManifest =>
    item.manifest ?? {
      execution_id: item.execution_id,
      status: item.status,
      ...(item.stage === undefined ? {} : { stage: item.stage }),
      ...(item.progress === undefined ? {} : { progress: item.progress }),
      ...(item.message === undefined ? {} : { message: item.message }),
      ...(item.metrics === undefined ? {} : { metrics: item.metrics }),
      ...(item.error === undefined ? {} : { error: item.error }),
    };

  async function execute(item: StoredExecution): Promise<void> {
    item.status = "running";
    item.stage = "sampling";
    item.progress = 0;
    for (let progress = 10; progress <= 100; progress += 10) {
      if (Date.now() >= item.request.deadline_at * 1000) {
        item.status = "failed";
        item.error = { code: "inference_timeout", message: "Execution deadline elapsed", retryable: true };
        return;
      }
      await Bun.sleep(options.delayMs);
      if (item.cancelRequested) {
        item.status = "canceled";
        item.stage = "canceled";
        item.progress = null;
        return;
      }
      item.progress = progress;
      item.message = `sampling ${progress}%`;
    }

    const referenceControl = item.request.request.reference_execution;
    if (
      referenceControl !== null &&
      typeof referenceControl === "object" &&
      "outcome" in referenceControl &&
      referenceControl.outcome === "failed"
    ) {
      item.status = "failed";
      item.error = { code: "inference_failed", message: "Configured reference execution failure", retryable: false };
      return;
    }

    item.status = "post_processing";
    item.stage = "validating_outputs";
    await mkdir(item.request.output_dir, { recursive: true });
    const isVideo = item.request.type === "video";
    const outputPath = join(item.request.output_dir, isVideo ? "result.mp4" : "result.png");
    if (isVideo) await copyFile(options.videoFixture, outputPath);
    else await writeFile(outputPath, imageFixture, { flag: "wx" });
    const bytes = await Bun.file(outputPath).arrayBuffer();
    const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    const sizeBytes = (await stat(outputPath)).size;
    item.status = "completed";
    item.stage = "completed";
    item.progress = 100;
    item.message = "output ready";
    item.metrics = { output_size_bytes: sizeBytes };
    item.manifest = outputManifestSchema.parse({
      execution_id: item.request.execution_id,
      status: "completed",
      outputs: [
        {
          role: "result",
          path: outputPath,
          content_type: isVideo ? "video/mp4" : "image/png",
          sha256,
          size_bytes: sizeBytes,
          media: isVideo
            ? { container: "mp4", width: 320, height: 180, fps: 24, duration: 1 }
            : { width: 1, height: 1, color_type: "grayscale_alpha" },
          provenance: { producer: "model_app", transformations: [] },
        },
      ],
    });
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health/live") return json({ status: "ok" });
    if (request.method === "GET" && url.pathname === "/health/ready") {
      return json({ status: "ready", model_loaded: true, release: options.release });
    }
    if (request.method === "GET" && url.pathname === "/v1/capabilities") return json(capabilities);
    if (request.method === "POST" && url.pathname === "/v1/inferences") {
      let parsed: InferenceRequest;
      try {
        parsed = inferenceRequestSchema.parse(await request.json());
      } catch {
        return error("invalid_request", "Inference request failed schema validation", 422);
      }
      if (parsed.model_release !== options.release) {
        return error("unsupported_capability", "model_release does not match the loaded release", 422);
      }
      const requestHash = hash(parsed);
      const existing = executions.get(parsed.execution_id);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return error("execution_conflict", "execution_id is already bound to another request", 409);
        }
        return json(view(existing), 202);
      }
      if (Date.now() >= parsed.deadline_at * 1000) {
        return error("inference_timeout", "Execution deadline elapsed", 408, true);
      }
      if (activeCount() >= maxConcurrency) {
        return error("worker_busy", "Model App has no free execution slot", 429, true);
      }
      const item: StoredExecution = {
        execution_id: parsed.execution_id,
        status: "accepted",
        progress: 0,
        request: parsed,
        requestHash,
        cancelRequested: false,
      };
      executions.set(parsed.execution_id, item);
      void execute(item).catch((cause: unknown) => {
        item.status = "failed";
        item.error = {
          code: "inference_failed",
          message: cause instanceof Error ? cause.message : "Execution failed",
          retryable: false,
        };
      });
      return json({ execution_id: parsed.execution_id, status: "accepted" }, 202);
    }

    const executionMatch = url.pathname.match(/^\/v1\/inferences\/([^/]+)$/);
    if (request.method === "GET" && executionMatch) {
      const executionId = executionMatch[1];
      const item = executionId ? executions.get(decodeURIComponent(executionId)) : undefined;
      return item ? json(view(item)) : error("execution_not_found", "Execution does not exist", 404);
    }

    const cancelMatch = url.pathname.match(/^\/v1\/inferences\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const executionId = cancelMatch[1];
      const item = executionId ? executions.get(decodeURIComponent(executionId)) : undefined;
      if (!item) return error("execution_not_found", "Execution does not exist", 404);
      if (["accepted", "running", "post_processing"].includes(item.status)) {
        item.cancelRequested = true;
        item.status = "canceling";
      }
      return json(view(item));
    }
    return error("not_found", "Route not found", 404);
  };
}

if (import.meta.main) {
  const config = loadModelAppConfig();
  const server = Bun.serve({
    port: config.MODEL_APP_PORT,
    fetch: createReferenceModelApp({
      release: config.MODEL_APP_RELEASE,
      videoFixture: config.MODEL_APP_VIDEO_FIXTURE,
      delayMs: config.MODEL_APP_DELAY_MS,
    }),
  });
  console.log(
    JSON.stringify({ service: "model-app", implementation: "reference", status: "started", port: server.port }),
  );
}
