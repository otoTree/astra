import { Hono } from "hono";
import { z } from "zod";
import { errorResponse, fileUploadRequestSchema, imageGenerationSchema, videoGenerationSchema } from "@astra/contracts";
import type { TaskService } from "@astra/database";
import type { FileService } from "./file-service.ts";

export type ApiTrustDomain = "public" | "admin" | "worker-control";
export type PublicTaskUseCases = Pick<TaskService, "ready" | "create" | "list" | "get" | "cancel">;
export type PublicFileUseCases = Pick<FileService, "reserve" | "complete" | "contentUrl">;
export type ReadinessProbe = Readonly<{ ready(): Promise<boolean> }>;

const generatedRequestIds = new WeakMap<Request, string>();
const requestId = (request: Request): string => {
  const supplied = request.headers.get("x-request-id");
  if (supplied) return supplied;
  const existing = generatedRequestIds.get(request);
  if (existing) return existing;
  const generated = `req_${Bun.randomUUIDv7()}`;
  generatedRequestIds.set(request, generated);
  return generated;
};

const attachRequestId = (app: Hono): void => {
  app.use("*", async (context, next) => {
    const id = requestId(context.req.raw);
    await next();
    context.header("X-Request-Id", id);
  });
};
const taskListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().min(1).optional(),
    type: z.enum(["video", "image"]).optional(),
    status: z.string().optional(),
    model: z.string().min(1).optional(),
  })
  .strict();
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);

function context(request: Request): { organizationId: string; projectId: string } {
  return {
    organizationId: request.headers.get("x-organization-id") ?? "org_local",
    projectId: request.headers.get("x-project-id") ?? "project_local",
  };
}

function serviceError(request: Request, error: unknown): Response {
  const candidate = error instanceof Error ? error.message : "internal_error";
  const statuses: Record<string, number> = {
    idempotency_conflict: 409,
    model_not_found: 404,
    model_capability_mismatch: 422,
    idempotency_incomplete: 409,
    invalid_input_media: 422,
    input_ttl_too_short: 422,
    invalid_cursor: 400,
    file_not_found: 404,
    invalid_model_options: 422,
    upload_integrity_mismatch: 422,
    invalid_file_state: 409,
    upload_expired: 410,
    asset_expired: 410,
    upload_not_found: 422,
  };
  const code = statuses[candidate] === undefined ? "internal_error" : candidate;
  if (code === "internal_error")
    console.error(
      JSON.stringify({
        level: "error",
        code,
        cause: error instanceof Error ? error.name : "unknown",
        request_id: requestId(request),
      }),
    );
  return errorResponse(
    requestId(request),
    statuses[code] ?? 500,
    code,
    code === "internal_error" ? "An internal error occurred" : code.replaceAll("_", " "),
    code === "internal_error",
  );
}

function parseJson<S extends z.ZodTypeAny>(
  schema: S,
  request: Request,
): Promise<{ value?: z.output<S>; response?: Response }> {
  return request
    .json()
    .then((body: unknown) => {
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        const unknown = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
        if (unknown?.code === "unrecognized_keys") {
          const key = unknown.keys[0];
          const path = [...unknown.path, key ?? "unknown"].join(".");
          return {
            response: errorResponse(
              requestId(request),
              422,
              "unknown_parameter",
              `Unknown request parameter: ${path}`,
              false,
              path,
            ),
          };
        }
        const issue = parsed.error.issues[0];
        return {
          response: errorResponse(
            requestId(request),
            422,
            "invalid_request",
            "Request body failed schema validation",
            false,
            issue?.path.join("."),
          ),
        };
      }
      return { value: parsed.data };
    })
    .catch(() => ({
      response: errorResponse(requestId(request), 400, "invalid_json", "Request body must be valid JSON"),
    }));
}

