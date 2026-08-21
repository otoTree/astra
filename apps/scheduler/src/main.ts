import { loadSchedulerConfig } from "@astra/config";
import { createLogger } from "@astra/observability";

const config = loadSchedulerConfig();
const logger = createLogger("scheduler");
const port = config.SCHEDULER_METRICS_PORT;
Bun.serve({ port, fetch: () => Response.json({ status: "ok", component: "scheduler", env: config.ASTRA_ENV }) });
logger.info("scheduler_started", { port });
