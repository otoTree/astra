import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { loadFileSweeperConfig } from "@astra/config";
import { AssetExpirationRepository, createDatabase } from "@astra/database";
import { Counter, Gauge, createLogger, createMetricRegistry, metricResponse } from "@astra/observability";
import { Hono } from "hono";
import { serve } from "./server.ts";

const config = loadFileSweeperConfig();
const database = createDatabase(config.DATABASE_URL);
const repository = new AssetExpirationRepository(database.client, {
  validatingReclaimAfterMilliseconds: config.FILE_VALIDATION_RECLAIM_SECONDS * 1000,
});
const storage = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
});
const logger = createLogger("file-sweeper");
const metrics = createMetricRegistry("file-sweeper");
const claimedAssets = new Counter({
  name: "astra_file_sweeper_claimed_total",
  help: "Files claimed for expiration",
  registers: [metrics],
});
const completedAssets = new Counter({
  name: "astra_file_sweeper_completed_total",
  help: "Files fully expired after object deletion",
  registers: [metrics],
});
const failedAssets = new Counter({
  name: "astra_file_sweeper_failures_total",
  help: "File expiration failures by error type",
  labelNames: ["error_type"] as const,
  registers: [metrics],
});
const claimedGauge = new Gauge({
  name: "astra_file_sweeper_claimed_current",
  help: "Files claimed in the latest sweep",
  registers: [metrics],
});
const metricsApp = new Hono();
metricsApp.get("/health/live", (context) => context.json({ status: "ok" }));
metricsApp.get("/metrics", () => metricResponse(metrics));
serve(metricsApp, config.FILE_SWEEPER_METRICS_PORT, "file-sweeper-metrics");

async function sweep(): Promise<void> {
  const assets = await repository.claim(config.FILE_SWEEPER_BATCH_SIZE);
  claimedAssets.inc(assets.length);
  claimedGauge.set(assets.length);
  for (const asset of assets) {
    try {
      await storage.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: asset.objectKey }));
      await repository.complete(asset.id);
      completedAssets.inc();
      logger.info("asset_expired", { file_id: asset.id });
    } catch (error) {
      failedAssets.inc({ error_type: error instanceof Error ? error.name : "unknown" });
      logger.error("asset_expiration_failed", {
        file_id: asset.id,
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

let stopping = false;
let stopWaiting: (() => void) | undefined;
process.on("SIGTERM", () => {
  stopping = true;
  stopWaiting?.();
});
process.on("SIGINT", () => {
  stopping = true;
  stopWaiting?.();
});

while (!stopping) {
  await sweep();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, config.FILE_SWEEPER_INTERVAL_SECONDS * 1000);
    stopWaiting = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  stopWaiting = undefined;
}
await database.client.end();
