import { loadWorkerControlApiConfig } from "@astra/config";
import { createDatabase, DatabaseHealth, WorkerControlRepository } from "@astra/database";
import { createLogger } from "@astra/observability";
import { createWorkerControlApi, withErrorHandling } from "./app.ts";
import { MediaValidatorClient } from "./media-validator-client.ts";
import { serve } from "./server.ts";
import { WorkerControlService } from "./worker-control-service.ts";

const config = loadWorkerControlApiConfig();
const logger = createLogger("worker-control-api");
const database = createDatabase(config.DATABASE_URL);
const repository = new WorkerControlRepository(database.client, config.ASTRA_REQUEST_ENCRYPTION_KEY);
const validator = new MediaValidatorClient(
  config.MEDIA_VALIDATOR_URL,
  config.MEDIA_VALIDATOR_TOKEN,
  config.MEDIA_VALIDATOR_CLIENT_TIMEOUT_SECONDS * 1000,
);
const service = new WorkerControlService(repository, validator, {
  tokenPepper: config.WORKER_TOKEN_PEPPER,
  sessionTtlSeconds: config.WORKER_SESSION_TTL_SECONDS,
  tokenRotateBeforeSeconds: config.WORKER_TOKEN_ROTATE_BEFORE_SECONDS,
  heartbeatIntervalSeconds: config.WORKER_HEARTBEAT_INTERVAL_SECONDS,
  leaseDurationSeconds: config.WORKER_LEASE_DURATION_SECONDS,
  orphanGracePeriodSeconds: config.WORKER_ORPHAN_GRACE_PERIOD_SECONDS,
  endpoint: config.S3_ENDPOINT,
  ...(config.S3_PUBLIC_ENDPOINT ? { publicEndpoint: config.S3_PUBLIC_ENDPOINT } : {}),
  bucket: config.S3_BUCKET,
  accessKey: config.S3_ACCESS_KEY,
  secretKey: config.S3_SECRET_KEY,
});
let reconciling = false;
setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const result = await repository.reconcileLiveness(
      config.WORKER_HEARTBEAT_TIMEOUT_SECONDS,
      config.WORKER_ORPHAN_GRACE_PERIOD_SECONDS,
      config.WORKER_RECONCILE_BATCH_SIZE,
    );
    if (result.unknown > 0 || result.orphaned > 0) logger.warn("worker_liveness_reconciled", result);
  } catch (error) {
    logger.error("worker_liveness_reconcile_failed", {
      error_code: error instanceof Error ? error.message : "liveness_reconcile_failed",
    });
  } finally {
    reconciling = false;
  }
}, config.WORKER_RECONCILE_INTERVAL_SECONDS * 1000).unref();
serve(
  withErrorHandling(createWorkerControlApi(new DatabaseHealth(database.client), service)),
  config.WORKER_CONTROL_API_PORT,
  "worker-control-api",
);
