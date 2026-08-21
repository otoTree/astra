import { createHash } from "node:crypto";
import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

export type ProviderObservationBundleInput = Readonly<{
  provider: string;
  contractVersion: string;
  observedAt: Date;
  resources: Readonly<{
    regions: readonly Readonly<{ id: string; healthy: boolean; allowed: boolean }>[];
    offers: readonly Readonly<{
      region: string;
      gpuSku: string;
      gpuMemoryBytes: number;
      availableReplicas: number;
      pricePerGpuHourMinor: number;
      currency: string;
      observedAt: Date;
    }>[];
  }>;
  pages: readonly Readonly<{
    kind: string;
    endpoint: string;
    payloadHash: string;
    redactedPayload: unknown;
    quarantineReasons: readonly string[];
    objects: readonly Readonly<{
      kind: string;
      providerId: string;
      state?: string;
      region?: string;
      gpuSku?: string;
      imageReference?: string;
      observedAt: Date;
      attributes: Readonly<Record<string, string | number | boolean | null>>;
    }>[];
  }>[];
}>;

export type ProviderSnapshotFreshness = Readonly<{
  provider: string;
  latestAttemptRunId: string;
  latestPublishedRunId?: string;
  status: "fresh" | "stale" | "quarantined" | "failed";
  observedAt?: Date;
  expiresAt?: Date;
  ageSeconds?: number;
  usable: boolean;
  lastErrorCode?: string;
  version: number;
}>;

const providerRegionId = (provider: string, region: string): string =>
  provider === "reference" ? region : `${provider}:${region}`;

const snapshotDigest = (hashes: readonly string[]): string =>
  createHash("sha256")
    .update([...hashes].sort().join("\n"))
    .digest("hex");

