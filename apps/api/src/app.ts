import { Hono } from "hono";
import { z } from "zod";
import {
  AdminAuthenticationError,
  type AdminContext,
  type AdminPermission,
  type AdminSessionManager,
  AuthenticationError,
  type ProjectContext,
  type PublicApiScope,
  type PublicRequestAuthenticator,
} from "@astra/auth";
import {
  errorResponse,
  adminSessionExchangeSchema,
  adminListQuerySchema,
  aliasSwitchSchema,
  budgetPolicyConfigurationSchema,
  capacityPolicyConfigurationSchema,
  fileUploadRequestSchema,
  imageEditSchema,
  imageGenerationSchema,
  modelListQuerySchema,
  modelCreateSchema,
  modelUpdateSchema,
  policyImpactPreviewSchema,
  policyPublishSchema,
  policyRollbackSchema,
  policyValidationSchema,
  poolCreateSchema,
  poolUpdateSchema,
  regionPolicyConfigurationSchema,
  releaseApprovalSchema,
  releaseCreateSchema,
  retryPolicyConfigurationSchema,
  taskListQuerySchema,
  taskStatusSchema,
  videoEditSchema,
  videoGenerationSchema,
} from "@astra/contracts";
import {
  AdminManagementError,
  type AdminManagementService,
  type AdminQueryService,
  type TaskService,
} from "@astra/database";
import { Counter, Histogram, createMetricRegistry, metricResponse } from "@astra/observability";
import { RateLimiterUnavailableError, type PublicApiRateLimiter, type RateLimitCategory } from "@astra/queue";
import { matchedRoutes } from "hono/route";
import type { FileService } from "./file-service.ts";
import { MediaValidatorError } from "./media-validator-client.ts";

export type ApiTrustDomain = "public" | "admin" | "worker-control";
export type PublicTaskUseCases = Pick<TaskService, "ready" | "create" | "list" | "get" | "cancel" | "listModels">;
export type PublicFileUseCases = Pick<FileService, "reserve" | "complete" | "get" | "contentUrl">;
export type ReadinessProbe = Readonly<{ ready(): Promise<boolean> }>;
export type PublicApiSecurity = Readonly<{
  authenticator: PublicRequestAuthenticator;
  rateLimiter: PublicApiRateLimiter;
}>;
export type AdminTaskUseCases = Pick<TaskService, "get">;
export type AdminApiSecurity = Readonly<{
  sessions: AdminSessionManager;
  sessionCookieName: string;
  csrfCookieName: string;
  secureCookies: boolean;
  sessionTtlSeconds: number;
}>;

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
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);
const emptyObjectSchema = z.object({}).strict();

function serviceError(request: Request, error: unknown): Response {
  if (error instanceof AdminAuthenticationError) {
    return errorResponse(
      requestId(request),
      error.status,
      error.code,
      error.code.replaceAll("_", " "),
      error.status === 503,
      undefined,
      error.status === 401 ? { "WWW-Authenticate": 'Bearer realm="astra-admin"' } : undefined,
    );
  }
  if (error instanceof AdminManagementError) {
    return errorResponse(
      requestId(request),
      error.status,
      error.code,
      error.code.replaceAll("_", " "),
      error.retryable,
    );
  }
  if (error instanceof AuthenticationError) {
    return errorResponse(
      requestId(request),
      error.status,
      error.code,
      error.code.replaceAll("_", " "),
      false,
      undefined,
      error.status === 401 ? { "WWW-Authenticate": 'Bearer realm="astra"' } : undefined,
    );
  }
  if (error instanceof RateLimiterUnavailableError) {
    return errorResponse(
      requestId(request),
      503,
      "rate_limiter_unavailable",
      "Rate limiting is temporarily unavailable",
      true,
    );
  }
  if (error instanceof MediaValidatorError) {
    const rejected = error.kind === "rejected";
    return errorResponse(
      requestId(request),
      rejected ? 422 : 503,
      rejected ? "media_validation_failed" : "media_validator_unavailable",
      rejected ? "Media failed strict validation" : "Media validation is temporarily unavailable",
      rejected ? false : error.retryable,
    );
  }
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
    media_validation_failed: 422,
    media_validator_unavailable: 503,
    project_access_denied: 403,
    invalid_api_key_context: 500,
    queued_task_quota_exceeded: 429,
    project_concurrency_exceeded: 429,
    daily_gpu_quota_exceeded: 429,
    daily_cost_quota_exceeded: 429,
    daily_upload_quota_exceeded: 429,
    active_file_storage_quota_exceeded: 429,
    file_too_large: 413,
  };
  const code = statuses[candidate] === undefined ? "internal_error" : candidate;
  const retryable = code === "internal_error" || code === "media_validator_unavailable";
  if (code === "internal_error")
    console.error(
      JSON.stringify({
        level: "error",
        code,
        cause: error instanceof Error ? error.name : "unknown",
        request_id: requestId(request),
      }),
    );
  const status = statuses[code] ?? 500;
  return errorResponse(
    requestId(request),
    status,
    code,
    code === "internal_error" ? "An internal error occurred" : code.replaceAll("_", " "),
    retryable,
    undefined,
    status === 429 ? { "Retry-After": "60" } : undefined,
  );
}

