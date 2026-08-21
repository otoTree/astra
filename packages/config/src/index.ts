import { z } from "zod";

const environmentSchema = z.object({
  ASTRA_ENV: z.enum(["local", "test", "production"]).default("local"),
  ASTRA_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const port = (defaultValue: number) => z.coerce.number().int().min(1).max(65535).default(defaultValue);
const requiredUrl = z.string().url();

export const publicApiConfigSchema = environmentSchema.extend({
  PUBLIC_API_PORT: port(4100),
  DATABASE_URL: requiredUrl,
  ASTRA_REQUEST_ENCRYPTION_KEY: z.string().min(32),
  ASTRA_AUDIT_SIGNING_KEY: z.string().min(32),
  REDIS_URL: requiredUrl,
  S3_ENDPOINT: requiredUrl,
  S3_PUBLIC_ENDPOINT: requiredUrl.optional(),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  MEDIA_VALIDATOR_URL: requiredUrl,
  MEDIA_VALIDATOR_TOKEN: z.string().min(32),
  MEDIA_VALIDATOR_CLIENT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(610),
});

export const adminApiConfigSchema = environmentSchema.extend({
  ADMIN_API_PORT: port(4101),
  DATABASE_URL: requiredUrl,
  ASTRA_REQUEST_ENCRYPTION_KEY: z.string().min(32),
  ASTRA_AUDIT_SIGNING_KEY: z.string().min(32),
  OIDC_ISSUER: requiredUrl,
  OIDC_AUDIENCE: z.string().min(1).max(256),
  OIDC_JWKS_URL: requiredUrl,
  OIDC_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
  ADMIN_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(28800),
  OCI_REGISTRY_ALLOW_PLAIN_HTTP: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  OCI_REGISTRY_BEARER_TOKEN: z.string().min(16).optional(),
});

export const workerControlApiConfigSchema = environmentSchema.extend({
  WORKER_CONTROL_API_PORT: port(4102),
  DATABASE_URL: requiredUrl,
  ASTRA_REQUEST_ENCRYPTION_KEY: z.string().min(32),
  WORKER_TOKEN_PEPPER: z.string().min(32),
  WORKER_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(1800),
  WORKER_TOKEN_ROTATE_BEFORE_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  WORKER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(60).default(10),
  WORKER_LEASE_DURATION_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
  WORKER_HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().int().min(15).max(600).default(45),
  WORKER_ORPHAN_GRACE_PERIOD_SECONDS: z.coerce.number().int().min(30).max(3600).default(180),
  WORKER_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(60).default(10),
  WORKER_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  S3_ENDPOINT: requiredUrl,
  S3_PUBLIC_ENDPOINT: requiredUrl.optional(),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  MEDIA_VALIDATOR_URL: requiredUrl,
  MEDIA_VALIDATOR_TOKEN: z.string().min(32),
  MEDIA_VALIDATOR_CLIENT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(610),
});

export const schedulerConfigSchema = environmentSchema.extend({
  SCHEDULER_METRICS_PORT: port(4110),
  DATABASE_URL: requiredUrl,
  SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60000).default(250),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  SCHEDULER_RESERVATION_SECONDS: z.coerce.number().int().min(5).max(30).default(30),
  SCHEDULER_WORKER_FRESHNESS_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
});

export const providerControllerConfigSchema = environmentSchema
  .extend({
    PROVIDER_CONTROLLER_METRICS_PORT: port(4111),
    DATABASE_URL: requiredUrl,
    PROVIDER_DRIVER: z.enum(["reference", "gongji"]),
    GONGJI_ENDPOINT: requiredUrl.optional(),
    GONGJI_TOKEN: z.string().min(1).optional(),
    GONGJI_PRIVATE_KEY_PEM: z.string().min(64).optional(),
    PROVIDER_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    PROVIDER_SNAPSHOT_STALE_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
    PROVIDER_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
    PROVIDER_MAXIMUM_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
    PROVIDER_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(5),
    PROVIDER_BREAKER_COOLDOWN_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
    PROVIDER_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(100),
    PROVIDER_MAXIMUM_PAGES: z.coerce.number().int().min(1).max(100).default(20),
  })
  .superRefine((config, context) => {
    if (config.PROVIDER_DRIVER === "gongji") {
      for (const name of ["GONGJI_ENDPOINT", "GONGJI_TOKEN", "GONGJI_PRIVATE_KEY_PEM"] as const) {
        if (!config[name]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} is required when PROVIDER_DRIVER=gongji`,
          });
        }
      }
      if (
        config.ASTRA_ENV === "production" &&
        config.GONGJI_ENDPOINT &&
        !config.GONGJI_ENDPOINT.startsWith("https://")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["GONGJI_ENDPOINT"],
          message: "GONGJI_ENDPOINT must use HTTPS in production",
        });
      }
    }
    if (config.PROVIDER_SNAPSHOT_STALE_SECONDS <= config.PROVIDER_SYNC_INTERVAL_SECONDS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PROVIDER_SNAPSHOT_STALE_SECONDS"],
        message: "snapshot stale threshold must exceed sync interval",
      });
    }
  });

export const eventRelayConfigSchema = environmentSchema.extend({
  EVENT_RELAY_METRICS_PORT: port(4112),
  DATABASE_URL: requiredUrl,
  REDIS_URL: requiredUrl,
  KAFKA_BROKERS: z.string().min(1),
  KAFKA_CLIENT_ID: z.string().min(1).max(128).default("astra-event-relay"),
  KAFKA_TASK_TOPIC: z.string().min(1).default("astra.task-lifecycle.v1"),
  KAFKA_CAPACITY_TOPIC: z.string().min(1).default("astra.capacity.v1"),
  KAFKA_USAGE_TOPIC: z.string().min(1).default("astra.usage.v1"),
  KAFKA_AUDIT_TOPIC: z.string().min(1).default("astra.audit.v1"),
  KAFKA_CONTROL_TOPIC: z.string().min(1).default("astra.control.v1"),
  EVENT_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  EVENT_RELAY_LEASE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  EVENT_RELAY_MAXIMUM_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  EVENT_RELAY_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60000).default(500),
  REDIS_REBUILD_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(500),
  REDIS_REBUILD_LEASE_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REDIS_REBUILD_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
});

export const workerAgentConfigSchema = environmentSchema.extend({
  MODEL_APP_URL: requiredUrl.default("http://127.0.0.1:9000"),
  WORKER_CONTROL_URL: requiredUrl,
  WORKER_BOOTSTRAP_TOKEN: z.string().min(32),
  WORKER_PROVIDER: z.string().min(1),
  WORKER_REGION: z.string().min(1),
  WORKER_PROVIDER_INSTANCE_ID: z.string().min(1),
  WORKER_REPLICA_ID: z.string().min(1),
  WORKER_POOL_ID: z.string().min(1),
  WORKER_RELEASE_ID: z.string().min(1),
  WORKER_INSTANCE_FINGERPRINT: z.string().min(16),
  WORKER_GPU_SKU: z.string().min(1),
  WORKER_GPU_COUNT: z.coerce.number().int().positive(),
  WORKER_GPU_MEMORY_BYTES: z.coerce.number().int().positive(),
  WORKER_WORK_ROOT: z
    .string()
    .regex(/^\/work(?:\/.*)?$/)
    .default("/work/tasks"),
  WORKER_CONTROL_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  WORKER_IDLE_POLL_MS: z.coerce.number().int().min(100).max(30000).default(1000),
});

export const modelAppConfigSchema = environmentSchema.extend({
  MODEL_APP_PORT: port(9000),
  MODEL_APP_RELEASE: z.string().min(1),
  MODEL_APP_VIDEO_FIXTURE: z.string().min(1),
  MODEL_APP_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
});

export const mediaValidatorConfigSchema = environmentSchema.extend({
  MEDIA_VALIDATOR_PORT: port(4113),
  MEDIA_VALIDATOR_TOKEN: z.string().min(32),
  S3_ENDPOINT: requiredUrl,
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  MEDIA_VALIDATOR_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024 * 1024),
  MEDIA_VALIDATOR_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
});

export const fileSweeperConfigSchema = environmentSchema.extend({
  FILE_SWEEPER_METRICS_PORT: port(4114),
  DATABASE_URL: requiredUrl,
  S3_ENDPOINT: requiredUrl,
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  FILE_SWEEPER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  FILE_SWEEPER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  FILE_VALIDATION_RECLAIM_SECONDS: z.coerce.number().int().positive().default(900),
});

type Environment = Record<string, string | undefined>;
const parse = <Schema extends z.ZodTypeAny>(schema: Schema, env: Environment): z.output<Schema> => schema.parse(env);

export const loadPublicApiConfig = (env: Environment = process.env) => parse(publicApiConfigSchema, env);
export const loadAdminApiConfig = (env: Environment = process.env) => parse(adminApiConfigSchema, env);
export const loadWorkerControlApiConfig = (env: Environment = process.env) => parse(workerControlApiConfigSchema, env);
export const loadSchedulerConfig = (env: Environment = process.env) => parse(schedulerConfigSchema, env);
export const loadProviderControllerConfig = (env: Environment = process.env) =>
  parse(
    providerControllerConfigSchema,
    env.PROVIDER_DRIVER || env.ASTRA_ENV === "production" ? env : { ...env, PROVIDER_DRIVER: "reference" },
  );
export const loadEventRelayConfig = (env: Environment = process.env) => parse(eventRelayConfigSchema, env);
export const loadWorkerAgentConfig = (env: Environment = process.env) => parse(workerAgentConfigSchema, env);
export const loadModelAppConfig = (env: Environment = process.env) => parse(modelAppConfigSchema, env);
export const loadMediaValidatorConfig = (env: Environment = process.env) => parse(mediaValidatorConfigSchema, env);
export const loadFileSweeperConfig = (env: Environment = process.env) => parse(fileSweeperConfigSchema, env);
