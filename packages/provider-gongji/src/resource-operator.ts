import { createHash } from "node:crypto";
import {
  ProviderError,
  type ProviderImageWarmup,
  type ProviderOperationContext,
  type ProviderReplica,
  type ProviderResourceOperator,
} from "@astra/provider-core";
import { mapGongjiError, retryAfterSeconds } from "./errors.ts";
import type { GongjiReadClient, GongjiResourceSelection } from "./read-client.ts";
import type { GongjiCredentials } from "./signing.ts";
import { signGongjiRequest } from "./signing.ts";

type JsonObject = Record<string, unknown>;

export type GongjiWriteTransportOptions = Readonly<{
  endpoint: string;
  credentials: () => GongjiCredentials | Promise<GongjiCredentials>;
  timeoutMilliseconds: number;
  breakerFailureThreshold: number;
  breakerCooldownMilliseconds: number;
  now?: () => Date;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}>;

export class GongjiWriteTransport {
  private readonly endpoint: string;
  private readonly now: () => Date;
  private readonly request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(private readonly options: GongjiWriteTransportOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.now = options.now ?? (() => new Date());
    this.request = options.fetch ?? globalThis.fetch;
  }

  async post(path: string, body: JsonObject, context: ProviderOperationContext): Promise<unknown> {
    if (this.now().getTime() < this.circuitOpenUntil) throw new ProviderError("provider_unavailable", true);
    const credentials = await this.options.credentials();
    if (!credentials.token) throw new ProviderError("authentication_failed", false);
    const timestampMilliseconds = this.now().getTime();
    const version = "1.0.0";
    const serialized = JSON.stringify(body);
    const controller = new AbortController();
    const timeout = Math.max(
      1,
      Math.min(this.options.timeoutMilliseconds, context.deadlineAt.getTime() - this.now().getTime()),
    );
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json",
        token: credentials.token,
      };
      if (credentials.privateKeyPem) {
        headers.timestamp = String(timestampMilliseconds);
        headers.version = version;
        headers.sign_str = signGongjiRequest({
          path,
          version,
          timestampMilliseconds,
          token: credentials.token,
          body: serialized,
          privateKeyPem: credentials.privateKeyPem,
        });
      }
      const response = await this.request(`${this.endpoint}${path}`, {
        method: "POST",
        headers,
        body: serialized,
        signal: controller.signal,
      });
      const raw = await response.json().catch(() => {
        throw new ProviderError("invalid_provider_response", false);
      });
      const code = raw && typeof raw === "object" ? String((raw as JsonObject).code ?? "") : "";
      if (!response.ok || code !== "0000") {
        throw mapGongjiError(code, response.status, retryAfterSeconds(response.headers));
      }
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      return raw;
    } catch (error) {
      const mapped =
        error instanceof ProviderError
          ? error
          : error instanceof DOMException && error.name === "AbortError"
            ? new ProviderError("operation_timeout", true)
            : new ProviderError("provider_unavailable", true);
      this.consecutiveFailures += 1;
      if (mapped.code === "authentication_failed" || this.consecutiveFailures >= this.options.breakerFailureThreshold) {
        this.circuitOpenUntil = this.now().getTime() + this.options.breakerCooldownMilliseconds;
      }
      throw mapped;
    } finally {
      clearTimeout(timer);
    }
  }
}

const paths = {
  createDeployment: "/api/task/deployment/create",
  pauseDeployment: "/api/deployment/task/pause",
  stopDeployment: "/api/deployment/task/stop",
  createWarmup: "/api/task/image_preheat/create",
} as const;

