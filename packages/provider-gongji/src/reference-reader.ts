import type {
  ProviderObservationBundle,
  ProviderObservationReader,
  ProviderOperationContext,
} from "@astra/provider-core";
import { payloadSha256 } from "./redaction.ts";

export class ReferenceProviderObservationReader implements ProviderObservationReader {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async observe(_context: ProviderOperationContext): Promise<ProviderObservationBundle> {
    const observedAt = this.now();
    const payload = {
      source: "astra-reference-provider-contract-v1",
      regions: [{ id: "region_local", name: "Local contract region" }],
      offers: [{ region: "region_local", gpu_sku: "reference-gpu", inventory: 20 }],
    };
    return {
      provider: "reference",
      contractVersion: "reference-provider-contract-v1",
      observedAt,
      resources: {
        provider: "reference",
        version: "reference-provider-contract-v1",
        observedAt,
        regions: [{ id: "region_local", healthy: true, allowed: true }],
        offers: [
          {
            region: "region_local",
            gpuSku: "reference-gpu",
            gpuMemoryBytes: 32 * 1024 * 1024 * 1024,
            availableReplicas: 20,
            pricePerGpuHourMinor: 300,
            currency: "CNY",
            observedAt,
          },
        ],
      },
      pages: [
        {
          kind: "resource",
          endpoint: "reference://resources",
          objects: [
            {
              kind: "resource",
              providerId: "region_local:reference-gpu",
              region: "region_local",
              gpuSku: "reference-gpu",
              observedAt,
              attributes: {
                gpu_memory_bytes: 32 * 1024 * 1024 * 1024,
                available_replicas: 20,
                price_per_gpu_hour_minor: 300,
                currency: "CNY",
              },
            },
          ],
          redactedPayload: payload,
          payloadHash: payloadSha256(payload),
          quarantineReasons: [],
        },
      ],
    };
  }
}
