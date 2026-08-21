import { describe, expect, test } from "bun:test";
import { loadAdminApiConfig, loadProviderControllerConfig, loadPublicApiConfig } from "./index.ts";

describe("service configuration", () => {
  test("public API fails at startup when an infrastructure boundary is absent", () => {
    expect(() => loadPublicApiConfig({ ASTRA_ENV: "production" })).toThrow();
  });

  test("Gongji driver requires an explicit endpoint", () => {
    expect(() =>
      loadProviderControllerConfig({
        DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
        PROVIDER_DRIVER: "gongji",
      }),
    ).toThrow();
  });

  test("reference provider is the local default", () => {
    const config = loadProviderControllerConfig({
      DATABASE_URL: "postgres://astra:astra@localhost:5432/astra",
    });
    expect(config.PROVIDER_DRIVER).toBe("reference");
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
});
