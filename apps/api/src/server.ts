import type { Hono } from "hono";
import { createLogger } from "@astra/observability";

export function serve(app: Hono, port: number, service: string): void {
  const logger = createLogger(service);
  Bun.serve({
    port,
    fetch: app.fetch,
  });
  logger.info("server_started", { port });
}
