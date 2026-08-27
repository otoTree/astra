import type {
  ProviderObservationBundle,
  ProviderObservationPage,
  ProviderObservationReader,
  ProviderObservedObject,
  ProviderOperationContext,
} from "@astra/provider-core";
import { ProviderError } from "@astra/provider-core";
import { decodeBilling, decodeNodeList, decodeResources, decodeTaskList, decodeWarmupRegions } from "./dto.ts";
import { mapGongjiError, retryAfterSeconds } from "./errors.ts";
import { type GongjiCredentials, signGongjiRequest } from "./signing.ts";

export type GongjiReadClientOptions = Readonly<{
  endpoint: string;
  credentials: () => GongjiCredentials | Promise<GongjiCredentials>;
  timeoutMilliseconds: number;
  maximumRetries: number;
  breakerFailureThreshold: number;
  breakerCooldownMilliseconds: number;
  pageSize: number;
  maximumPages: number;
  now?: () => Date;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}>;

export type GongjiResourceSelection = Readonly<{
  mark: string;
  regionName: string;
  resource: Readonly<Record<string, string | number | null>>;
}>;

type JsonObject = Record<string, unknown>;

const paths = {
  resources: "/api/deployment/resource/search",
  deployments: "/api/deployment/task/search",
  nodes: "/api/deployment/task/points",
  jobs: "/api/task/job/search",
  warmupRegions: "/api/task/image_preheat/get_regions",
  warmups: "/api/task/image_preheat/search",
  billing: "/api/billing/get_billing_record",
} as const;

const taskIds = (raw: unknown): string[] => {
  if (!raw || typeof raw !== "object") return [];
  const data = (raw as JsonObject).data;
  if (!data || typeof data !== "object") return [];
  const results = (data as JsonObject).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    if (!item || typeof item !== "object" || !("task_id" in item)) return [];
    const id = (item as JsonObject).task_id;
    return typeof id === "string" || typeof id === "number" ? [String(id)] : [];
  });
};

const resultCount = (raw: unknown): Readonly<{ count: number; returned: number }> => {
  if (!raw || typeof raw !== "object") return { count: 0, returned: 0 };
  const data = (raw as JsonObject).data;
  if (!data || typeof data !== "object") return { count: 0, returned: 0 };
  const results = (data as JsonObject).results;
  return {
    count: Math.max(0, Number((data as JsonObject).count) || 0),
    returned: Array.isArray(results) ? results.length : 0,
  };
};

export class GongjiReadClient implements ProviderObservationReader {
  private readonly endpoint: string;
  private readonly now: () => Date;
  private readonly request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly pause: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(private readonly options: GongjiReadClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.now = options.now ?? (() => new Date());
    this.request = options.fetch ?? globalThis.fetch;
    this.pause = options.sleep ?? Bun.sleep;
    this.random = options.random ?? Math.random;
  }

  circuitState(): "closed" | "open" | "half_open" {
    if (this.circuitOpenUntil === 0) return "closed";
    return this.now().getTime() < this.circuitOpenUntil ? "open" : "half_open";
  }

