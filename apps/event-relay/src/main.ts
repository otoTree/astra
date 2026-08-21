import { loadEventRelayConfig } from "@astra/config";
import { createLogger } from "@astra/observability";

const config = loadEventRelayConfig();
const logger = createLogger("event-relay");
const port = config.EVENT_RELAY_METRICS_PORT;
Bun.serve({ port, fetch: () => Response.json({ status: "ok", component: "event-relay", env: config.ASTRA_ENV }) });
logger.info("event_relay_started", { port });
