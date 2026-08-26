const root = new URL("./dist/", import.meta.url);
const headers = {
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const resolveAsset = (pathname: string): URL | undefined => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relative = decoded.replace(/^\/+/, "");
  if (relative.split("/").includes("..")) return undefined;
  return new URL(relative || "index.html", root);
};

const parseAdminApiUrl = (raw: string | undefined): URL | undefined => {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid_admin_api_url");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
};

const parseAdminApiPublicUrl = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_admin_api_public_url");
  }
  return url.origin;
};

export const createAdminWebHandler =
  (
    adminApiUrl = parseAdminApiUrl(process.env.ADMIN_API_URL),
    adminApiPublicUrl = parseAdminApiPublicUrl(process.env.ADMIN_API_PUBLIC_URL),
  ) =>
  async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/runtime-config.js") {
      return new Response(
        `globalThis.__ASTRA_CONFIG__ = Object.freeze(${JSON.stringify({ ADMIN_API_PUBLIC_URL: adminApiPublicUrl })});`,
        { headers: { ...headers, "content-type": "application/javascript; charset=utf-8" } },
      );
    }
    if (requestUrl.pathname === "/admin/v1" || requestUrl.pathname.startsWith("/admin/v1/")) {
      if (!adminApiUrl) {
        return Response.json(
          { error: { code: "admin_api_not_configured", message: "ADMIN_API_URL is not configured" } },
          { status: 503, headers },
        );
      }
      const upstream = new URL(`${requestUrl.pathname}${requestUrl.search}`, adminApiUrl);
      const upstreamHeaders = new Headers(request.headers);
      upstreamHeaders.delete("host");
      upstreamHeaders.set("x-forwarded-host", requestUrl.host);
      upstreamHeaders.set("x-forwarded-proto", requestUrl.protocol.slice(0, -1));
      try {
        const upstreamRequest: RequestInit = {
          method: request.method,
          headers: upstreamHeaders,
          redirect: "manual",
        };
        if (request.method !== "GET" && request.method !== "HEAD") upstreamRequest.body = request.body;
        return await fetch(upstream, upstreamRequest);
      } catch {
        return Response.json(
          { error: { code: "admin_api_unavailable", message: "Admin API is unavailable" } },
          { status: 502, headers },
        );
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers });
    }
    const { pathname } = requestUrl;
    if (pathname === "/health/live") return Response.json({ status: "ok" }, { headers });
    if (pathname === "/health/ready") return Response.json({ status: "ready" }, { headers });

    const assetUrl = resolveAsset(pathname);
    if (!assetUrl) return new Response("Not Found", { status: 404, headers });
    const asset = Bun.file(assetUrl);
    const selected = (await asset.exists()) ? asset : Bun.file(new URL("index.html", root));
    return new Response(request.method === "HEAD" ? null : selected, { headers });
  };

if (import.meta.main) {
  const port = Number.parseInt(process.env.ADMIN_WEB_PORT ?? "8080", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_admin_web_port");
  const fetch = createAdminWebHandler();
  Bun.serve({ hostname: "0.0.0.0", port, fetch });
  console.log(JSON.stringify({ service: "admin-web", status: "started", port }));
}
