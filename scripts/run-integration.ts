const suite = process.argv[2];

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`integration_configuration_missing:${name}`);
  return value;
};

const common = {
  ...process.env,
  ASTRA_TEST_DATABASE_URL: required("DATABASE_URL"),
};

const localUrl = (explicitName: string, portName: string, defaultPort: number): string =>
  process.env[explicitName] ?? `http://127.0.0.1:${process.env[portName] ?? defaultPort}`;

const configuration =
  suite === "postgres"
    ? {
        files: [
          "packages/database/src/task-service.integration.test.ts",
          "packages/database/src/identity-admission.integration.test.ts",
          "packages/database/src/admin-identity.integration.test.ts",
          "packages/database/src/admin-query.integration.test.ts",
          "packages/database/src/admin-management.integration.test.ts",
          "packages/database/src/scheduling-repository.integration.test.ts",
          "packages/database/src/worker-control-repository.integration.test.ts",
          "packages/database/src/provider-snapshot-repository.integration.test.ts",
        ],
        env: common,
      }
    : suite === "s3"
      ? {
          files: ["apps/api/src/file-service.integration.test.ts"],
          env: {
            ...common,
            ASTRA_TEST_S3_ENDPOINT: required("S3_ENDPOINT"),
            ASTRA_TEST_S3_PUBLIC_ENDPOINT: required("S3_PUBLIC_ENDPOINT"),
            ASTRA_TEST_S3_BUCKET: required("S3_BUCKET"),
            ASTRA_TEST_S3_ACCESS_KEY: required("S3_ACCESS_KEY"),
            ASTRA_TEST_S3_SECRET_KEY: required("S3_SECRET_KEY"),
            ASTRA_TEST_MEDIA_VALIDATOR_URL: required("MEDIA_VALIDATOR_URL"),
            ASTRA_TEST_MEDIA_VALIDATOR_TOKEN: required("MEDIA_VALIDATOR_TOKEN"),
          },
        }
      : suite === "events"
        ? {
            files: [
              "packages/database/src/event-repository.integration.test.ts",
              "packages/queue/src/candidate-index.integration.test.ts",
              "apps/event-relay/src/kafka.integration.test.ts",
              "apps/event-relay/src/redis-rebuild.integration.test.ts",
            ],
            env: {
              ...common,
              ASTRA_TEST_REDIS_URL: required("REDIS_URL"),
              ASTRA_TEST_KAFKA_BROKERS: required("KAFKA_BROKERS"),
              ASTRA_TEST_KAFKA_TASK_TOPIC: process.env.KAFKA_TASK_TOPIC ?? "astra.task-lifecycle.v1",
            },
          }
        : suite === "http"
          ? {
              files: [
                "apps/api/src/public-security.integration.test.ts",
                "apps/api/src/admin-security.integration.test.ts",
              ],
              env: {
                ...common,
                ASTRA_TEST_PUBLIC_API_URL: required("PUBLIC_API_URL"),
                ASTRA_TEST_PUBLIC_API_KEY: required("ASTRA_LOCAL_API_KEY"),
                ASTRA_TEST_ADMIN_API_URL: localUrl("ADMIN_API_URL", "ASTRA_LOCAL_ADMIN_API_PORT", 54101),
                ASTRA_TEST_IDENTITY_URL: localUrl("IDENTITY_URL", "ASTRA_LOCAL_IDENTITY_PORT", 54180),
              },
            }
          : undefined;

if (!configuration) throw new Error("integration_suite_must_be_postgres_s3_events_or_http");
const processResult = Bun.spawn(["bun", "test", ...configuration.files, "--timeout", "30000"], {
  env: configuration.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await processResult.exited);
