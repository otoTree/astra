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
});

export const workerControlApiConfigSchema = environmentSchema.extend({
  WORKER_CONTROL_API_PORT: port(4102),
  DATABASE_URL: requiredUrl,
});

export const schedulerConfigSchema = environmentSchema.extend({
  SCHEDULER_METRICS_PORT: port(4110),
  DATABASE_URL: requiredUrl,
});

export const providerControllerConfigSchema = environmentSchema
  .extend({
    PROVIDER_CONTROLLER_METRICS_PORT: port(4111),
    DATABASE_URL: requiredUrl,
    PROVIDER_DRIVER: z.enum(["reference", "gongji"]),
    GONGJI_ENDPOINT: requiredUrl.optional(),
  })
  .superRefine((config, context) => {
    if (config.PROVIDER_DRIVER === "gongji" && !config.GONGJI_ENDPOINT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GONGJI_ENDPOINT"],
        message: "GONGJI_ENDPOINT is required when PROVIDER_DRIVER=gongji",
      });
    }
  });

export const eventRelayConfigSchema = environmentSchema.extend({
  EVENT_RELAY_METRICS_PORT: port(4112),
  DATABASE_URL: requiredUrl,
  REDIS_URL: requiredUrl,
  KAFKA_BROKERS: z.string().min(1),
});

export const workerAgentConfigSchema = environmentSchema.extend({
  MODEL_APP_URL: requiredUrl.default("http://127.0.0.1:9000"),
  WORKER_CONTROL_URL: requiredUrl,
  WORKER_BOOTSTRAP_TOKEN: z.string().min(32),
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
