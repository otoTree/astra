import { loadPublicApiConfig } from "@astra/config";
import { createDatabase, FileRepository, TaskService } from "@astra/database";
import { createPublicApi, withErrorHandling } from "./app.ts";
import { serve } from "./server.ts";
import { FileService } from "./file-service.ts";
import { MediaValidatorClient } from "./media-validator-client.ts";

const config = loadPublicApiConfig();
const database = createDatabase(config.DATABASE_URL);
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
      new TaskService(database.client, { requestEncryptionKey: config.ASTRA_REQUEST_ENCRYPTION_KEY }),
      fileService,
    ),
  ),
  config.PUBLIC_API_PORT,
  "public-api",
);
