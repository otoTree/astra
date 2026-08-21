import { loadAdminApiConfig } from "@astra/config";
import { createDatabase, DatabaseHealth } from "@astra/database";
import { createAdminApi, withErrorHandling } from "./app.ts";
import { serve } from "./server.ts";

const config = loadAdminApiConfig();
const database = createDatabase(config.DATABASE_URL);
serve(withErrorHandling(createAdminApi(new DatabaseHealth(database.client))), config.ADMIN_API_PORT, "admin-api");
