import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DistributionOciImageResolver, parseOciImageReference } from "./oci-image-resolver.ts";

const manifestBytes = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${"b".repeat(64)}`, size: 100 },
    layers: [],
  }),
);
const digest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;

describe("OCI image resolver", () => {
  test("parses tags and pinned digests without registry heuristics", () => {
    expect(parseOciImageReference("registry.internal:5000/team/model:v3")).toEqual({
      registry: "registry.internal:5000",
      repository: "team/model",
      reference: "v3",
    });
    expect(parseOciImageReference(`registry.internal/team/model@${digest}`)).toEqual({
      registry: "registry.internal",
      repository: "team/model",
      reference: digest,
      pinnedDigest: digest,
    });
  });

  test("verifies the registry digest against exact manifest bytes", async () => {
    let requested = "";
    const resolver = new DistributionOciImageResolver({
      allowPlainHttp: true,
      fetch: async (input) => {
        requested = String(input);
        return new Response(manifestBytes, {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "docker-content-digest": digest,
            "content-length": String(manifestBytes.byteLength),
          },
        });
      },
    });
    const result = await resolver.resolve("registry.internal:5000/team/model:v3");
    expect(requested).toBe("http://registry.internal:5000/v2/team/model/manifests/v3");
    expect(result.digest).toBe(digest);
    expect(result.configDigest).toBe(`sha256:${"b".repeat(64)}`);
  });

  test("rejects forged digest headers and pinned digest changes", async () => {
    const forged = new DistributionOciImageResolver({
      allowPlainHttp: false,
      fetch: async () =>
        new Response(manifestBytes, {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "docker-content-digest": `sha256:${"c".repeat(64)}`,
          },
        }),
    });
    await expect(forged.resolve("registry.internal/team/model:v3")).rejects.toThrow("oci_manifest_digest_mismatch");
    const valid = new DistributionOciImageResolver({
      allowPlainHttp: false,
      fetch: async () =>
        new Response(manifestBytes, {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "docker-content-digest": digest,
          },
        }),
    });
    await expect(valid.resolve(`registry.internal/team/model@sha256:${"d".repeat(64)}`)).rejects.toThrow(
      "oci_pinned_digest_mismatch",
    );
  });
});
