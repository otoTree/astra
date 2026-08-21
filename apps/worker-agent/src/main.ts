import { loadWorkerAgentConfig } from "@astra/config";
import { createLogger } from "@astra/observability";
import { ModelAppClient } from "./model-app-client.ts";

const config = loadWorkerAgentConfig();
const logger = createLogger("worker-agent");
const client = new ModelAppClient(config.MODEL_APP_URL);

const capabilities = await client.capabilities();
logger.info("model_app_capabilities_loaded", {
  model_release: capabilities.model_release,
  max_concurrency: capabilities.max_concurrency,
});

if (!(await client.live())) throw new Error("model_app_not_live");
logger.info("worker_agent_ready", { contract_version: capabilities.contract_version });

// The claim/lease loop is intentionally a later control-plane adapter. This process
// only proves the localhost Model App contract until worker-control API is connected.
await new Promise<void>(() => undefined);