function parseJson<S extends z.ZodTypeAny>(
  schema: S,
  request: Request,
): Promise<{ value: z.output<S>; response: undefined } | { value: undefined; response: Response }> {
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
            value: undefined,
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
          value: undefined,
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
      return { value: parsed.data, response: undefined };
    })
    .catch(() => ({
      value: undefined,
      response: errorResponse(requestId(request), 400, "invalid_json", "Request body must be valid JSON"),
    }));
}

export function createPublicApi(
  taskService: PublicTaskUseCases,
  fileService: PublicFileUseCases,
  security: PublicApiSecurity,
): Hono {
  const app = new Hono();
  const authenticatedContexts = new WeakMap<Request, ProjectContext>();
  const metrics = createMetricRegistry("public-api");
  const requests = new Counter({
    name: "astra_public_api_requests_total",
    help: "Public API requests by route and status",
    labelNames: ["method", "route", "status"] as const,
    registers: [metrics],
  });
  const requestDuration = new Histogram({
    name: "astra_public_api_request_duration_seconds",
    help: "Public API request duration by route",
    labelNames: ["method", "route"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [metrics],
  });
  const accessRejections = new Counter({
    name: "astra_public_api_access_rejections_total",
    help: "Public API authentication, authorization, rate, and admission rejections",
    labelNames: ["route", "status"] as const,
    registers: [metrics],
  });
  attachRequestId(app);
  app.use("/v1/*", async (c, next) => {
    const started = performance.now();
    await next();
    const labels = { method: c.req.method, route: matchedRoutes(c).at(-1)?.path ?? "unmatched" };
    requests.inc({ ...labels, status: String(c.res.status) });
    if ([401, 403, 429].includes(c.res.status)) {
      accessRejections.inc({ route: labels.route, status: String(c.res.status) });
    }
    requestDuration.observe(labels, (performance.now() - started) / 1000);
  });
  app.use("/v1/*", async (c, next) => {
    try {
      const selected = await security.authenticator.authenticate(c.req.raw, requestId(c.req.raw));
      const decision = await security.rateLimiter.consume(selected, "request", requestId(c.req.raw));
      if (!decision.allowed) {
        await security.authenticator.recordOutcome(selected, c.req.raw, requestId(c.req.raw), {
          action: "public_api.admission",
          status: 429,
          reasonCode: "request_rate_exceeded",
        });
        return errorResponse(
          requestId(c.req.raw),
          429,
          "request_rate_exceeded",
          "Request rate limit exceeded",
          true,
          undefined,
          { "Retry-After": String(decision.retryAfterSeconds) },
        );
      }
      authenticatedContexts.set(c.req.raw, selected);
      await next();
      if (c.res.status === 429) {
        let reasonCode = "admission_rejected";
        try {
          const body = (await c.res.clone().json()) as { error?: { code?: unknown } };
          if (typeof body.error?.code === "string") reasonCode = body.error.code;
        } catch {
          reasonCode = "admission_rejected";
        }
        await security.authenticator.recordOutcome(selected, c.req.raw, requestId(c.req.raw), {
          action: "public_api.admission",
          status: c.res.status,
          reasonCode,
        });
      }
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });

  const authorize = async (request: Request, scope: PublicApiScope): Promise<ProjectContext | Response> => {
    const selected = authenticatedContexts.get(request);
    if (!selected) return errorResponse(requestId(request), 401, "invalid_api_key", "Invalid API Key");
    try {
      await security.authenticator.authorize(selected, scope, request, requestId(request));
      return selected;
    } catch (error) {
      return serviceError(request, error);
    }
  };

  const taskRateLimit = async (
    request: Request,
    selected: ProjectContext,
    category: RateLimitCategory,
    operationKey: string,
  ): Promise<Response | undefined> => {
    try {
      const decision = await security.rateLimiter.consume(selected, category, operationKey);
      if (decision.allowed) return undefined;
      return errorResponse(
        requestId(request),
        429,
        "request_rate_exceeded",
        "Task creation rate limit exceeded",
        true,
        undefined,
        { "Retry-After": String(decision.retryAfterSeconds) },
      );
    } catch (error) {
      return serviceError(request, error);
    }
  };
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", async (c) => {
    const [databaseReady, rateLimiterReady] = await Promise.all([taskService.ready(), security.rateLimiter.ready()]);
    const ready = databaseReady && rateLimiterReady;
    return c.json(
      {
        status: ready ? "ready" : "not_ready",
        database: databaseReady ? "ready" : "unavailable",
        rate_limiter: rateLimiterReady ? "ready" : "unavailable",
      },
      ready ? 200 : 503,
    );
  });
  app.get("/metrics", () => metricResponse(metrics));

  app.post("/v1/videos/generations", async (c) => {
    const selected = await authorize(c.req.raw, "generations:create");
    if (selected instanceof Response) return selected;
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
    const limited = await taskRateLimit(
      c.req.raw,
      selected,
      "task",
      `/v1/videos/generations:${key ?? requestId(c.req.raw)}`,
    );
    if (limited) return limited;
    try {
      const result = await taskService.create(
        selected,
        parsed.value,
        "video",
        "generation",
        "/v1/videos/generations",
        key,
        requestId(c.req.raw),
      );
      return c.json(result.task, 202, result.replayed ? { "Idempotent-Replayed": "true" } : undefined);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });

  app.post("/v1/images/generations", async (c) => {
    const selected = await authorize(c.req.raw, "generations:create");
    if (selected instanceof Response) return selected;
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
    const limited = await taskRateLimit(
      c.req.raw,
      selected,
      "task",
      `/v1/images/generations:${key ?? requestId(c.req.raw)}`,
    );
    if (limited) return limited;
    try {
      const result = await taskService.create(
        selected,
        parsed.value,
        "image",
        "generation",
        "/v1/images/generations",
        key,
        requestId(c.req.raw),
      );
      return c.json(result.task, 202, result.replayed ? { "Idempotent-Replayed": "true" } : undefined);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });

  app.post("/v1/videos/edits", async (c) => {
    const selected = await authorize(c.req.raw, "generations:create");
    if (selected instanceof Response) return selected;
    const parsed = await parseJson(videoEditSchema, c.req.raw);
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
    const limited = await taskRateLimit(c.req.raw, selected, "task", `/v1/videos/edits:${key ?? requestId(c.req.raw)}`);
    if (limited) return limited;
    try {
      const result = await taskService.create(
        selected,
        parsed.value,
        "video",
        "edit",
        "/v1/videos/edits",
        key,
        requestId(c.req.raw),
      );
      return c.json(result.task, 202, result.replayed ? { "Idempotent-Replayed": "true" } : undefined);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });

  app.post("/v1/images/edits", async (c) => {
    const selected = await authorize(c.req.raw, "generations:create");
    if (selected instanceof Response) return selected;
    const parsed = await parseJson(imageEditSchema, c.req.raw);
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
    const limited = await taskRateLimit(c.req.raw, selected, "task", `/v1/images/edits:${key ?? requestId(c.req.raw)}`);
    if (limited) return limited;
    try {
      const result = await taskService.create(
        selected,
        parsed.value,
        "image",
        "edit",
        "/v1/images/edits",
        key,
        requestId(c.req.raw),
      );
      return c.json(result.task, 202, result.replayed ? { "Idempotent-Replayed": "true" } : undefined);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });

  app.post("/v1/files/uploads", async (c) => {
    const selected = await authorize(c.req.raw, "files:write");
    if (selected instanceof Response) return selected;
    const parsed = await parseJson(fileUploadRequestSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    if (!parsed.value)
      return errorResponse(requestId(c.req.raw), 422, "invalid_request", "Request body failed schema validation");
    try {
      return c.json(await fileService.reserve(selected, parsed.value), 201);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/v1/files/:id/complete", async (c) => {
    const selected = await authorize(c.req.raw, "files:write");
    if (selected instanceof Response) return selected;
    const parsed = await parseJson(emptyObjectSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    try {
      return c.json(await fileService.complete(selected.projectId, c.req.param("id")));
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/v1/tasks", async (c) => {
    const selected = await authorize(c.req.raw, "tasks:read");
    if (selected instanceof Response) return selected;
    const url = new URL(c.req.url);
    const rawStatus = url.searchParams
      .getAll("status")
      .flatMap((value) => value.split(","))
      .filter(Boolean);
    const query = Object.fromEntries(url.searchParams.entries());
    if (rawStatus.length > 0) query.status = rawStatus.join(",");
    const parsed = taskListQuerySchema.safeParse(query);
    if (!parsed.success)
      return errorResponse(requestId(c.req.raw), 400, "invalid_request", "Task filters failed schema validation");
    const statuses = rawStatus.map((status) => taskStatusSchema.safeParse(status));
    if (statuses.some((status) => !status.success)) {
      return errorResponse(
        requestId(c.req.raw),
        400,
        "invalid_request",
        "Task status filter is invalid",
        false,
        "status",
      );
    }
    try {
      return c.json(
        await taskService.list(selected, {
          limit: parsed.data.limit,
          ...(parsed.data.after ? { after: parsed.data.after } : {}),
          ...(parsed.data.type ? { type: parsed.data.type } : {}),
          ...(rawStatus.length > 0 ? { statuses: rawStatus } : {}),
          ...(parsed.data.model ? { model: parsed.data.model } : {}),
          ...(parsed.data.priority ? { priority: parsed.data.priority } : {}),
          ...(parsed.data.created_after !== undefined
            ? { createdAfter: new Date(parsed.data.created_after * 1000) }
            : {}),
          ...(parsed.data.created_before !== undefined
            ? { createdBefore: new Date(parsed.data.created_before * 1000) }
            : {}),
        }),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/v1/files/:id", async (c) => {
    const selected = await authorize(c.req.raw, "files:read");
    if (selected instanceof Response) return selected;
    try {
      const file = await fileService.get(selected.projectId, c.req.param("id"));
      return file ? c.json(file) : errorResponse(requestId(c.req.raw), 404, "file_not_found", "File not found");
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/v1/models", async (c) => {
    const selected = await authorize(c.req.raw, "models:read");
    if (selected instanceof Response) return selected;
    const parsed = modelListQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return errorResponse(requestId(c.req.raw), 400, "invalid_request", "Model filters failed schema validation");
    try {
      return c.json(await taskService.listModels(selected, parsed.data.type));
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/v1/tasks/:id", async (c) => {
    const selected = await authorize(c.req.raw, "tasks:read");
    if (selected instanceof Response) return selected;
    try {
      const task = await taskService.get(selected, c.req.param("id"));
      return task ? c.json(task) : errorResponse(requestId(c.req.raw), 404, "task_not_found", "Task not found");
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/v1/tasks/:id/cancel", async (c) => {
    const selected = await authorize(c.req.raw, "tasks:cancel");
    if (selected instanceof Response) return selected;
    const parsed = await parseJson(emptyObjectSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    try {
      const task = await taskService.cancel(selected, c.req.param("id"), requestId(c.req.raw));
      return task ? c.json(task) : errorResponse(requestId(c.req.raw), 404, "task_not_found", "Task not found");
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/v1/files/:id/content", async (c) => {
    const selected = await authorize(c.req.raw, "files:read");
    if (selected instanceof Response) return selected;
    try {
      return c.redirect(await fileService.contentUrl(selected.projectId, c.req.param("id")), 302);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  return app;
}

const adminCookie = (
  name: string,
  value: string,
  options: Readonly<{ maxAge: number; secure: boolean; httpOnly: boolean }>,
): string =>
  [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAge}`,
    "SameSite=Strict",
    options.httpOnly ? "HttpOnly" : undefined,
    options.secure ? "Secure" : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("; ");

export function createAdminApi(
  readiness: ReadinessProbe,
  security?: AdminApiSecurity,
  taskService?: AdminTaskUseCases,
  queryService?: AdminQueryService,
  managementService?: AdminManagementService,
): Hono {
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
  if (!security) return app;

  const authenticate = async (request: Request): Promise<AdminContext | Response> => {
    try {
      return await security.sessions.authenticate(request, requestId(request));
    } catch (error) {
      return serviceError(request, error);
    }
  };
  const authorize = async (request: Request, permission: AdminPermission): Promise<AdminContext | Response> => {
    const context = await authenticate(request);
    if (context instanceof Response) return context;
    try {
      await security.sessions.authorize(context, permission, request, requestId(request));
      return context;
    } catch (error) {
      return serviceError(request, error);
    }
  };

  const mutationContext = async (
    request: Request,
    permission: AdminPermission,
  ): Promise<
    | Readonly<{
        actor: AdminContext;
        key: string;
        metadata: { requestId: string; sourceIp?: string; userAgent?: string; traceId?: string };
      }>
    | Response
  > => {
    if (!managementService) {
      return errorResponse(
        requestId(request),
        503,
        "admin_management_service_unavailable",
        "Management service unavailable",
        true,
      );
    }
    const actor = await authorize(request, permission);
    if (actor instanceof Response) return actor;
    try {
      await security.sessions.verifyCsrf(actor, request, requestId(request));
    } catch (error) {
      return serviceError(request, error);
    }
    const key = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!idempotencyKeySchema.safeParse(key).success) {
      return errorResponse(
        requestId(request),
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must contain 8 to 128 visible characters",
        false,
        "Idempotency-Key",
      );
    }
    const sourceIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const traceId = request.headers.get("traceparent") ?? undefined;
    return {
      actor,
      key,
      metadata: {
        requestId: requestId(request),
        ...(sourceIp ? { sourceIp } : {}),
        ...(userAgent ? { userAgent } : {}),
        ...(traceId ? { traceId } : {}),
      },
    };
  };
  const requireVersion = (request: Request, expected: number): Response | undefined => {
    const raw = request.headers.get("if-match")?.trim() ?? "";
    const value = raw.match(/^(?:W\/)?"?(\d+)"?$/)?.[1];
    if (!value || Number(value) !== expected) {
      return errorResponse(
        requestId(request),
        409,
        "version_precondition_failed",
        "If-Match must equal expected_version",
        false,
        "If-Match",
      );
    }
    return undefined;
  };
  const managementResponse = (
    result: Readonly<{ status: number; body: Record<string, unknown>; replayed: boolean }>,
  ): Response =>
    new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json; charset=UTF-8", "Idempotency-Replayed": String(result.replayed) },
    });
  const management = (): AdminManagementService => {
    if (!managementService) throw new AdminManagementError("admin_management_service_unavailable", 503, true);
    return managementService;
  };

  app.post("/admin/v1/sessions/exchange", async (c) => {
    const parsed = await parseJson(adminSessionExchangeSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    const authorization = c.req.header("authorization");
    const idToken = authorization?.match(/^Bearer ([^\s]+)$/)?.[1] ?? "";
    try {
      const issued = await security.sessions.exchange(
        idToken,
        {
          organizationId: parsed.value?.organization_id ?? "",
          projectId: parsed.value?.project_id ?? "",
        },
        c.req.raw,
        requestId(c.req.raw),
      );
      c.header(
        "Set-Cookie",
        adminCookie(security.sessionCookieName, issued.sessionToken, {
          maxAge: security.sessionTtlSeconds,
          secure: security.secureCookies,
          httpOnly: true,
        }),
        { append: true },
      );
      c.header(
        "Set-Cookie",
        adminCookie(security.csrfCookieName, issued.csrfToken, {
          maxAge: security.sessionTtlSeconds,
          secure: security.secureCookies,
          httpOnly: false,
        }),
        { append: true },
      );
      c.header("Cache-Control", "no-store");
      return c.json(security.sessions.view(issued.context, issued.csrfToken), 201);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });

  app.get("/admin/v1/sessions/current", async (c) => {
    const context = await authenticate(c.req.raw);
    if (context instanceof Response) return context;
    c.header("Cache-Control", "no-store");
    return c.json(security.sessions.view(context));
  });

  const listRoute = (
    path: string,
    resource: Parameters<AdminQueryService["list"]>[1],
    permission: AdminPermission = "resources:read",
  ): void => {
    app.get(path, async (c) => {
      if (!queryService)
        return errorResponse(
          requestId(c.req.raw),
          503,
          "admin_query_service_unavailable",
          "Query service unavailable",
          true,
        );
      const context = await authorize(c.req.raw, permission);
      if (context instanceof Response) return context;
      const parsed = adminListQuerySchema.safeParse(c.req.query());
      if (!parsed.success) return errorResponse(requestId(c.req.raw), 400, "invalid_query", "Invalid pagination query");
      try {
        const query = { limit: parsed.data.limit, ...(parsed.data.after ? { after: parsed.data.after } : {}) };
        return c.json(
          await queryService.list(
            { organizationId: context.organizationId, projectId: context.projectId },
            resource,
            query,
          ),
        );
      } catch (error) {
        return serviceError(c.req.raw, error);
      }
    });
  };

  app.get("/admin/v1/tasks", async (c) => {
    if (!queryService)
      return errorResponse(
        requestId(c.req.raw),
        503,
        "admin_query_service_unavailable",
        "Query service unavailable",
        true,
      );
    const context = await authorize(c.req.raw, "tasks:read");
    if (context instanceof Response) return context;
    const parsed = adminListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(requestId(c.req.raw), 400, "invalid_query", "Invalid pagination query");
    try {
      const query = { limit: parsed.data.limit, ...(parsed.data.after ? { after: parsed.data.after } : {}) };
      return c.json(
        await queryService.listTasks({ organizationId: context.organizationId, projectId: context.projectId }, query),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/admin/v1/tasks/:id", async (c) => {
    if (!queryService)
      return errorResponse(
        requestId(c.req.raw),
        503,
        "admin_query_service_unavailable",
        "Query service unavailable",
        true,
      );
    const context = await authorize(c.req.raw, "tasks:read");
    if (context instanceof Response) return context;
    const detail = await queryService.taskDetail(
      { organizationId: context.organizationId, projectId: context.projectId },
      c.req.param("id"),
    );
    return detail ? c.json(detail) : errorResponse(requestId(c.req.raw), 404, "task_not_found", "Task not found");
  });
  listRoute("/admin/v1/models", "models");
  listRoute("/admin/v1/releases", "releases");
  listRoute("/admin/v1/pools", "pools");
  listRoute("/admin/v1/rollouts", "rollouts");
  listRoute("/admin/v1/workers", "workers");
  listRoute("/admin/v1/replicas", "replicas");
  listRoute("/admin/v1/provider-operations", "provider_operations");
  listRoute("/admin/v1/audit-events", "audit_events", "audit:read");
  listRoute("/admin/v1/regions", "regions");
  listRoute("/admin/v1/inventory", "inventory");
  listRoute("/admin/v1/aliases", "aliases");
  listRoute("/admin/v1/policies", "policies");
  listRoute("/admin/v1/policy-previews", "policy_previews");
  listRoute("/admin/v1/release-approvals", "release_approvals");

  app.post("/admin/v1/models", async (c) => {
    const mutation = await mutationContext(c.req.raw, "releases:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(modelCreateSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    try {
      return managementResponse(
        await management().createModel(mutation.actor, mutation.metadata, mutation.key, parsed.value),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.patch("/admin/v1/models/:id", async (c) => {
    const mutation = await mutationContext(c.req.raw, "releases:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(modelUpdateSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    const precondition = requireVersion(c.req.raw, parsed.value.expected_version);
    if (precondition) return precondition;
    try {
      return managementResponse(
        await management().updateModel(
          mutation.actor,
          mutation.metadata,
          mutation.key,
          c.req.param("id"),
          parsed.value,
        ),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/admin/v1/releases", async (c) => {
    const mutation = await mutationContext(c.req.raw, "releases:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(releaseCreateSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    try {
      return managementResponse(
        await management().createRelease(mutation.actor, mutation.metadata, mutation.key, parsed.value),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/admin/v1/releases/:id/approval", async (c) => {
    const mutation = await mutationContext(c.req.raw, "releases:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(releaseApprovalSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    const precondition = requireVersion(c.req.raw, parsed.value.expected_version);
    if (precondition) return precondition;
    try {
      return managementResponse(
        await management().approveRelease(
          mutation.actor,
          mutation.metadata,
          mutation.key,
          c.req.param("id"),
          parsed.value,
        ),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/admin/v1/pools", async (c) => {
    const mutation = await mutationContext(c.req.raw, "policies:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(poolCreateSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    try {
      return managementResponse(
        await management().createPool(mutation.actor, mutation.metadata, mutation.key, parsed.value),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.patch("/admin/v1/pools/:id", async (c) => {
    const mutation = await mutationContext(c.req.raw, "policies:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(poolUpdateSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    const precondition = requireVersion(c.req.raw, parsed.value.expected_version);
    if (precondition) return precondition;
    try {
      return managementResponse(
        await management().updatePool(mutation.actor, mutation.metadata, mutation.key, c.req.param("id"), parsed.value),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/admin/v1/policies/validate", async (c) => {
    const mutation = await mutationContext(c.req.raw, "policies:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(policyValidationSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    const schemaByType = {
      capacity: capacityPolicyConfigurationSchema,
      budget: budgetPolicyConfigurationSchema,
      region: regionPolicyConfigurationSchema,
      retry: retryPolicyConfigurationSchema,
    } as const;
    const configuration = schemaByType[parsed.value.policy_type].safeParse(parsed.value.configuration);
    if (!configuration.success)
      return errorResponse(
        requestId(c.req.raw),
        422,
        "invalid_policy_configuration",
        "Policy configuration failed schema validation",
      );
    try {
      return managementResponse(
        await management().validatePolicy(mutation.actor, mutation.metadata, mutation.key, {
          ...parsed.value,
          configuration: configuration.data,
        }),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/admin/v1/policies/:id/impact-previews", async (c) => {
    const mutation = await mutationContext(c.req.raw, "policies:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(policyImpactPreviewSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    const precondition = requireVersion(c.req.raw, parsed.value.expected_policy_version);
    if (precondition) return precondition;
    try {
      return managementResponse(
        await management().previewPolicy(
          mutation.actor,
          mutation.metadata,
          mutation.key,
          c.req.param("id"),
          parsed.value,
        ),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/admin/v1/policies/:id/publish", async (c) => {
    const mutation = await mutationContext(c.req.raw, "policies:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(policyPublishSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    const precondition = requireVersion(c.req.raw, parsed.value.expected_policy_version);
    if (precondition) return precondition;
    try {
      return managementResponse(
        await management().publishPolicy(
          mutation.actor,
          mutation.metadata,
          mutation.key,
          c.req.param("id"),
          parsed.value,
        ),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/admin/v1/pools/:poolId/policies/:policyType/rollback", async (c) => {
    const mutation = await mutationContext(c.req.raw, "policies:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(policyRollbackSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    const precondition = requireVersion(c.req.raw, parsed.value.expected_current_version);
    if (precondition) return precondition;
    const policyType = c.req.param("policyType");
    if (!["capacity", "budget", "region", "retry"].includes(policyType))
      return errorResponse(requestId(c.req.raw), 404, "policy_not_found", "Policy not found");
    try {
      return managementResponse(
        await management().rollbackPolicy(
          mutation.actor,
          mutation.metadata,
          mutation.key,
          c.req.param("poolId"),
          policyType,
          parsed.value,
        ),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.post("/admin/v1/aliases/:alias/switch", async (c) => {
    const mutation = await mutationContext(c.req.raw, "rollouts:write");
    if (mutation instanceof Response) return mutation;
    const parsed = await parseJson(aliasSwitchSchema, c.req.raw);
    if (parsed.response) return parsed.response;
    const precondition = requireVersion(c.req.raw, parsed.value.expected_version);
    if (precondition) return precondition;
    try {
      return managementResponse(
        await management().switchAlias(
          mutation.actor,
          mutation.metadata,
          mutation.key,
          c.req.param("alias"),
          parsed.value,
        ),
      );
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
  app.get("/admin/v1/cost-summary", async (c) => {
    if (!queryService)
      return errorResponse(
        requestId(c.req.raw),
        503,
        "admin_query_service_unavailable",
        "Query service unavailable",
        true,
      );
    const context = await authorize(c.req.raw, "resources:read");
    if (context instanceof Response) return context;
    return c.json(
      await queryService.costSummary({ organizationId: context.organizationId, projectId: context.projectId }),
    );
  });

  app.delete("/admin/v1/sessions/current", async (c) => {
    const context = await authenticate(c.req.raw);
    if (context instanceof Response) return context;
    try {
      await security.sessions.verifyCsrf(context, c.req.raw, requestId(c.req.raw));
      await security.sessions.revoke(context, c.req.raw, requestId(c.req.raw));
      c.header(
        "Set-Cookie",
        adminCookie(security.sessionCookieName, "", {
          maxAge: 0,
          secure: security.secureCookies,
          httpOnly: true,
        }),
        { append: true },
      );
      c.header(
        "Set-Cookie",
        adminCookie(security.csrfCookieName, "", {
          maxAge: 0,
          secure: security.secureCookies,
          httpOnly: false,
        }),
        { append: true },
      );
      return c.body(null, 204);
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });

  app.get("/admin/v1/tasks/:id/sensitive-request", async (c) => {
    if (!taskService)
      return errorResponse(
        requestId(c.req.raw),
        503,
        "admin_task_service_unavailable",
        "Task service unavailable",
        true,
      );
    const context = await authorize(c.req.raw, "tasks:read_sensitive");
    if (context instanceof Response) return context;
    const purpose = c.req.header("x-access-purpose")?.trim() ?? "";
    if (purpose.length < 8 || purpose.length > 500) {
      return errorResponse(
        requestId(c.req.raw),
        400,
        "invalid_access_purpose",
        "X-Access-Purpose must contain 8 to 500 characters",
        false,
        "X-Access-Purpose",
      );
    }
    const taskId = c.req.param("id");
    try {
      const task = await taskService.get(
        { organizationId: context.organizationId, projectId: context.projectId },
        taskId,
      );
      if (!task) {
        await security.sessions.recordSensitiveRead(
          context,
          taskId,
          purpose,
          c.req.raw,
          requestId(c.req.raw),
          "failure",
        );
        return errorResponse(requestId(c.req.raw), 404, "task_not_found", "Task not found");
      }
      await security.sessions.recordSensitiveRead(context, taskId, purpose, c.req.raw, requestId(c.req.raw), "success");
      c.header("Cache-Control", "no-store");
      return c.json({ task_id: task.id, request: task.request, accessed_at: Math.floor(Date.now() / 1000) });
    } catch (error) {
      return serviceError(c.req.raw, error);
    }
  });
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
