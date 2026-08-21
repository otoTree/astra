import { loadPublicApiConfig } from "@astra/config";
import { PublicApiAuthenticator } from "@astra/auth";
import { createDatabase, FileRepository, IdentityRepository, TaskService } from "@astra/database";
import { RedisPublicApiRateLimiter } from "@astra/queue";
import { createPublicApi, withErrorHandling } from "./app.ts";
import { serve } from "./server.ts";
import { FileService } from "./file-service.ts";
import { MediaValidatorClient } from "./media-validator-client.ts";

const config = loadPublicApiConfig();
const database = createDatabase(config.DATABASE_URL);
const identityRepository = new IdentityRepository(database.client);
const fileService = new FileService(
  new FileRepository(database.client),
  {
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    ...(config.S3_PUBLIC_ENDPOINT ? { publicEndpoint: config.S3_PUBLIC_ENDPOINT } : {}),
  },
  new MediaValidatorClient(
    config.MEDIA_VALIDATOR_URL,
    config.MEDIA_VALIDATOR_TOKEN,
    config.MEDIA_VALIDATOR_CLIENT_TIMEOUT_SECONDS * 1000,
  ),
);
serve(
  withErrorHandling(
    createPublicApi(
      new TaskService(database.client, {
        requestEncryptionKey: config.ASTRA_REQUEST_ENCRYPTION_KEY,
        enforceAdmission: true,
      }),
      fileService,
      {
        authenticator: new PublicApiAuthenticator(identityRepository, {
          auditSigningKey: config.ASTRA_AUDIT_SIGNING_KEY,
        }),
        rateLimiter: new RedisPublicApiRateLimiter(config.REDIS_URL),
      },
    ),
  ),
  config.PUBLIC_API_PORT,
  "public-api",
);
