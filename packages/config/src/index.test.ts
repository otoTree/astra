import { describe, expect, test } from "bun:test";
import { loadProviderControllerConfig, loadPublicApiConfig } from "./index.ts";

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
});
