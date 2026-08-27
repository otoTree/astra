import { loadProviderControllerConfig } from "@astra/config";
import {
  createDatabase,
  DatabaseHealth,
  ProviderCredentialRepository,
  ProviderOperationRepository,
  ProviderSnapshotRepository,
  ProviderSyncRequestRepository,
  RequestCipher,
} from "@astra/database";
import { Counter, createLogger, createMetricRegistry, Gauge, Histogram, metricResponse } from "@astra/observability";
import type { ProviderObservationReader, ProviderResourceOperator } from "@astra/provider-core";
import { ProviderError } from "@astra/provider-core";
import {
  GongjiReadClient,
  GongjiResourceOperator,
  GongjiWriteTransport,
  ReferenceProviderObservationReader,
} from "@astra/provider-gongji";
import { ReferenceProviderOperator } from "@astra/provider-reference";
import { ProviderOperationReconciler } from "./reconciler.ts";
import { RolloutController } from "./rollout-controller.ts";

const config = loadProviderControllerConfig();
const logger = createLogger("provider-controller");
const port = config.PROVIDER_CONTROLLER_METRICS_PORT;
const database = createDatabase(config.DATABASE_URL);
const databaseHealth = new DatabaseHealth(database.client);
const repository = new ProviderSnapshotRepository(database.client);
const syncRequests = new ProviderSyncRequestRepository(database.client);
const credentialRepository = config.PROVIDER_CREDENTIAL_ENCRYPTION_KEY
  ? new ProviderCredentialRepository(database.client, new RequestCipher(config.PROVIDER_CREDENTIAL_ENCRYPTION_KEY))
  : undefined;
const operationRepository = new ProviderOperationRepository(
  database.client,
  () => new Date(),
  (prefix) => `${prefix}_${Bun.randomUUIDv7()}`,
  config.PROVIDER_OPERATION_ENCRYPTION_KEY,
);
const provider = config.PROVIDER_DRIVER;
const controllerId = `provider_controller_${Bun.randomUUIDv7()}`;
const gongjiEndpoint = config.GONGJI_ENDPOINT ?? "https://openapi.suanli.cn";
let credentialCache: Readonly<{ token: string; privateKeyPem?: string; loadedAt: number }> | undefined;
let credentialLoad: Promise<Readonly<{ token: string; privateKeyPem?: string }>> | undefined;
const credentials = async () => {
  if (credentialCache && Date.now() - credentialCache.loadedAt < 60_000) return credentialCache;
  credentialLoad ??= (async () => {
    const privateKeyPem = (process.env.GONGJI_PRIVATE_KEY_PEM ?? config.GONGJI_PRIVATE_KEY_PEM)?.replace(/\\n/g, "\n");
    if (!credentialRepository) throw new Error("provider_credential_encryption_key_missing");
    let stored = await credentialRepository.active("gongji");
    if (!stored && config.GONGJI_TOKEN && config.ASTRA_ENV !== "production") {
      await credentialRepository.putActive({
        provider: "gongji",
        token: config.GONGJI_TOKEN,
        createdBy: "local-bootstrap",
      });
      stored = await credentialRepository.active("gongji");
    }
    if (!stored) throw new Error("gongji_credential_unavailable");
    const token = credentialRepository.openToken(stored);
    const loaded = privateKeyPem ? { token, privateKeyPem } : { token };
    credentialCache = { ...loaded, loadedAt: Date.now() };
    return loaded;
  })();
  try {
    return await credentialLoad;
  } finally {
    credentialLoad = undefined;
  }
};
let reader: ProviderObservationReader;
let operator: ProviderResourceOperator;
const gongjiReads =
  (config.ASTRA_ENV === "local" && !config.ASTRA_LOCAL_ENABLE_REAL_PROVIDER) || !credentialRepository
    ? undefined
    : new GongjiReadClient({
        endpoint: gongjiEndpoint,
        credentials,
        timeoutMilliseconds: config.PROVIDER_REQUEST_TIMEOUT_SECONDS * 1000,
        maximumRetries: config.PROVIDER_MAXIMUM_RETRIES,
        breakerFailureThreshold: config.PROVIDER_BREAKER_FAILURE_THRESHOLD,
        breakerCooldownMilliseconds: config.PROVIDER_BREAKER_COOLDOWN_SECONDS * 1000,
        pageSize: config.PROVIDER_PAGE_SIZE,
        maximumPages: config.PROVIDER_MAXIMUM_PAGES,
      });
