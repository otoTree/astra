import { loadAdminApiConfig } from "@astra/config";
import { AdminSessionManager } from "@astra/auth";
import {
  AdminManagementService,
  AdminQueryService,
  createDatabase,
  DatabaseHealth,
  IdentityRepository,
  TaskService,
} from "@astra/database";
import { createAdminApi, withErrorHandling } from "./app.ts";
import { DistributionOciImageResolver } from "./oci-image-resolver.ts";
import { serve } from "./server.ts";

const config = loadAdminApiConfig();
const database = createDatabase(config.DATABASE_URL);
const identityRepository = new IdentityRepository(database.client);
const bootstrapPasswordHash = await Bun.password.hash(config.ADMIN_BOOTSTRAP_PASSWORD, {
  algorithm: "argon2id",
  memoryCost: 65_536,
  timeCost: 3,
});
await identityRepository.ensureLocalAdminUser({
  id: "admin_bootstrap",
  username: config.ADMIN_BOOTSTRAP_USERNAME,
  passwordHash: bootstrapPasswordHash,
  displayName: config.ADMIN_BOOTSTRAP_DISPLAY_NAME,
  organizationId: config.ADMIN_BOOTSTRAP_ORGANIZATION_ID,
  projectId: config.ADMIN_BOOTSTRAP_PROJECT_ID,
  createdAt: new Date(),
});
const sessionCookieName = config.ASTRA_ENV === "production" ? "__Host-astra_admin_session" : "astra_admin_session";
const csrfCookieName = config.ASTRA_ENV === "production" ? "__Host-astra_admin_csrf" : "astra_admin_csrf";
const sessions = new AdminSessionManager(identityRepository, undefined, {
  auditSigningKey: config.ASTRA_AUDIT_SIGNING_KEY,
  cookieName: sessionCookieName,
  csrfCookieName,
  sessionTtlSeconds: config.ADMIN_SESSION_TTL_SECONDS,
});
const taskService = new TaskService(database.client, {
  requestEncryptionKey: config.ASTRA_REQUEST_ENCRYPTION_KEY,
  enforceAdmission: false,
});
const queryService = new AdminQueryService(database.client, config.ASTRA_REQUEST_ENCRYPTION_KEY);
const managementService = new AdminManagementService(
  database.client,
  new DistributionOciImageResolver({
    allowPlainHttp: config.OCI_REGISTRY_ALLOW_PLAIN_HTTP,
    ...(config.OCI_REGISTRY_BEARER_TOKEN ? { bearerToken: config.OCI_REGISTRY_BEARER_TOKEN } : {}),
  }),
  config.ASTRA_AUDIT_SIGNING_KEY,
);
serve(
  withErrorHandling(
    createAdminApi(
      new DatabaseHealth(database.client),
      {
        sessions,
        sessionCookieName,
        csrfCookieName,
        secureCookies: config.ASTRA_ENV === "production",
        sessionTtlSeconds: config.ADMIN_SESSION_TTL_SECONDS,
        loginMaxFailures: config.ADMIN_LOGIN_MAX_FAILURES,
        loginLockSeconds: config.ADMIN_LOGIN_LOCK_SECONDS,
      },
      taskService,
      queryService,
      managementService,
    ),
  ),
  config.ADMIN_API_PORT,
  "admin-api",
);
