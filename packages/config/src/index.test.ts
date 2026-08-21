import { describe, expect, test } from "bun:test";
import {
  loadAdminApiConfig,
  loadEventRelayConfig,
  loadProviderControllerConfig,
  loadPublicApiConfig,
  loadSchedulerConfig,
  loadWorkerControlApiConfig,
} from "./index.ts";

describe("service configuration", () => {
  test("public API fails at startup when an infrastructure boundary is absent", () => {
    expect(() => loadPublicApiConfig({ ASTRA_ENV: "production" })).toThrow();
  });

  test("Gongji driver requires endpoint and signing credentials", () => {
    expect(() =>
      loadProviderControllerConfig({
        DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
        PROVIDER_DRIVER: "gongji",
      }),
    ).toThrow();
    expect(() =>
      loadProviderControllerConfig({
        ASTRA_ENV: "production",
        DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
        PROVIDER_DRIVER: "gongji",
        GONGJI_ENDPOINT: "http://openapi.suanli.cn",
        GONGJI_TOKEN: "secret",
        GONGJI_PRIVATE_KEY_PEM: "x".repeat(64),
      }),
    ).toThrow();
  });

  test("reference provider is the local default", () => {
    const config = loadProviderControllerConfig({
      DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
      PROVIDER_OPERATION_ENCRYPTION_KEY: "e".repeat(32),
      WORKER_TOKEN_PEPPER: "p".repeat(32),
      ROLLOUT_WORKER_CONTROL_URL: "http://worker-control.test",
    });
    expect(config.PROVIDER_DRIVER).toBe("reference");
    expect(config.PROVIDER_SYNC_INTERVAL_SECONDS).toBe(60);
    expect(config.PROVIDER_SNAPSHOT_STALE_SECONDS).toBe(300);
  });

  test("admin API validates required OIDC settings while tolerating process environment keys", () => {
    const config = loadAdminApiConfig({
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
      ASTRA_REQUEST_ENCRYPTION_KEY: "e".repeat(32),
      ASTRA_AUDIT_SIGNING_KEY: "a".repeat(32),
      OIDC_ISSUER: "https://identity.test",
      OIDC_AUDIENCE: "astra-admin",
      OIDC_JWKS_URL: "https://identity.test/jwks",
    });
    expect(config.OIDC_AUDIENCE).toBe("astra-admin");
    expect(() =>
      loadAdminApiConfig({
        DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
        ASTRA_REQUEST_ENCRYPTION_KEY: "e".repeat(32),
        ASTRA_AUDIT_SIGNING_KEY: "a".repeat(32),
      }),
    ).toThrow();
  });

  test("event relay validates infrastructure and bounded delivery controls", () => {
    const config = loadEventRelayConfig({
      DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
      REDIS_URL: "redis://localhost:6379",
      KAFKA_BROKERS: "localhost:9092",
    });
    expect(config.KAFKA_TASK_TOPIC).toBe("astra.task-lifecycle.v1");
    expect(config.EVENT_RELAY_BATCH_SIZE).toBe(100);
    expect(config.REDIS_REBUILD_CHECK_INTERVAL_SECONDS).toBe(30);
    expect(() =>
      loadEventRelayConfig({
        DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
        REDIS_URL: "redis://localhost:6379",
        KAFKA_BROKERS: "localhost:9092",
        EVENT_RELAY_MAXIMUM_ATTEMPTS: "0",
      }),
    ).toThrow();
  });

  test("scheduler uses bounded reservation and freshness controls", () => {
    const config = loadSchedulerConfig({
      DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
    });
    expect(config.SCHEDULER_RESERVATION_SECONDS).toBe(30);
    expect(config.SCHEDULER_WORKER_FRESHNESS_SECONDS).toBe(60);
    expect(() =>
      loadSchedulerConfig({
        DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
        SCHEDULER_RESERVATION_SECONDS: "31",
      }),
    ).toThrow();
  });

  test("worker control requires isolated identity, encryption and object storage boundaries", () => {
    expect(() => loadWorkerControlApiConfig({ DATABASE_URL: "postgres://astra:astra@localhost:5432/astra" })).toThrow();
    const config = loadWorkerControlApiConfig({
      DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
      ASTRA_REQUEST_ENCRYPTION_KEY: "e".repeat(32),
      WORKER_TOKEN_PEPPER: "w".repeat(32),
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "astra-local",
      S3_ACCESS_KEY: "local",
      S3_SECRET_KEY: "local-secret",
      MEDIA_VALIDATOR_URL: "http://localhost:4113",
      MEDIA_VALIDATOR_TOKEN: "m".repeat(32),
    });
    expect(config.WORKER_ORPHAN_GRACE_PERIOD_SECONDS).toBe(180);
  });
});