if (provider === "reference") {
  reader = new ReferenceProviderObservationReader();
  operator = new ReferenceProviderOperator();
} else {
  if (!gongjiReads) throw new Error("gongji_reader_unavailable");
  reader = gongjiReads;
  operator = new GongjiResourceOperator(
    gongjiReads,
    new GongjiWriteTransport({
      endpoint: gongjiEndpoint,
      credentials,
      timeoutMilliseconds: config.PROVIDER_OPERATION_TIMEOUT_SECONDS * 1000,
      breakerFailureThreshold: config.PROVIDER_BREAKER_FAILURE_THRESHOLD,
      breakerCooldownMilliseconds: config.PROVIDER_BREAKER_COOLDOWN_SECONDS * 1000,
    }),
  );
}
const operationReconciler = new ProviderOperationReconciler(
  operationRepository,
  { [provider]: operator },
  provider,
  controllerId,
  config.PROVIDER_OPERATION_LEASE_SECONDS,
  config.PROVIDER_OPERATION_TIMEOUT_SECONDS,
);
const rolloutController = new RolloutController(
  database.client,
  operationRepository,
  provider,
  config.WORKER_TOKEN_PEPPER,
  config.ROLLOUT_WORKER_CONTROL_URL,
);

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
const operationTotal = new Counter({
  name: "astra_provider_operation_total",
  help: "Provider operation reconcile outcomes",
  labelNames: ["provider", "outcome"] as const,
  registers: [metrics],
});
const operationBacklog = new Gauge({
  name: "astra_provider_operation_backlog",
  help: "Provider operations by type and status",
  labelNames: ["provider", "operation_type", "status"] as const,
  registers: [metrics],
});
const operationBacklogAge = new Gauge({
  name: "astra_provider_operation_oldest_age_seconds",
  help: "Age of the oldest unfinished Provider operation",
  labelNames: ["provider", "operation_type", "status"] as const,
  registers: [metrics],
});
const rolloutTotal = new Counter({
  name: "astra_rollout_reconcile_total",
  help: "Image rollout reconcile outcomes",
  labelNames: ["provider", "outcome"] as const,
  registers: [metrics],
});
const rolloutActive = new Gauge({
  name: "astra_rollout_active",
  help: "Active image rollouts by state",
  labelNames: ["provider", "status"] as const,
  registers: [metrics],
});
const rolloutAge = new Gauge({
  name: "astra_rollout_oldest_age_seconds",
  help: "Age of the oldest active image rollout",
  labelNames: ["provider"] as const,
  registers: [metrics],
});

const abort = new AbortController();
let latestStatus: Awaited<ReturnType<ProviderSnapshotRepository["freshness"]>> | undefined;
const syncingProviders = new Set<string>();
let operationLoopHealthy = true;
let rolloutLoopHealthy = true;

const synchronize = async (
  targetProvider: string,
  targetReader: ProviderObservationReader,
  onlyIfRequested = false,
): Promise<void> => {
  if (syncingProviders.has(targetProvider)) return;
  syncingProviders.add(targetProvider);
  let syncRequest: Awaited<ReturnType<ProviderSyncRequestRepository["claim"]>>;
  let stopTimer: (() => void) | undefined;
  try {
    syncRequest = await syncRequests.claim(targetProvider, controllerId, 120);
    if (onlyIfRequested && !syncRequest) return;
    stopTimer = syncDuration.startTimer({ provider: targetProvider });
    let status: Awaited<ReturnType<ProviderSnapshotRepository["publish"]>>;
    let errorCode: string | undefined;
    try {
      const startedAt = new Date();
      const bundle = await targetReader.observe({
        operationId: `observe_${Bun.randomUUIDv7()}`,
        requestId: `provider_sync_${Bun.randomUUIDv7()}`,
        deadlineAt: new Date(
          startedAt.getTime() +
            Math.max(config.PROVIDER_REQUEST_TIMEOUT_SECONDS * 1000, config.PROVIDER_SYNC_INTERVAL_SECONDS * 1000),
        ),
      });
      status = await repository.publish(bundle, config.PROVIDER_SNAPSHOT_STALE_SECONDS);
      const reasonCount = bundle.pages.reduce((total, page) => total + page.quarantineReasons.length, 0);
      quarantinedObjects.set({ provider: targetProvider }, reasonCount);
      syncTotal.inc({ provider: targetProvider, outcome: status.status });
      if (status.status === "quarantined") {
        errorCode = "snapshot_quarantined";
        logger.error("provider_snapshot_quarantined", {
          provider: targetProvider,
          run_id: status.latestAttemptRunId,
          quarantine_reasons: reasonCount,
        });
      } else {
        logger.info("provider_snapshot_published", {
          provider: targetProvider,
          run_id: status.latestAttemptRunId,
          object_count: bundle.pages.reduce((total, page) => total + page.objects.length, 0),
        });
      }
    } catch (error) {
      errorCode = error instanceof ProviderError ? error.code : error instanceof Error ? error.message : "sync_failed";
      status = await repository.recordFailure(
        targetProvider,
        targetProvider === "gongji" ? "gongji-openapi-2026-08-19" : "reference-provider-contract-v1",
        errorCode,
        config.PROVIDER_SNAPSHOT_STALE_SECONDS,
      );
      syncTotal.inc({ provider: targetProvider, outcome: "failed" });
      logger.error("provider_snapshot_sync_failed", { provider: targetProvider, error_code: errorCode });
    }
    if (targetProvider === provider) latestStatus = status;
    if (syncRequest) {
      await syncRequests.complete(syncRequest, controllerId, {
        snapshotRunId: status.latestAttemptRunId,
        ...(errorCode ? { errorCode } : {}),
      });
    }
  } finally {
    stopTimer?.();
    syncingProviders.delete(targetProvider);
  }
};