const operationName = (kind: string, operationId: string): string =>
  `astra-${kind}-${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;

const envelopeData = (raw: unknown): JsonObject => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ProviderError("invalid_provider_response", false);
  const envelope = raw as JsonObject;
  if (Object.keys(envelope).some((key) => !["code", "message", "data"].includes(key))) {
    throw new ProviderError("invalid_provider_response", false);
  }
  if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
    throw new ProviderError("invalid_provider_response", false);
  }
  return envelope.data as JsonObject;
};

const taskId = (raw: unknown): string => {
  const data = envelopeData(raw);
  if (Object.keys(data).some((key) => key !== "task_id")) throw new ProviderError("invalid_provider_response", false);
  const id = data.task_id;
  if (typeof id !== "string" && typeof id !== "number") throw new ProviderError("invalid_provider_response", false);
  return String(id);
};

const replicaState = (state: string | undefined): ProviderReplica["state"] => {
  if (state === "Pending") return "provisioning";
  if (state === "Running") return "ready";
  if (state === "Paused") return "draining";
  if (state === "End") return "terminated";
  throw new ProviderError("invalid_provider_response", false);
};

const assertPinnedReference = (imageDigest: string, imageReference?: string): string => {
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new ProviderError("invalid_provider_response", false);
  if (!imageReference?.endsWith(`@${imageDigest}`)) {
    throw new ProviderError("invalid_provider_response", false);
  }
  return imageReference;
};

const resourceBody = (selection: GongjiResourceSelection): JsonObject => ({
  resource: selection.resource,
  region_name: selection.regionName,
  mark: selection.mark,
  weight: 1,
});

const numericTaskId = (value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) throw new ProviderError("invalid_provider_response", false);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new ProviderError("invalid_provider_response", false);
  return result;
};

export class GongjiResourceOperator implements ProviderResourceOperator {
  constructor(
    private readonly reads: GongjiReadClient,
    private readonly writes: GongjiWriteTransport,
  ) {}

  async prewarmImage(
    input: Readonly<{ imageDigest: string; imageReference?: string; region: string; gpuSku: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderImageWarmup> {
    const name = operationName("prewarm", context.operationId);
    const existing = await this.reads.findWarmup({ name }, context);
    if (existing) {
      return {
        id: existing.providerId,
        imageDigest: input.imageDigest,
        region: input.region,
        gpuSku: input.gpuSku,
        state: existing.state === "Running" ? "pulling" : existing.state === "Pending" ? "requested" : "ready",
      };
    }
    const imageReference = assertPinnedReference(input.imageDigest, input.imageReference);
    const selection = await this.reads.selectResource(input.region, input.gpuSku, context);
    const raw = await this.writes.post(
      paths.createWarmup,
      {
        task_name: name,
        resources: [resourceBody(selection)],
        scheduler_strategy: { mode: "Unrestricted" },
        points: 1,
        services: [{ service_name: "astra-model", service_image: imageReference }],
      },
      context,
    );
    return {
      id: taskId(raw),
      imageDigest: input.imageDigest,
      region: input.region,
      gpuSku: input.gpuSku,
      state: "requested",
    };
  }

  async provisionReplica(
    input: Readonly<{
      imageDigest: string;
      imageReference?: string;
      region: string;
      gpuSku: string;
      environment?: Readonly<Record<string, string>>;
    }>,
    context: ProviderOperationContext,
  ): Promise<ProviderReplica> {
    const name = operationName("replica", context.operationId);
    const existing = await this.reads.findDeployment({ name }, context);
    if (existing) {
      return {
        id: existing.providerId,
        provider: "gongji",
        region: input.region,
        gpuSku: input.gpuSku,
        imageDigest: input.imageDigest,
        state: replicaState(existing.state),
      };
    }
    const imageReference = assertPinnedReference(input.imageDigest, input.imageReference);
    const selection = await this.reads.selectResource(input.region, input.gpuSku, context);
    const raw = await this.writes.post(
      paths.createDeployment,
      {
        task_type: "Deployment",
        task_name: name,
        resources: [resourceBody(selection)],
        scheduler_strategy: { mode: "Unrestricted" },
        points: 1,
        services: [
          {
            service_name: "astra-model",
            service_image: imageReference,
            resource_weight: { cpu_weight: 1, mem_weight: 1, gpu_weight: 1 },
            ...(input.environment
              ? {
                  env: Object.entries(input.environment)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([name, value]) => ({ name, value })),
                }
              : {}),
          },
        ],
      },
      context,
    );
    return {
      id: taskId(raw),
      provider: "gongji",
      region: input.region,
      gpuSku: input.gpuSku,
      imageDigest: input.imageDigest,
      state: "provisioning",
    };
  }

  async drainReplica(replicaId: string, context: ProviderOperationContext): Promise<void> {
    const current = await this.observeReplica(replicaId, context);
    if (current.state === "draining" || current.state === "terminated") return;
    await this.writes.post(paths.pauseDeployment, { task_id: numericTaskId(replicaId) }, context);
  }

  async terminateReplica(replicaId: string, context: ProviderOperationContext): Promise<void> {
    const current = await this.observeReplica(replicaId, context);
    if (current.state === "terminated") return;
    await this.writes.post(paths.stopDeployment, { task_id: numericTaskId(replicaId) }, context);
  }

  async observeReplica(
    replicaId: string,
    context: ProviderOperationContext,
  ): Promise<Readonly<{ id: string; state: ProviderReplica["state"] }>> {
    const task = await this.reads.findDeployment({ id: replicaId }, context);
    if (!task) throw new ProviderError("resource_not_found", false);
    return { id: replicaId, state: replicaState(task.state) };
  }
}
