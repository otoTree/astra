import { loadWorkerAgentConfig } from "@astra/config";
import { createLogger } from "@astra/observability";
import { WorkerAgent } from "./agent.ts";
import { ModelAppClient } from "./model-app-client.ts";
import { WorkerStateStore } from "./state-store.ts";
import { WorkerControlClient } from "./worker-control-client.ts";

const config = loadWorkerAgentConfig();
const logger = createLogger("worker-agent");
const model = new ModelAppClient(config.MODEL_APP_URL, config.WORKER_CONTROL_TIMEOUT_SECONDS * 1000);
const control = new WorkerControlClient(config.WORKER_CONTROL_URL, config.WORKER_CONTROL_TIMEOUT_SECONDS * 1000);
const agent = new WorkerAgent(
  control,
  model,
  new WorkerStateStore(`${config.WORKER_WORK_ROOT}/.agent/session.json`),
  {
    bootstrapToken: config.WORKER_BOOTSTRAP_TOKEN,
    provider: config.WORKER_PROVIDER,
    region: config.WORKER_REGION,
    providerInstanceId: config.WORKER_PROVIDER_INSTANCE_ID,
    replicaId: config.WORKER_REPLICA_ID,
    poolId: config.WORKER_POOL_ID,
    releaseId: config.WORKER_RELEASE_ID,
    ...(config.WORKER_IMAGE_DIGEST ? { imageDigest: config.WORKER_IMAGE_DIGEST } : {}),
    instanceFingerprint: config.WORKER_INSTANCE_FINGERPRINT,
    gpuSku: config.WORKER_GPU_SKU,
    gpuCount: config.WORKER_GPU_COUNT,
    gpuMemoryBytes: config.WORKER_GPU_MEMORY_BYTES,
    workRoot: config.WORKER_WORK_ROOT,
    idlePollMilliseconds: config.WORKER_IDLE_POLL_MS,
  },
  logger,
);
await agent.initialize();
logger.info("worker_agent_ready", { release_id: config.WORKER_RELEASE_ID, replica_id: config.WORKER_REPLICA_ID });
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
await agent.run(abort.signal);
