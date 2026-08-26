import { describe, expect, test } from "bun:test";
import { adminApiRequestUrl, readCsrfToken, saveCsrfToken } from "./admin-api.ts";

describe("Admin Web cross-origin API client", () => {
  test("uses the runtime Admin API origin and keeps the API path", () => {
    expect(adminApiRequestUrl("/admin/v1/tasks?limit=10", "https://admin-api.example.test")).toBe(
      "https://admin-api.example.test/admin/v1/tasks?limit=10",
    );
    expect(adminApiRequestUrl("/admin/v1/tasks", undefined)).toBe("/admin/v1/tasks");
  });

  test("persists the login CSRF token in tab-scoped storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    saveCsrfToken("csrf-from-login", storage);
    expect(readCsrfToken(storage)).toBe("csrf-from-login");
  });
});
