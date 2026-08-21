import { loadProviderControllerConfig } from "@astra/config";
import { createDatabase, DatabaseHealth, ProviderSnapshotRepository } from "@astra/database";
import { Counter, createLogger, createMetricRegistry, Gauge, Histogram, metricResponse } from "@astra/observability";
import type { ProviderObservationReader } from "@astra/provider-core";
import { ProviderError } from "@astra/provider-core";
import { GongjiReadClient, ReferenceProviderObservationReader } from "@astra/provider-gongji";

const config = loadProviderControllerConfig();
const logger = createLogger("provider-controller");
const port = config.PROVIDER_CONTROLLER_METRICS_PORT;
const database = createDatabase(config.DATABASE_URL);
const databaseHealth = new DatabaseHealth(database.client);
const repository = new ProviderSnapshotRepository(database.client);
const provider = config.PROVIDER_DRIVER;
const reader: ProviderObservationReader =
  provider === "reference"
    ? new ReferenceProviderObservationReader()
    : new GongjiReadClient({
        endpoint: config.GONGJI_ENDPOINT as string,
        credentials: () => ({
          token: process.env.GONGJI_TOKEN ?? (config.GONGJI_TOKEN as string),
          privateKeyPem: (process.env.GONGJI_PRIVATE_KEY_PEM ?? (config.GONGJI_PRIVATE_KEY_PEM as string)).replace(
            /\\n/g,
            "\n",
          ),
        }),
        timeoutMilliseconds: config.PROVIDER_REQUEST_TIMEOUT_SECONDS * 1000,
        maximumRetries: config.PROVIDER_MAXIMUM_RETRIES,
        breakerFailureThreshold: config.PROVIDER_BREAKER_FAILURE_THRESHOLD,
        breakerCooldownMilliseconds: config.PROVIDER_BREAKER_COOLDOWN_SECONDS * 1000,
        pageSize: config.PROVIDER_PAGE_SIZE,
        maximumPages: config.PROVIDER_MAXIMUM_PAGES,
      });

const metrics = createMetricRegistry("provider-controller");
const syncTotal = new Counter({
  name: "astra_provider_snapshot_sync_total",
  help: "Provider observation sync outcomes",
  labelNames: ["provider", "outcome"] as const,
  registers: [metrics],
});
const syncDuration = new Histogram({
  name: "astra_provider_snapshot_sync_duration_seconds",
  help: "Provider observation sync duration",
  labelNames: ["provider"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [metrics],
});
const snapshotAge = new Gauge({
  name: "astra_provider_snapshot_age_seconds",
  help: "Age of the latest published Provider snapshot",
  labelNames: ["provider"] as const,
  registers: [metrics],
});
const snapshotUsable = new Gauge({
  name: "astra_provider_snapshot_usable",
  help: "Whether Provider inventory is fresh enough for placement and capacity actions",
  labelNames: ["provider"] as const,
  registers: [metrics],
});
const quarantinedObjects = new Gauge({
  name: "astra_provider_snapshot_quarantine_reasons",
  help: "Quarantine reasons in the most recent observation",
  labelNames: ["provider"] as const,
  registers: [metrics],
});

const abort = new AbortController();
let latestStatus: Awaited<ReturnType<ProviderSnapshotRepository["freshness"]>> | undefined;
let syncing = false;

const synchronize = async (): Promise<void> => {
  if (syncing) return;
  syncing = true;
  const stopTimer = syncDuration.startTimer({ provider });
  try {
    const startedAt = new Date();
    const bundle = await reader.observe({
      operationId: `observe_${Bun.randomUUIDv7()}`,
      requestId: `provider_sync_${Bun.randomUUIDv7()}`,
      deadlineAt: new Date(
        startedAt.getTime() +
          Math.max(config.PROVIDER_REQUEST_TIMEOUT_SECONDS * 1000, config.PROVIDER_SYNC_INTERVAL_SECONDS * 1000),
      ),
    });
    latestStatus = await repository.publish(bundle, config.PROVIDER_SNAPSHOT_STALE_SECONDS);
    const reasonCount = bundle.pages.reduce((total, page) => total + page.quarantineReasons.length, 0);
    quarantinedObjects.set({ provider }, reasonCount);
    syncTotal.inc({ provider, outcome: latestStatus.status });
    if (latestStatus.status === "quarantined") {
      logger.error("provider_snapshot_quarantined", {
        provider,
        run_id: latestStatus.latestAttemptRunId,
        quarantine_reasons: reasonCount,
      });
    } else {
      logger.info("provider_snapshot_published", {
        provider,
        run_id: latestStatus.latestAttemptRunId,
        object_count: bundle.pages.reduce((total, page) => total + page.objects.length, 0),
      });
    }
  } catch (error) {
    const errorCode =
      error instanceof ProviderError ? error.code : error instanceof Error ? error.message : "sync_failed";
    latestStatus = await repository.recordFailure(
      provider,
      provider === "gongji" ? "gongji-openapi-2026-08-19" : "reference-provider-contract-v1",
      errorCode,
      config.PROVIDER_SNAPSHOT_STALE_SECONDS,
    );
    syncTotal.inc({ provider, outcome: "failed" });
    logger.error("provider_snapshot_sync_failed", { provider, error_code: errorCode });
  } finally {
    stopTimer();
    syncing = false;
  }
};

const loop = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    await synchronize();
    if (abort.signal.aborted) break;
    await Bun.sleep(config.PROVIDER_SYNC_INTERVAL_SECONDS * 1000);
  }
};
void loop();

const server = Bun.serve({
  port,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/health/live") {
      return Response.json({ status: "live", component: "provider-controller", env: config.ASTRA_ENV });
    }
    if (path === "/health/ready") {
      const databaseReady = await databaseHealth.ready();
      if (latestStatus) {
        latestStatus = await repository.freshness(provider);
        snapshotAge.set({ provider }, latestStatus.ageSeconds ?? 0);
        snapshotUsable.set({ provider }, latestStatus.usable ? 1 : 0);
      }
      const ready = databaseReady && latestStatus?.usable === true;
      return Response.json(
        {
          status: ready ? "ready" : "not_ready",
          database: databaseReady ? "ready" : "unavailable",
          provider,
          observation_status: latestStatus?.status ?? "pending",
          snapshot_usable: latestStatus?.usable ?? false,
          snapshot_age_seconds: latestStatus?.ageSeconds,
          latest_attempt_run_id: latestStatus?.latestAttemptRunId,
          latest_published_run_id: latestStatus?.latestPublishedRunId,
          last_error_code: latestStatus?.lastErrorCode,
        },
        { status: ready ? 200 : 503 },
      );
    }
    if (path === "/metrics") return metricResponse(metrics);
    return Response.json({ error: { code: "not_found", message: "Route not found" } }, { status: 404 });
  },
});

const shutdown = async (): Promise<void> => {
  if (abort.signal.aborted) return;
  abort.abort();
  server.stop(false);
  await database.client.end();
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
logger.info("provider_controller_started", { port });
