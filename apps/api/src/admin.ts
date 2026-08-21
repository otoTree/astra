import { loadAdminApiConfig } from "@astra/config";
import { AdminSessionManager, RemoteOidcTokenVerifier } from "@astra/auth";
import { createDatabase, DatabaseHealth, IdentityRepository, TaskService } from "@astra/database";
import { createAdminApi, withErrorHandling } from "./app.ts";
import { serve } from "./server.ts";

const config = loadAdminApiConfig();
const database = createDatabase(config.DATABASE_URL);
const identityRepository = new IdentityRepository(database.client);
const sessionCookieName = config.ASTRA_ENV === "production" ? "__Host-astra_admin_session" : "astra_admin_session";
const csrfCookieName = config.ASTRA_ENV === "production" ? "__Host-astra_admin_csrf" : "astra_admin_csrf";
const sessions = new AdminSessionManager(
  identityRepository,
  new RemoteOidcTokenVerifier({
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    jwksUrl: config.OIDC_JWKS_URL,
    clockSkewSeconds: config.OIDC_CLOCK_SKEW_SECONDS,
  }),
  {
    auditSigningKey: config.ASTRA_AUDIT_SIGNING_KEY,
    cookieName: sessionCookieName,
    csrfCookieName,
    sessionTtlSeconds: config.ADMIN_SESSION_TTL_SECONDS,
  },
);
const taskService = new TaskService(database.client, {
  requestEncryptionKey: config.ASTRA_REQUEST_ENCRYPTION_KEY,
  enforceAdmission: false,
});
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
      },
      taskService,
    ),
  ),
  config.ADMIN_API_PORT,
  "admin-api",
);
