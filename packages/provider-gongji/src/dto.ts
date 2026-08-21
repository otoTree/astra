import type {
  ProviderCapacityOffer,
  ProviderObservationKind,
  ProviderObservationPage,
  ProviderObservedObject,
  ProviderRegion,
  ProviderErrorCode,
} from "@astra/provider-core";
import { ProviderError } from "@astra/provider-core";
import { payloadSha256, redactProviderPayload } from "./redaction.ts";

type JsonObject = Record<string, unknown>;

const object = (value: unknown, code: ProviderErrorCode = "invalid_provider_response"): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderError(code, false);
  return value as JsonObject;
};

const array = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new ProviderError("invalid_provider_response", false);
  return value;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;
const number = (value: unknown): number | undefined => {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
};

const unknownKeys = (value: JsonObject, allowed: ReadonlySet<string>, scope: string): string[] =>
  Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort()
    .map((key) => `unknown_field:${scope}.${key}`);

const envelopeFields = new Set(["code", "message", "data"]);
const listFields = new Set(["count", "results"]);

export const decodeGongjiEnvelope = (value: unknown): Readonly<{ data: JsonObject; quarantineReasons: string[] }> => {
  const envelope = object(value);
  if (text(envelope.code) !== "0000") throw new ProviderError("provider_unavailable", true);
  const data = object(envelope.data);
  return { data, quarantineReasons: unknownKeys(envelope, envelopeFields, "envelope") };
};

const page = (
  kind: ProviderObservationKind,
  endpoint: string,
  raw: unknown,
  objects: readonly ProviderObservedObject[],
  reasons: readonly string[],
): ProviderObservationPage => {
  const redactedPayload = redactProviderPayload(raw);
  return {
    kind,
    endpoint,
    objects,
    redactedPayload,
    payloadHash: payloadSha256(redactedPayload),
    quarantineReasons: [...new Set(reasons)].sort(),
  };
};

const commonTaskStates = new Set(["Pending", "Running", "Paused", "End"]);
const nodeStates = new Set(["Pending", "Running", "Succeeded", "Failed", "End", "Unknown"]);

const taskFields: Record<"deployment" | "batch_job" | "image_prewarm", ReadonlySet<string>> = {
  deployment: new Set([
    "task_id",
    "task_name",
    "status",
    "points",
    "runing_points",
    "billing_value",
    "resources",
    "services",
  ]),
  batch_job: new Set([
    "task_id",
    "task_name",
    "task_type",
    "sub_type",
    "resources",
    "status",
    "schedule_status",
    "points",
    "runing_points",
    "billing_value",
    "forecast_value",
    "create_time",
    "job_support",
    "job_status",
    "job_group",
    "termination_grace_period_seconds",
    "services",
  ]),
  image_prewarm: new Set([
    "task_id",
    "task_type",
    "task_name",
    "resources",
    "regions",
    "scheduler_strategy",
    "scheduler_resources",
    "status",
    "points",
    "used_points",
    "available_points",
    "scheduling_template",
    "create_time",
    "user_info",
    "region_cache_info",
    "services",
    "region_point_usage",
  ]),
};