  async observe(context: ProviderOperationContext): Promise<ProviderObservationBundle> {
    const observedAt = this.now();
    const resourceRaw = await this.get(paths.resources, { task_type: "Deployment", device_type: "GpuDevice" }, context);
    const resourceResult = decodeResources(paths.resources, resourceRaw, observedAt);
    const pages: ProviderObservationPage[] = [resourceResult.page];

    const deploymentRaw = await this.list(paths.deployments, { type: "Deployment" }, context);
    for (const raw of deploymentRaw) pages.push(decodeTaskList("deployment", paths.deployments, raw, observedAt));

    const jobRaw = await this.list(paths.jobs, {}, context);
    for (const raw of jobRaw) pages.push(decodeTaskList("batch_job", paths.jobs, raw, observedAt));

    const nodeParents = [...new Set([...deploymentRaw.flatMap(taskIds), ...jobRaw.flatMap(taskIds)])].sort();
    for (const parentTaskId of nodeParents) {
      const nodeRaw = await this.list(paths.nodes, { task_id: parentTaskId }, context);
      for (const raw of nodeRaw) pages.push(decodeNodeList(paths.nodes, raw, observedAt, parentTaskId));
    }

    const warmupRegionsRaw = await this.get(paths.warmupRegions, {}, context);
    pages.push(decodeWarmupRegions(paths.warmupRegions, warmupRegionsRaw, observedAt));
    const warmupRaw = await this.list(paths.warmups, {}, context);
    for (const raw of warmupRaw) pages.push(decodeTaskList("image_prewarm", paths.warmups, raw, observedAt));

    const end = observedAt.toISOString();
    const start = new Date(observedAt.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const billingRaw = await this.list(paths.billing, { range: "day", start_time: start, end_time: end }, context);
    for (const raw of billingRaw) pages.push(decodeBilling(paths.billing, raw, observedAt));

    return {
      provider: "gongji",
      contractVersion: "gongji-openapi-2026-08-19",
      observedAt,
      resources: {
        provider: "gongji",
        version: "gongji-openapi-2026-08-19",
        observedAt,
        regions: resourceResult.regions,
        offers: resourceResult.offers,
      },
      pages,
    };
  }

  async selectResource(
    region: string,
    gpuSku: string,
    context: ProviderOperationContext,
  ): Promise<GongjiResourceSelection> {
    const raw = await this.get(paths.resources, { task_type: "Deployment", device_type: "GpuDevice" }, context);
    if (!raw || typeof raw !== "object") throw new ProviderError("invalid_provider_response", false);
    const data = (raw as JsonObject).data;
    const results = data && typeof data === "object" ? (data as JsonObject).results : undefined;
    if (!Array.isArray(results)) throw new ProviderError("invalid_provider_response", false);
    for (const item of results) {
      if (!item || typeof item !== "object") continue;
      const record = item as JsonObject;
      if (String(record.gpu_name ?? "") !== gpuSku || !Array.isArray(record.regions)) continue;
      for (const candidate of record.regions) {
        if (!candidate || typeof candidate !== "object") continue;
        const regionRecord = candidate as JsonObject;
        if (String(regionRecord.region ?? "") !== region) continue;
        const markRecord = regionRecord.mark;
        if (!markRecord || typeof markRecord !== "object" || Array.isArray(markRecord)) {
          throw new ProviderError("invalid_provider_response", false);
        }
        const mark = String((markRecord as JsonObject).mark ?? "");
        const resource = (markRecord as JsonObject).resource;
        if (!mark || !resource || typeof resource !== "object" || Array.isArray(resource)) {
          throw new ProviderError("invalid_provider_response", false);
        }
        const normalized = Object.fromEntries(
          Object.entries(resource as JsonObject).flatMap(([key, value]) =>
            typeof value === "string" || typeof value === "number" || value === null ? [[key, value]] : [],
          ),
        );
        return { mark, regionName: String(regionRecord.region_name ?? region), resource: normalized };
      }
    }
    throw new ProviderError("inventory_exhausted", true, 30);
  }

  async findDeployment(
    selector: Readonly<{ id?: string; name?: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderObservedObject | undefined> {
    const pages = await this.list(paths.deployments, selector.name ? { search_value: selector.name } : {}, context);
    return this.findTaskObject("deployment", paths.deployments, pages, selector);
  }

  async findWarmup(
    selector: Readonly<{ id?: string; name?: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderObservedObject | undefined> {
    const pages = await this.list(paths.warmups, selector.name ? { search_value: selector.name } : {}, context);
    return this.findTaskObject("image_prewarm", paths.warmups, pages, selector);
  }

  private findTaskObject(
    kind: "deployment" | "image_prewarm",
    path: string,
    rawPages: readonly unknown[],
    selector: Readonly<{ id?: string; name?: string }>,
  ): ProviderObservedObject | undefined {
    for (const raw of rawPages) {
      const decoded = decodeTaskList(kind, path, raw, this.now());
      if (decoded.quarantineReasons.length > 0) throw new ProviderError("invalid_provider_response", false);
      const found = decoded.objects.find(
        (object) =>
          (selector.id !== undefined && object.providerId === selector.id) ||
          (selector.name !== undefined && object.attributes.name === selector.name),
      );
      if (found) return found;
    }
    return undefined;
  }

  private async list(
    path: string,
    query: Readonly<Record<string, string>>,
    context: ProviderOperationContext,
  ): Promise<unknown[]> {
    const responses: unknown[] = [];
    for (let page = 1; page <= this.options.maximumPages; page += 1) {
      const raw = await this.get(
        path,
        { ...query, page: String(page), page_size: String(this.options.pageSize) },
        context,
      );
      responses.push(raw);
      const count = resultCount(raw);
      if (count.returned === 0 || page * this.options.pageSize >= count.count) return responses;
    }
    throw new ProviderError("invalid_provider_response", false);
  }

  private async get(
    path: string,
    query: Readonly<Record<string, string>>,
    context: ProviderOperationContext,
  ): Promise<unknown> {
    if (this.circuitState() === "open") throw new ProviderError("provider_unavailable", true);
    let lastError: ProviderError | undefined;
    for (let attempt = 0; attempt <= this.options.maximumRetries; attempt += 1) {
      if (this.now() >= context.deadlineAt) throw new ProviderError("operation_timeout", true);
      try {
        const response = await this.send(path, query, context.deadlineAt);
        const raw = await response.json().catch(() => {
          throw new ProviderError("invalid_provider_response", false);
        });
        const providerCode =
          raw && typeof raw === "object" && "code" in raw ? String((raw as JsonObject).code ?? "") : "";
        if (!response.ok || providerCode !== "0000") {
          throw mapGongjiError(providerCode, response.status, retryAfterSeconds(response.headers));
        }
        this.consecutiveFailures = 0;
        this.circuitOpenUntil = 0;
        return raw;
      } catch (error) {
        lastError =
          error instanceof ProviderError
            ? error
            : error instanceof DOMException && error.name === "AbortError"
              ? new ProviderError("operation_timeout", true)
              : new ProviderError("provider_unavailable", true);
        if (!lastError.retryable || attempt >= this.options.maximumRetries) break;
        const delay =
          lastError.retryAfterSeconds !== undefined
            ? lastError.retryAfterSeconds * 1000
            : Math.min(5_000, 200 * 2 ** attempt) * (0.8 + this.random() * 0.4);
        if (this.now().getTime() + delay >= context.deadlineAt.getTime()) break;
        await this.pause(delay);
      }
    }
    this.consecutiveFailures += 1;
    if (
      lastError?.code === "authentication_failed" ||
      this.consecutiveFailures >= this.options.breakerFailureThreshold
    ) {
      this.circuitOpenUntil = this.now().getTime() + this.options.breakerCooldownMilliseconds;
    }
    throw lastError ?? new ProviderError("provider_unavailable", true);
  }

  private async send(path: string, query: Readonly<Record<string, string>>, deadlineAt: Date): Promise<Response> {
    const credentials = await this.options.credentials();
    if (!credentials.token) throw new ProviderError("authentication_failed", false);
    const timestampMilliseconds = this.now().getTime();
    const version = "1.0.0";
    const url = new URL(`${this.endpoint}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timeout = Math.max(
      1,
      Math.min(this.options.timeoutMilliseconds, deadlineAt.getTime() - this.now().getTime()),
    );
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        token: credentials.token,
        timestamp: String(timestampMilliseconds),
        version,
      };
      if (credentials.privateKeyPem) {
        headers.sign_str = signGongjiRequest({
          path,
          version,
          timestampMilliseconds,
          token: credentials.token,
          body: "",
          privateKeyPem: credentials.privateKeyPem,
        });
      }
      return await this.request(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