const loop = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    try {
      await synchronize(provider, reader);
    } catch (error) {
      logger.error("provider_periodic_sync_failed", {
        provider,
        error_code: error instanceof Error ? error.message : "periodic_sync_failed",
      });
    }
    if (abort.signal.aborted) break;
    await Bun.sleep(config.PROVIDER_SYNC_INTERVAL_SECONDS * 1000);
  }
};
void loop();

const manualSyncLoop = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    try {
      await synchronize(provider, reader, true);
      if (provider !== "gongji" && gongjiReads) {
        await synchronize("gongji", gongjiReads, true);
      } else if (provider !== "gongji") {
        const claim = await syncRequests.claim("gongji", controllerId, 120);
        if (claim) {
          const status = await repository.recordFailure(
            "gongji",
            "gongji-openapi-2026-08-19",
            config.ASTRA_ENV === "local" && !config.ASTRA_LOCAL_ENABLE_REAL_PROVIDER
              ? "real_provider_disabled_in_local"
              : "gongji_reader_unavailable",
            config.PROVIDER_SNAPSHOT_STALE_SECONDS,
          );
          await syncRequests.complete(claim, controllerId, {
            snapshotRunId: status.latestAttemptRunId,
            errorCode:
              config.ASTRA_ENV === "local" && !config.ASTRA_LOCAL_ENABLE_REAL_PROVIDER
                ? "real_provider_disabled_in_local"
                : "gongji_reader_unavailable",
          });
        }
      }
    } catch (error) {
      logger.error("provider_manual_sync_failed", {
        provider,
        error_code: error instanceof Error ? error.message : "manual_sync_failed",
      });
    }
    await Bun.sleep(500);
  }
};
void manualSyncLoop();

const operationLoop = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    try {
      const cycle = await operationReconciler.runOnce(config.PROVIDER_OPERATION_BATCH_SIZE);
      for (const outcome of ["succeeded", "retrying", "failed", "staleLeases", "reactivated"] as const) {
        operationTotal.inc({ provider, outcome }, cycle[outcome]);
      }
      operationLoopHealthy = true;
      if (cycle.claimed === 0) await Bun.sleep(config.PROVIDER_OPERATION_POLL_INTERVAL_MS);
    } catch (error) {
      operationLoopHealthy = false;
      logger.error("provider_operation_reconcile_failed", {
        provider,
        error_code: error instanceof Error ? error.message : "operation_reconcile_failed",
      });
      await Bun.sleep(config.PROVIDER_OPERATION_POLL_INTERVAL_MS);
    }
  }
};

const operationMetricsLoop = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    try {
      operationBacklog.reset();
      operationBacklogAge.reset();
      for (const row of await operationRepository.backlog(provider)) {
        const labels = {
          provider,
          operation_type: String(row.operation_type),
          status: String(row.status),
        };
        operationBacklog.set(labels, Number(row.count));
        operationBacklogAge.set(labels, Number(row.oldest_age_seconds));
      }
    } catch (error) {
      logger.error("provider_operation_metrics_failed", {
        provider,
        error_code: error instanceof Error ? error.message : "operation_metrics_failed",
      });
    }
    await Bun.sleep(5_000);
  }
};
void operationLoop();
void operationMetricsLoop();

const rolloutLoop = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    try {
      const result = await rolloutController.runOnce();
      rolloutTotal.inc({ provider, outcome: result.outcome });
      rolloutLoopHealthy = true;
      if (result.outcome !== "idle" && result.outcome !== "waiting") {
        logger.info("rollout_reconcile_progress", {
          rollout_id: result.rolloutId,
          outcome: result.outcome,
          reason: result.reason,
        });
      }
    } catch (error) {
      rolloutLoopHealthy = false;
      logger.error("rollout_reconcile_failed", {
        error_code: error instanceof Error ? error.message : "rollout_reconcile_failed",
      });
    }
    await Bun.sleep(config.ROLLOUT_RECONCILE_INTERVAL_MS);
  }
};
void rolloutLoop();

const rolloutMetricsLoop = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    try {
      rolloutActive.reset();
      rolloutAge.reset();
      const rows = await database.client`SELECT status, count(*)::int AS count,
          COALESCE(EXTRACT(EPOCH FROM (${new Date().toISOString()}::timestamptz-min(created_at))),0)::bigint AS age
        FROM model_rollouts WHERE provider=${provider}
          AND status IN ('pending','validating','rolling','paused','rolling_back')
        GROUP BY status`;
      let oldest = 0;
      for (const row of rows) {
        rolloutActive.set({ provider, status: String(row.status) }, Number(row.count));
        oldest = Math.max(oldest, Number(row.age));
      }
      rolloutAge.set({ provider }, oldest);
    } catch (error) {
      logger.error("rollout_metrics_failed", {
        error_code: error instanceof Error ? error.message : "rollout_metrics_failed",
      });
    }
    await Bun.sleep(5_000);
  }
};
void rolloutMetricsLoop();

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
          operation_reconcile: operationLoopHealthy ? "ready" : "degraded",
          rollout_reconcile: rolloutLoopHealthy ? "ready" : "degraded",
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
