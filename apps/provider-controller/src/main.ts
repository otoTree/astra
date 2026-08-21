import { loadProviderControllerConfig } from "@astra/config";
import { createLogger } from "@astra/observability";

const config = loadProviderControllerConfig();
const logger = createLogger("provider-controller");
const port = config.PROVIDER_CONTROLLER_METRICS_PORT;
Bun.serve({
  port,
  fetch: (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/health/live") {
      return Response.json({ status: "ok", component: "provider-controller", env: config.ASTRA_ENV });
    }
    return Response.json({ error: { code: "not_found", message: "Route not found" } }, { status: 404 });
  },
});
logger.info("provider_controller_started", { port });
