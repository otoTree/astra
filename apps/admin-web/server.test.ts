import { afterAll, describe, expect, test } from "bun:test";
import { createAdminWebHandler } from "./server.ts";

const upstream = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    return Response.json(
      {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: request.method === "POST" ? await request.text() : null,
      },
      { headers: { "set-cookie": "astra_session=test; Path=/; HttpOnly" } },
    );
  },
});

afterAll(() => upstream.stop(true));

describe("Admin Web deployment proxy", () => {
  test("proxies Admin API paths and preserves cookies", async () => {
    const handler = createAdminWebHandler(new URL(`http://127.0.0.1:${upstream.port}/`));
    const response = await handler(
      new Request("https://admin.example.test/admin/v1/session?view=current", {
        method: "POST",
        headers: { cookie: "astra_csrf=test", "content-type": "application/json" },
        body: JSON.stringify({ csrf: "test" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("astra_session=test");
    expect(await response.json()).toEqual({
      method: "POST",
      path: "/admin/v1/session?view=current",
      body: JSON.stringify({ csrf: "test" }),
    });
  });

  test("fails closed when the Admin API target is absent", async () => {
    const response = await createAdminWebHandler(undefined)(new Request("https://admin.example.test/admin/v1/tasks"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "admin_api_not_configured", message: "ADMIN_API_URL is not configured" },
    });
  });

  test("serves the browser-visible Admin API origin as runtime configuration", async () => {
    const response = await createAdminWebHandler(
      undefined,
      "https://admin-api.example.test",
    )(new Request("https://admin.example.test/runtime-config.js"));
    expect(response.headers.get("content-type")).toContain("application/javascript");
    expect(await response.text()).toContain('"ADMIN_API_PUBLIC_URL":"https://admin-api.example.test"');
  });
});
