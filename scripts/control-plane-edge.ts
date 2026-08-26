type EdgeTargets = Readonly<{
  publicApi: string;
  adminApi: string;
  workerControlApi: string;
}>;

const defaultTargets: EdgeTargets = {
  publicApi: "http://127.0.0.1:4100",
  adminApi: "http://127.0.0.1:4101",
  workerControlApi: "http://127.0.0.1:4102",
};

const targetForPath = (pathname: string, targets: EdgeTargets): string | undefined => {
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return targets.publicApi;
  if (pathname === "/admin/v1" || pathname.startsWith("/admin/v1/")) return targets.adminApi;
  if (pathname === "/internal/v1" || pathname.startsWith("/internal/v1/")) return targets.workerControlApi;
  return undefined;
};

export const createControlPlaneEdgeHandler =
  (targets: EdgeTargets = defaultTargets) =>
  async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/health/live") return Response.json({ status: "ok" });
    if (requestUrl.pathname === "/health/ready") {
      const checks = await Promise.allSettled(
        Object.values(targets).map(async (target) => {
          const response = await fetch(`${target}/health/ready`, { signal: AbortSignal.timeout(2_000) });
          return response.ok;
        }),
      );
      const ready = checks.every((check) => check.status === "fulfilled" && check.value);
      return Response.json({ status: ready ? "ready" : "not_ready" }, { status: ready ? 200 : 503 });
    }
    const target = targetForPath(requestUrl.pathname, targets);
    if (!target)
      return Response.json({ error: { code: "route_not_found", message: "Route not found" } }, { status: 404 });

    const upstream = new URL(`${requestUrl.pathname}${requestUrl.search}`, target);
    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.delete("host");
    upstreamHeaders.set("x-forwarded-host", requestUrl.host);
    upstreamHeaders.set("x-forwarded-proto", requestUrl.protocol.slice(0, -1));
    try {
      const init: RequestInit = { method: request.method, headers: upstreamHeaders, redirect: "manual" };
      if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
      return await fetch(upstream, init);
    } catch {
      return Response.json(
        { error: { code: "control_plane_upstream_unavailable", message: "Control Plane service is unavailable" } },
        { status: 502 },
      );
    }
  };

if (import.meta.main) {
  const port = Number.parseInt(process.env.CONTROL_PLANE_PORT ?? "8080", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_control_plane_port");
  Bun.serve({ hostname: "0.0.0.0", port, fetch: createControlPlaneEdgeHandler() });
  console.log(JSON.stringify({ service: "control-plane-edge", status: "started", port }));
}