export function createPublicApi(taskService: PublicTaskUseCases, fileService: PublicFileUseCases): Hono {
  const app = new Hono();
  attachRequestId(app);
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", async (c) => {
    const ready = await taskService.ready();
    return c.json(
      { status: ready ? "ready" : "not_ready", database: ready ? "ready" : "unavailable" },
      ready ? 200 : 503,
    );
  });

  app.post("/v1/videos/generations", async (c) => {
    const parsed = await parseJson(videoGenerationSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    if (!parsed.value)
      return errorResponse(requestId(c.req.raw), 422, "invalid_request", "Request body failed schema validation");
    const key = c.req.header("Idempotency-Key");
    if (key && !idempotencyKeySchema.safeParse(key).success)
      return errorResponse(
        requestId(c.req.raw),
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must be 8-128 printable ASCII characters",
        false,
        "Idempotency-Key",
      );
    try {
      const result = await taskService.create(context(c.req.raw), parsed.value, "video", "/v1/videos/generations", key);
      return c.json(result.task, 202, result.replayed ? { "Idempotent-Replayed": "true" } : undefined);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });

  app.post("/v1/images/generations", async (c) => {
    const parsed = await parseJson(imageGenerationSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    if (!parsed.value)
      return errorResponse(requestId(c.req.raw), 422, "invalid_request", "Request body failed schema validation");
    const key = c.req.header("Idempotency-Key");
    if (key && !idempotencyKeySchema.safeParse(key).success)
      return errorResponse(
        requestId(c.req.raw),
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must be 8-128 printable ASCII characters",
        false,
        "Idempotency-Key",
      );
    try {
      const result = await taskService.create(context(c.req.raw), parsed.value, "image", "/v1/images/generations", key);
      return c.json(result.task, 202, result.replayed ? { "Idempotent-Replayed": "true" } : undefined);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });

  app.post("/v1/files/uploads", async (c) => {
    const parsed = await parseJson(fileUploadRequestSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    if (!parsed.value)
      return errorResponse(requestId(c.req.raw), 422, "invalid_request", "Request body failed schema validation");
    try {
      return c.json(await fileService.reserve(context(c.req.raw).projectId, parsed.value), 201);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/v1/files/:id/complete", async (c) => {
    try {
      return c.json(await fileService.complete(context(c.req.raw).projectId, c.req.param("id")));
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/v1/tasks", async (c) => {
    const parsed = taskListQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return errorResponse(requestId(c.req.raw), 400, "invalid_request", "Task filters failed schema validation");
    try {
      const statuses = parsed.data.status?.split(",").filter(Boolean);
      return c.json(
        await taskService.list(context(c.req.raw), {
          limit: parsed.data.limit,
          ...(parsed.data.after ? { after: parsed.data.after } : {}),
          ...(parsed.data.type ? { type: parsed.data.type } : {}),
          ...(statuses ? { statuses } : {}),
          ...(parsed.data.model ? { model: parsed.data.model } : {}),
        }),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/v1/tasks/:id", async (c) => {
    try {
      const task = await taskService.get(context(c.req.raw), c.req.param("id"));
      return task ? c.json(task) : errorResponse(requestId(c.req.raw), 404, "task_not_found", "Task not found");
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/v1/tasks/:id/cancel", async (c) => {
    try {
      const task = await taskService.cancel(context(c.req.raw), c.req.param("id"));
      return task ? c.json(task) : errorResponse(requestId(c.req.raw), 404, "task_not_found", "Task not found");
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/v1/files/:id/content", async (c) => {
    try {
      return c.redirect(await fileService.contentUrl(context(c.req.raw).projectId, c.req.param("id")), 302);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  return app;
}

export function createAdminApi(readiness: ReadinessProbe): Hono {
  const app = new Hono();
  attachRequestId(app);
  app.get("/health/live", (c) => c.json({ status: "ok", trust_domain: "admin" }));
  app.get("/health/ready", async (c) => {
    const ready = await readiness.ready();
    return c.json(
      { status: ready ? "ready" : "not_ready", database: ready ? "ready" : "unavailable" },
      ready ? 200 : 503,
    );
  });
  app.get("/admin/v1/health", (c) => c.json({ status: "ok", trust_domain: "admin" }));
  return app;
}

export function createWorkerControlApi(readiness: ReadinessProbe): Hono {
  const app = new Hono();
  attachRequestId(app);
  app.get("/health/live", (c) => c.json({ status: "ok", trust_domain: "worker-control" }));
  app.get("/health/ready", async (c) => {
    const ready = await readiness.ready();
    return c.json(
      { status: ready ? "ready" : "not_ready", database: ready ? "ready" : "unavailable" },
      ready ? 200 : 503,
    );
  });
  return app;
}

export function withErrorHandling(app: Hono): Hono {
  app.notFound((c) => errorResponse(requestId(c.req.raw), 404, "not_found", "Route not found"));
  app.onError((error, c) => {
    console.error(JSON.stringify({ level: "error", message: error.message, request_id: requestId(c.req.raw) }));
    return errorResponse(requestId(c.req.raw), 500, "internal_error", "An internal error occurred", true);
  });
  return app;
}
