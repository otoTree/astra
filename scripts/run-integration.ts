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

const configuration =
  suite === "postgres"
    ? {
        file: "packages/database/src/task-service.integration.test.ts",
        env: common,
      }
    : suite === "s3"
      ? {
          file: "apps/api/src/file-service.integration.test.ts",
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
      : undefined;

if (!configuration) throw new Error("integration_suite_must_be_postgres_or_s3");
const processResult = Bun.spawn(["bun", "test", configuration.file, "--timeout", "30000"], {
  env: configuration.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await processResult.exited);