export class ProviderSnapshotRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: (prefix: string) => string = (prefix) => `${prefix}_${Bun.randomUUIDv7()}`,
  ) {}

  async publish(bundle: ProviderObservationBundleInput, staleAfterSeconds: number): Promise<ProviderSnapshotFreshness> {
    if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 1)
      throw new Error("invalid_snapshot_stale_seconds");
    const startedAt = this.now();
    const expiresAt = new Date(bundle.observedAt.getTime() + staleAfterSeconds * 1000);
    const runId = this.createId("provider_snapshot");
    const allObjects = bundle.pages.flatMap((page) => page.objects);
    const seen = new Set<string>();
    const duplicateReasons: string[] = [];
    for (const object of allObjects) {
      const key = `${object.kind}:${object.providerId}`;
      if (seen.has(key)) duplicateReasons.push(`duplicate_object:${key}`);
      seen.add(key);
    }
    const quarantineReasons = [
      ...new Set([...bundle.pages.flatMap((page) => page.quarantineReasons), ...duplicateReasons]),
    ].sort();
    const status = quarantineReasons.length === 0 ? "published" : "quarantined";
    const payloadHash = snapshotDigest(bundle.pages.map((page) => page.payloadHash));

    await this.sql.begin(async (transaction) => {
      await transaction`INSERT INTO provider_snapshot_runs (
          id, provider, contract_version, status, observed_at, expires_at, payload_hash, object_count,
          quarantine_reasons, started_at, completed_at
        ) VALUES (
          ${runId}, ${bundle.provider}, ${bundle.contractVersion}, ${status}, ${bundle.observedAt.toISOString()},
          ${expiresAt.toISOString()}, ${payloadHash}, ${allObjects.length}, ${JSON.stringify(quarantineReasons)},
          ${startedAt.toISOString()}, ${this.now().toISOString()}
        )`;
      for (const page of bundle.pages) {
        await transaction`INSERT INTO provider_snapshot_pages (
            id, run_id, kind, endpoint, payload_hash, redacted_payload, quarantine_reasons, created_at
          ) VALUES (
            ${this.createId("provider_page")}, ${runId}, ${page.kind}, ${page.endpoint}, ${page.payloadHash},
            ${JSON.stringify(page.redactedPayload)}, ${JSON.stringify(page.quarantineReasons)},
            ${this.now().toISOString()}
          )`;
      }
      for (const object of allObjects) {
        if (duplicateReasons.includes(`duplicate_object:${object.kind}:${object.providerId}`)) continue;
        await transaction`INSERT INTO provider_snapshot_objects (
            id, run_id, provider, kind, provider_resource_id, normalized, observed_at, created_at
          ) VALUES (
            ${this.createId("provider_object")}, ${runId}, ${bundle.provider}, ${object.kind}, ${object.providerId},
            ${JSON.stringify({
              state: object.state,
              region: object.region,
              gpu_sku: object.gpuSku,
              image_reference: object.imageReference,
              attributes: object.attributes,
            })}, ${object.observedAt.toISOString()}, ${this.now().toISOString()}
          )`;
      }

      if (status === "published") {
        const snapshotVersion = runId;
        const regionNames = new Map<string, string>();
        for (const page of bundle.pages) {
          for (const object of page.objects) {
            if (!object.region) continue;
            const name = object.attributes.region_name;
            if (typeof name === "string" && name.length > 0) regionNames.set(object.region, name);
          }
        }
        for (const region of bundle.resources.regions) {
          const regionId = providerRegionId(bundle.provider, region.id);
          await transaction`INSERT INTO provider_regions (
              id, provider, name, status, snapshot_version, observed_at, created_at, updated_at
            ) VALUES (
              ${regionId}, ${bundle.provider}, ${regionNames.get(region.id) ?? region.id},
              ${region.healthy && region.allowed ? "healthy" : "unavailable"}, ${snapshotVersion},
              ${bundle.observedAt.toISOString()}, ${this.now().toISOString()}, ${this.now().toISOString()}
            ) ON CONFLICT (id) DO UPDATE SET
              name=EXCLUDED.name, status=EXCLUDED.status, snapshot_version=EXCLUDED.snapshot_version,
              observed_at=EXCLUDED.observed_at, updated_at=EXCLUDED.updated_at
              WHERE provider_regions.provider=EXCLUDED.provider`;
        }
        await transaction`UPDATE provider_regions SET status='unavailable', updated_at=${this.now().toISOString()}
          WHERE provider=${bundle.provider} AND snapshot_version IS DISTINCT FROM ${snapshotVersion}`;
        for (const offer of bundle.resources.offers) {
          const regionId = providerRegionId(bundle.provider, offer.region);
          const inventoryId = `inventory:${bundle.provider}:${offer.region}:${offer.gpuSku}`;
          await transaction`INSERT INTO provider_inventory (
              id, provider, region_id, gpu_sku, gpu_memory_bytes, available_replicas,
              price_per_gpu_hour_minor, currency, snapshot_version, observed_at, created_at
            ) VALUES (
              ${inventoryId}, ${bundle.provider}, ${regionId}, ${offer.gpuSku}, ${offer.gpuMemoryBytes},
              ${offer.availableReplicas}, ${offer.pricePerGpuHourMinor}, ${offer.currency}, ${snapshotVersion},
              ${offer.observedAt.toISOString()}, ${this.now().toISOString()}
            ) ON CONFLICT (provider, region_id, gpu_sku) DO UPDATE SET
              gpu_memory_bytes=EXCLUDED.gpu_memory_bytes,
              available_replicas=EXCLUDED.available_replicas,
              price_per_gpu_hour_minor=EXCLUDED.price_per_gpu_hour_minor,
              currency=EXCLUDED.currency,
              snapshot_version=EXCLUDED.snapshot_version,
              observed_at=EXCLUDED.observed_at`;
        }
        await transaction`DELETE FROM provider_inventory
          WHERE provider=${bundle.provider} AND snapshot_version<>${snapshotVersion}`;
      }

      await transaction`INSERT INTO provider_snapshot_state (
          provider, latest_attempt_run_id, latest_published_run_id, status, observed_at, expires_at,
          version, last_error_code, updated_at
        ) VALUES (
          ${bundle.provider}, ${runId}, ${status === "published" ? runId : null},
          ${status === "published" ? "fresh" : "quarantined"},
          ${status === "published" ? bundle.observedAt.toISOString() : null},
          ${status === "published" ? expiresAt.toISOString() : null}, 1, null, ${this.now().toISOString()}
        ) ON CONFLICT (provider) DO UPDATE SET
          latest_attempt_run_id=EXCLUDED.latest_attempt_run_id,
          latest_published_run_id=COALESCE(EXCLUDED.latest_published_run_id, provider_snapshot_state.latest_published_run_id),
          status=EXCLUDED.status,
          observed_at=COALESCE(EXCLUDED.observed_at, provider_snapshot_state.observed_at),
          expires_at=COALESCE(EXCLUDED.expires_at, provider_snapshot_state.expires_at),
          version=provider_snapshot_state.version+1,
          last_error_code=NULL,
          updated_at=EXCLUDED.updated_at`;
    });
    return this.freshness(bundle.provider);
  }

  async recordFailure(
    provider: string,
    contractVersion: string,
    errorCode: string,
    staleAfterSeconds: number,
  ): Promise<ProviderSnapshotFreshness> {
    const timestamp = this.now();
    const runId = this.createId("provider_snapshot");
    await this.sql.begin(async (transaction) => {
      await transaction`INSERT INTO provider_snapshot_runs (
          id, provider, contract_version, status, observed_at, expires_at, object_count,
          quarantine_reasons, error_code, started_at, completed_at
        ) VALUES (
          ${runId}, ${provider}, ${contractVersion}, 'failed', ${timestamp.toISOString()},
          ${new Date(timestamp.getTime() + staleAfterSeconds * 1000).toISOString()}, 0,
          '[]'::jsonb, ${errorCode}, ${timestamp.toISOString()}, ${timestamp.toISOString()}
        )`;
      await transaction`INSERT INTO provider_snapshot_state (
          provider, latest_attempt_run_id, status, version, last_error_code, updated_at
        ) VALUES (${provider}, ${runId}, 'failed', 1, ${errorCode}, ${timestamp.toISOString()})
        ON CONFLICT (provider) DO UPDATE SET
          latest_attempt_run_id=EXCLUDED.latest_attempt_run_id,
          status='failed', version=provider_snapshot_state.version+1,
          last_error_code=EXCLUDED.last_error_code, updated_at=EXCLUDED.updated_at`;
    });
    return this.freshness(provider);
  }

  async freshness(provider: string): Promise<ProviderSnapshotFreshness> {
    const rows = await this.sql`SELECT provider, latest_attempt_run_id, latest_published_run_id,
        status, observed_at, expires_at, version, last_error_code
      FROM provider_snapshot_state WHERE provider=${provider}`;
    const row = rows[0];
    if (!row) throw new Error("provider_snapshot_state_not_found");
    const timestamp = this.now();
    const observedAt = row.observed_at ? new Date(row.observed_at as Date | string) : undefined;
    const expiresAt = row.expires_at ? new Date(row.expires_at as Date | string) : undefined;
    const usable = expiresAt !== undefined && expiresAt > timestamp;
    const storedStatus = String(row.status) as "fresh" | "stale" | "quarantined" | "failed";
    return {
      provider: String(row.provider),
      latestAttemptRunId: String(row.latest_attempt_run_id),
      ...(row.latest_published_run_id ? { latestPublishedRunId: String(row.latest_published_run_id) } : {}),
      status: usable ? storedStatus : "stale",
      ...(observedAt
        ? { observedAt, ageSeconds: Math.max(0, (timestamp.getTime() - observedAt.getTime()) / 1000) }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
      usable,
      ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
      version: Number(row.version),
    };
  }
}
