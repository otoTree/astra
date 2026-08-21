import { loadWorkerControlApiConfig } from "@astra/config";
import { createDatabase, DatabaseHealth } from "@astra/database";
import { createWorkerControlApi, withErrorHandling } from "./app.ts";
import { serve } from "./server.ts";

const config = loadWorkerControlApiConfig();
const database = createDatabase(config.DATABASE_URL);
serve(
  withErrorHandling(createWorkerControlApi(new DatabaseHealth(database.client))),
  config.WORKER_CONTROL_API_PORT,
  "worker-control-api",
);
