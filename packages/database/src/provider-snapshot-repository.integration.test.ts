import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDatabase, ProviderSnapshotRepository, type ProviderObservationBundleInput } from "./index.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integration = database ? test : test.skip;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("Provider snapshot repository", () => {
  integration("publishes atomically, quarantines drift and suppresses stale inventory", async () => {
    if (!database) return;
    let timestamp = new Date("2026-08-22T01:00:00.000Z");
    let sequence = 0;
    const provider = `reference-${Bun.randomUUIDv7()}`;
    const repository = new ProviderSnapshotRepository(
      database.client,
      () => timestamp,
      (prefix) => `${prefix}_${provider}_${sequence++}`,
    );
    const bundle = (inventory: number, quarantineReasons: readonly string[] = []): ProviderObservationBundleInput => ({
      provider,
      contractVersion: "contract-v1",
      observedAt: timestamp,
      resources: {
        regions: [{ id: "region-a", healthy: true, allowed: true }],
        offers: [
          {
            region: "region-a",
            gpuSku: "5090",
            gpuMemoryBytes: 32 * 1024 * 1024 * 1024,
            availableReplicas: inventory,
            pricePerGpuHourMinor: 300,
            currency: "CNY",
            observedAt: timestamp,
          },
        ],
      },
      pages: [
        {
          kind: "resource",
          endpoint: "/resources",
          payloadHash: hash(`inventory:${inventory}`),
          redactedPayload: { inventory },
          quarantineReasons,
          objects: [
            {
              kind: "resource",
              providerId: "region-a:5090",
              region: "region-a",
              gpuSku: "5090",
              observedAt: timestamp,
              attributes: { available_replicas: inventory, region_name: "Region A" },
            },
          ],
        },
      ],
    });

    const published = await repository.publish(bundle(20), 300);
    expect(published.status).toBe("fresh");
    expect(published.usable).toBe(true);
    const inventory = await database.client`SELECT available_replicas, snapshot_version
      FROM provider_inventory WHERE provider=${provider}`;
    expect(Number(inventory[0]?.available_replicas)).toBe(20);
    const publishedVersion = String(inventory[0]?.snapshot_version);

    timestamp = new Date(timestamp.getTime() + 60_000);
    const quarantined = await repository.publish(bundle(0, ["unknown_field:resource.future"]), 300);
    expect(quarantined.status).toBe("quarantined");
    expect(quarantined.usable).toBe(true);
    expect(quarantined.latestPublishedRunId).toBe(published.latestPublishedRunId);
    const unchanged = await database.client`SELECT available_replicas, snapshot_version
      FROM provider_inventory WHERE provider=${provider}`;
    expect(Number(unchanged[0]?.available_replicas)).toBe(20);
    expect(String(unchanged[0]?.snapshot_version)).toBe(publishedVersion);

    const quarantineRun = await database.client`SELECT id FROM provider_snapshot_runs
      WHERE provider=${provider} AND status='quarantined' ORDER BY observed_at DESC LIMIT 1`;
    await expect(
      (async () => {
        await database.client`UPDATE provider_snapshot_pages SET endpoint='/changed'
          WHERE run_id=${String(quarantineRun[0]?.id)}`;
      })(),
    ).rejects.toThrow();

    timestamp = new Date(timestamp.getTime() + 60_000);
    const failed = await repository.recordFailure(provider, "contract-v1", "rate_limited", 300);
    expect(failed.status).toBe("failed");
    expect(failed.usable).toBe(true);
    expect(failed.lastErrorCode).toBe("rate_limited");

    timestamp = new Date(timestamp.getTime() + 301_000);
    const stale = await repository.freshness(provider);
    expect(stale.status).toBe("stale");
    expect(stale.usable).toBe(false);
  });
});

process.on("beforeExit", () => database?.client.end());