const resourceIdentity = (item: JsonObject): Readonly<{ region?: string; gpuSku?: string }> => {
  const resources = Array.isArray(item.resources) ? item.resources : [];
  const first = resources[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return {};
  const resource = (first as JsonObject).resource;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return {};
  const region = text((resource as JsonObject).region);
  const gpuSku = text((resource as JsonObject).gpu_name);
  return { ...(region ? { region } : {}), ...(gpuSku ? { gpuSku } : {}) };
};

export const decodeTaskList = (
  kind: "deployment" | "batch_job" | "image_prewarm",
  endpoint: string,
  raw: unknown,
  observedAt: Date,
): ProviderObservationPage => {
  const decoded = decodeGongjiEnvelope(raw);
  const reasons = [...decoded.quarantineReasons, ...unknownKeys(decoded.data, listFields, `${kind}.data`)];
  const results = array(decoded.data.results);
  const objects = results.map((entry, index): ProviderObservedObject => {
    const item = object(entry);
    reasons.push(...unknownKeys(item, taskFields[kind], `${kind}.results[${index}]`));
    const providerId = text(item.task_id);
    const state = text(item.status);
    if (!providerId) reasons.push(`missing_field:${kind}.results[${index}].task_id`);
    if (!state || !commonTaskStates.has(state)) reasons.push(`unknown_state:${kind}:${state ?? "missing"}`);
    const identity = resourceIdentity(item);
    return {
      kind,
      providerId: providerId ?? `invalid-${index}`,
      ...(state ? { state } : {}),
      ...(identity.region ? { region: identity.region } : {}),
      ...(identity.gpuSku ? { gpuSku: identity.gpuSku } : {}),
      observedAt,
      attributes: {
        name: text(item.task_name) ?? null,
        requested_replicas: number(item.points) ?? null,
        running_replicas: number(item.runing_points) ?? null,
        billing_points: number(item.billing_value) ?? null,
      },
    };
  });
  return page(kind, endpoint, raw, objects, reasons);
};

const nodeFields = new Set([
  "point_id",
  "name",
  "status",
  "region",
  "region_name",
  "resource",
  "containers",
  "runing_time",
  "billing_value",
  "port_mappings",
  "describe_dto",
]);

export const decodeNodeList = (
  endpoint: string,
  raw: unknown,
  observedAt: Date,
  parentTaskId: string,
): ProviderObservationPage => {
  const decoded = decodeGongjiEnvelope(raw);
  const reasons = [...decoded.quarantineReasons, ...unknownKeys(decoded.data, listFields, "node.data")];
  const objects = array(decoded.data.results).map((entry, index): ProviderObservedObject => {
    const item = object(entry);
    reasons.push(...unknownKeys(item, nodeFields, `node.results[${index}]`));
    const providerId = text(item.point_id);
    const state = text(item.status);
    if (!providerId) reasons.push(`missing_field:node.results[${index}].point_id`);
    if (!state || !nodeStates.has(state)) reasons.push(`unknown_state:node:${state ?? "missing"}`);
    const resource = item.resource && typeof item.resource === "object" ? (item.resource as JsonObject) : {};
    const containers = Array.isArray(item.containers) ? item.containers : [];
    const firstContainer = containers[0] && typeof containers[0] === "object" ? (containers[0] as JsonObject) : {};
    const region = text(item.region);
    const gpuSku = text(resource.gpu_name);
    const imageReference = text(firstContainer.image);
    return {
      kind: "node",
      providerId: providerId ?? `invalid-${parentTaskId}-${index}`,
      ...(state ? { state } : {}),
      ...(region ? { region } : {}),
      ...(gpuSku ? { gpuSku } : {}),
      ...(imageReference ? { imageReference } : {}),
      observedAt,
      attributes: {
        parent_task_id: parentTaskId,
        name: text(item.name) ?? null,
        gpu_count: number(resource.gpu_count) ?? null,
        runtime_seconds: number(item.runing_time) ?? null,
        billing_points: number(item.billing_value) ?? null,
      },
    };
  });
  return page("node", endpoint, raw, objects, reasons);
};

const resourceResultFields = new Set([
  "device_name",
  "regions",
  "gpu_name",
  "gpu_memory",
  "gpu_count",
  "memory",
  "cpu_cores",
  "disk_size",
  "disk_type",
]);
const resourceRegionFields = new Set(["region", "region_name", "mark", "price", "discount_price", "inventory"]);

export const decodeResources = (
  endpoint: string,
  raw: unknown,
  observedAt: Date,
): Readonly<{ regions: ProviderRegion[]; offers: ProviderCapacityOffer[]; page: ProviderObservationPage }> => {
  const decoded = decodeGongjiEnvelope(raw);
  const reasons = [...decoded.quarantineReasons, ...unknownKeys(decoded.data, listFields, "resource.data")];
  const regions = new Map<string, ProviderRegion>();
  const offers: ProviderCapacityOffer[] = [];
  const objects: ProviderObservedObject[] = [];
  array(decoded.data.results).forEach((entry, index) => {
    const item = object(entry);
    reasons.push(...unknownKeys(item, resourceResultFields, `resource.results[${index}]`));
    const gpuSku = text(item.gpu_name);
    const gpuMemoryMib = number(item.gpu_memory);
    if (!gpuSku || gpuMemoryMib === undefined) reasons.push(`invalid_resource:resource.results[${index}]`);
    array(item.regions).forEach((regionEntry, regionIndex) => {
      const providerRegion = object(regionEntry);
      reasons.push(
        ...unknownKeys(providerRegion, resourceRegionFields, `resource.results[${index}].regions[${regionIndex}]`),
      );
      const region = text(providerRegion.region);
      const inventory = number(providerRegion.inventory);
      const price = number(providerRegion.discount_price) ?? number(providerRegion.price);
      if (!region || inventory === undefined || price === undefined) {
        reasons.push(`invalid_resource_offer:resource.results[${index}].regions[${regionIndex}]`);
        return;
      }
      regions.set(region, { id: region, healthy: true, allowed: true });
      const offer: ProviderCapacityOffer = {
        region,
        gpuSku: gpuSku ?? "unknown",
        gpuMemoryBytes: Math.max(0, Math.trunc(gpuMemoryMib ?? 0)) * 1024 * 1024,
        availableReplicas: Math.max(0, Math.trunc(inventory)),
        pricePerGpuHourMinor: Math.max(0, Math.trunc(price)),
        currency: "CNY",
        observedAt,
      };
      offers.push(offer);
      objects.push({
        kind: "resource",
        providerId: `${region}:${offer.gpuSku}`,
        region,
        gpuSku: offer.gpuSku,
        observedAt,
        attributes: {
          gpu_memory_bytes: offer.gpuMemoryBytes,
          available_replicas: offer.availableReplicas,
          price_per_gpu_hour_minor: offer.pricePerGpuHourMinor,
          currency: offer.currency,
          region_name: text(providerRegion.region_name) ?? null,
        },
      });
    });
  });
  return { regions: [...regions.values()], offers, page: page("resource", endpoint, raw, objects, reasons) };
};

export const decodeWarmupRegions = (endpoint: string, raw: unknown, observedAt: Date): ProviderObservationPage => {
  const decoded = decodeGongjiEnvelope(raw);
  const dataFields = new Set(["regions"]);
  const regionFields = new Set(["region", "region_name"]);
  const reasons = [...decoded.quarantineReasons, ...unknownKeys(decoded.data, dataFields, "image_prewarm_region.data")];
  const objects = array(decoded.data.regions).map((entry, index): ProviderObservedObject => {
    const item = object(entry);
    reasons.push(...unknownKeys(item, regionFields, `image_prewarm_region.regions[${index}]`));
    const region = text(item.region);
    if (!region) reasons.push(`missing_field:image_prewarm_region.regions[${index}].region`);
    return {
      kind: "image_prewarm_region",
      providerId: region ?? `invalid-${index}`,
      ...(region ? { region } : {}),
      observedAt,
      attributes: { name: text(item.region_name) ?? null },
    };
  });
  return page("image_prewarm_region", endpoint, raw, objects, reasons);
};

const billingFields = new Set(["billing_coin", "discount_coin", "start_time", "end_time"]);

export const decodeBilling = (endpoint: string, raw: unknown, observedAt: Date): ProviderObservationPage => {
  const decoded = decodeGongjiEnvelope(raw);
  const reasons = [...decoded.quarantineReasons, ...unknownKeys(decoded.data, listFields, "billing.data")];
  const objects = array(decoded.data.results).map((entry, index): ProviderObservedObject => {
    const item = object(entry);
    reasons.push(...unknownKeys(item, billingFields, `billing.results[${index}]`));
    const start = text(item.start_time);
    const end = text(item.end_time);
    const billedPoints = number(item.billing_coin);
    if (!start || !end || billedPoints === undefined) reasons.push(`invalid_billing:billing.results[${index}]`);
    return {
      kind: "billing",
      providerId: `${start ?? "missing"}:${end ?? index}`,
      observedAt,
      attributes: {
        period_start: start ?? null,
        period_end: end ?? null,
        billing_points: billedPoints ?? null,
        discount_points: number(item.discount_coin) ?? null,
        amount_minor: billedPoints === undefined ? null : Math.round(billedPoints / 1000),
        currency: "CNY",
      },
    };
  });
  return page("billing", endpoint, raw, objects, reasons);
};
