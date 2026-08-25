const port = Number.parseInt(process.env.ADMIN_WEB_PORT ?? "8080", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_admin_web_port");

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

Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers });
    }
    const { pathname } = new URL(request.url);
    if (pathname === "/health/live") return Response.json({ status: "ok" }, { headers });
    if (pathname === "/health/ready") return Response.json({ status: "ready" }, { headers });

    const assetUrl = resolveAsset(pathname);
    if (!assetUrl) return new Response("Not Found", { status: 404, headers });
    const asset = Bun.file(assetUrl);
    const selected = (await asset.exists()) ? asset : Bun.file(new URL("index.html", root));
    return new Response(request.method === "HEAD" ? null : selected, { headers });
  },
});

console.log(JSON.stringify({ service: "admin-web", status: "started", port }));
