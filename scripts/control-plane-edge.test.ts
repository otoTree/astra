import { afterAll, describe, expect, test } from "bun:test";
import { createControlPlaneEdgeHandler } from "./control-plane-edge.ts";

const upstream = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health/ready") return Response.json({ status: "ready" });
    return Response.json({ path: `${url.pathname}${url.search}`, method: request.method });
  },
});

afterAll(() => upstream.stop(true));

describe("Control Plane deployment edge", () => {
  const target = `http://127.0.0.1:${upstream.port}`;
  const handler = createControlPlaneEdgeHandler({ publicApi: target, adminApi: target, workerControlApi: target });

  test("routes all three API trust-domain paths through one deployment port", async () => {
    for (const path of ["/v1/tasks/task_test", "/admin/v1/tasks?limit=1", "/internal/v1/workers/register"]) {
      const response = await handler(new Request(`https://api.example.test${path}`));
      expect(response.status).toBe(200);
      expect((await response.json()).path).toBe(path);
    }
  });

  test("aggregates API readiness and rejects undeclared paths", async () => {
    expect((await handler(new Request("https://api.example.test/health/ready"))).status).toBe(200);
    expect((await handler(new Request("https://api.example.test/metrics"))).status).toBe(404);
  });
});
