import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";

if (process.env.ASTRA_ENV !== "local" && process.env.ASTRA_ENV !== "test") {
  throw new Error("registry_reference_requires_local_or_test_environment");
}
const port = z.coerce.number().int().min(1).max(65535).default(5000).parse(process.env.REGISTRY_REFERENCE_PORT);
const config = Buffer.from(
  JSON.stringify({ architecture: "amd64", os: "linux", config: {}, rootfs: { type: "layers", diff_ids: [] } }),
);
const configDigest = `sha256:${createHash("sha256").update(config).digest("hex")}`;
const releaseManifest = {
  worker_contract_version: "v1",
  modalities: ["video"],
  operations: ["generation"],
  capabilities: { durations: [5] },
  parameter_schema: { type: "object", additionalProperties: false },
  output_contract: { media_types: ["video/mp4"], preserve_original_bytes: true },
  resource_requirements: { gpu_skus: ["reference-gpu"], gpu_memory_bytes: 34359738368, concurrency: 1 },
  components: [],
  weights: [],
};
const manifest = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: config.byteLength },
    layers: [],
    annotations: {
      "org.opencontainers.image.title": "Astra contract reference model app",
      "org.opencontainers.image.description": "Protocol-only manifest; contains no model weights or inference runtime",
      "io.astra.release-manifest.v1": JSON.stringify(releaseManifest),
      "io.astra.workflow-sha256": "0".repeat(64),
    },
  }),
);
const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
const app = new Hono();
app.get("/health/ready", (context) => context.json({ status: "ready", digest: manifestDigest }));
app.get("/v2/", (context) => context.body(null, 200));
app.get("/v2/astra/model-app/manifests/:reference", (context) => {
  const reference = context.req.param("reference");
  if (reference !== "local" && reference !== "latest" && reference !== manifestDigest) {
    return context.json({ errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }] }, 404);
  }
  context.header("Content-Type", "application/vnd.oci.image.manifest.v1+json");
  context.header("Docker-Content-Digest", manifestDigest);
  context.header("Content-Length", String(manifest.byteLength));
  return context.body(manifest);
});
app.get("/v2/astra/model-app/blobs/:digest", (context) => {
  if (context.req.param("digest") !== configDigest) return context.body(null, 404);
  context.header("Content-Type", "application/vnd.oci.image.config.v1+json");
  context.header("Docker-Content-Digest", configDigest);
  return context.body(config);
});
Bun.serve({ port, fetch: app.fetch });
console.log(
  JSON.stringify({ level: "info", event: "registry_reference_started", port, manifest_digest: manifestDigest }),
);
