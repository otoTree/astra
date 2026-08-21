import {
  attemptMutationResponseSchema,
  completeOutputsResponseSchema,
  drainedWorkerResponseSchema,
  leasedAttemptSchema,
  prepareOutputsResponseSchema,
  rolloutValidationResponseSchema,
  workerHeartbeatResponseSchema,
  workerRegistrationResponseSchema,
  type CompleteAttempt,
  type CompleteOutputs,
  type DrainedWorker,
  type FailAttempt,
  type LeasedAttempt,
  type PrepareOutputs,
  type RolloutValidationReport,
  type WorkerHeartbeat,
  type WorkerHeartbeatResponse,
  type WorkerLeaseRequest,
  type WorkerRegistration,
  type WorkerRegistrationResponse,
} from "@astra/contracts";
import type { z } from "zod";

export class WorkerControlClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

type Session = Readonly<{ workerId: string; token: string }>;

export class WorkerControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMilliseconds: number,
  ) {}

  private async request<Schema extends z.ZodTypeAny>(
    path: string,
    init: RequestInit,
    schema: Schema,
    token?: string,
  ): Promise<z.output<Schema>> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch {
      throw new WorkerControlClientError(503, "worker_control_unavailable", true);
    }
    if (!response.ok) {
      let error: { code?: unknown; retryable?: unknown } = {};
      try {
        const body = (await response.json()) as { error?: { code?: unknown; retryable?: unknown } };
        error = body.error ?? {};
      } catch {
        error = {};
      }
      throw new WorkerControlClientError(
        response.status,
        typeof error.code === "string" ? error.code : "worker_control_request_failed",
        error.retryable === true || response.status === 429 || response.status >= 500,
      );
    }
    return schema.parse(await response.json());
  }

  register(input: WorkerRegistration, bootstrapToken: string): Promise<WorkerRegistrationResponse> {
    return this.request(
      "/internal/v1/workers/register",
      { method: "POST", body: JSON.stringify(input) },
      workerRegistrationResponseSchema,
      bootstrapToken,
    );
  }

  async lease(session: Session, input: WorkerLeaseRequest): Promise<LeasedAttempt | undefined> {
    let response: Response;
    try {
      response = await fetch(
        new URL(`/internal/v1/workers/${encodeURIComponent(session.workerId)}/lease`, this.baseUrl),
        {
          method: "POST",
          headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(this.timeoutMilliseconds),
        },
      );
    } catch {
      throw new WorkerControlClientError(503, "worker_control_unavailable", true);
    }
    if (response.status === 204) return undefined;
    if (!response.ok) return this.failed(response);
    return leasedAttemptSchema.parse(await response.json());
  }

  heartbeat(session: Session, input: WorkerHeartbeat): Promise<WorkerHeartbeatResponse> {
    return this.request(
      `/internal/v1/workers/${encodeURIComponent(session.workerId)}/heartbeat`,
      { method: "POST", body: JSON.stringify(input) },
      workerHeartbeatResponseSchema,
      session.token,
    );
  }

  reportRolloutValidation(session: Session, input: RolloutValidationReport) {
    return this.request(
      `/internal/v1/workers/${encodeURIComponent(session.workerId)}/rollout-validation`,
      { method: "POST", body: JSON.stringify(input) },
      rolloutValidationResponseSchema,
      session.token,
    );
  }

  prepareOutputs(session: Session, attemptId: string, input: PrepareOutputs) {
    return this.request(
      `/internal/v1/attempts/${encodeURIComponent(attemptId)}/prepare-outputs`,
      { method: "POST", body: JSON.stringify(input) },
      prepareOutputsResponseSchema,
      session.token,
    );
  }

  completeOutputs(session: Session, attemptId: string, input: CompleteOutputs) {
    return this.request(
      `/internal/v1/attempts/${encodeURIComponent(attemptId)}/complete-outputs`,
      { method: "POST", body: JSON.stringify(input) },
      completeOutputsResponseSchema,
      session.token,
    );
  }

  complete(session: Session, attemptId: string, input: CompleteAttempt) {
    return this.request(
      `/internal/v1/attempts/${encodeURIComponent(attemptId)}/complete`,
      { method: "POST", body: JSON.stringify(input) },
      attemptMutationResponseSchema,
      session.token,
    );
  }

  fail(session: Session, attemptId: string, input: FailAttempt) {
    return this.request(
      `/internal/v1/attempts/${encodeURIComponent(attemptId)}/fail`,
      { method: "POST", body: JSON.stringify(input) },
      attemptMutationResponseSchema,
      session.token,
    );
  }

  drained(session: Session, input: DrainedWorker) {
    return this.request(
      `/internal/v1/workers/${encodeURIComponent(session.workerId)}/drained`,
      { method: "POST", body: JSON.stringify(input) },
      drainedWorkerResponseSchema,
      session.token,
    );
  }

  private async failed(response: Response): Promise<never> {
    let body: { error?: { code?: unknown; retryable?: unknown } } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = {};
    }
    throw new WorkerControlClientError(
      response.status,
      typeof body.error?.code === "string" ? body.error.code : "worker_control_request_failed",
      body.error?.retryable === true || response.status === 429 || response.status >= 500,
    );
  }
}
