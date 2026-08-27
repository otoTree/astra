import { createHash } from "node:crypto";
import { releaseManifestSchema } from "@astra/contracts";
import { AdminManagementError, type OciImageResolver, type ResolvedOciImage } from "@astra/database";

const manifestAccept = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const releaseManifestAnnotation = "io.astra.release-manifest.v1";
const workflowHashAnnotation = "io.astra.workflow-sha256";

type ParsedReference = Readonly<{ registry: string; repository: string; reference: string; pinnedDigest?: string }>;
type OciFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function parseOciImageReference(sourceImage: string): ParsedReference {
  const withoutScheme = sourceImage.replace(/^https?:\/\//, "");
  const slash = withoutScheme.indexOf("/");
  if (slash <= 0) throw new AdminManagementError("invalid_oci_image_reference", 422);
  const registry = withoutScheme.slice(0, slash);
  const remainder = withoutScheme.slice(slash + 1);
  const digestSeparator = remainder.lastIndexOf("@");
  if (digestSeparator > 0) {
    const repository = remainder.slice(0, digestSeparator);
    const digest = remainder.slice(digestSeparator + 1);
    if (!digestPattern.test(digest)) throw new AdminManagementError("invalid_oci_image_digest", 422);
    return { registry, repository, reference: digest, pinnedDigest: digest };
  }
  const lastSlash = remainder.lastIndexOf("/");
  const colon = remainder.lastIndexOf(":");
  const hasTag = colon > lastSlash;
  const repository = hasTag ? remainder.slice(0, colon) : remainder;
  const reference = hasTag ? remainder.slice(colon + 1) : "latest";
  if (!registry || !repository || !reference || /\s/.test(sourceImage)) {
    throw new AdminManagementError("invalid_oci_image_reference", 422);
  }
  return { registry, repository, reference };
}

export class DistributionOciImageResolver implements OciImageResolver {
  constructor(
    private readonly options: Readonly<{
      allowPlainHttp: boolean;
      bearerToken?: string;
      fetch?: OciFetch;
      timeoutMilliseconds?: number;
    }>,
  ) {}

  async resolve(sourceImage: string): Promise<ResolvedOciImage> {
    const parsed = parseOciImageReference(sourceImage);
    const protocol = this.options.allowPlainHttp ? "http" : "https";
    const url = `${protocol}://${parsed.registry}/v2/${parsed.repository}/manifests/${parsed.reference}`;
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, {
        headers: {
          accept: manifestAccept,
          ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMilliseconds ?? 5_000),
      });
    } catch {
      throw new AdminManagementError("oci_registry_unavailable", 503, true);
    }
    if (response.status === 401 || response.status === 403)
      throw new AdminManagementError("oci_registry_access_denied", 422);
    if (response.status === 404) throw new AdminManagementError("oci_image_not_found", 404);
    if (!response.ok) throw new AdminManagementError("oci_registry_unavailable", 503, true);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 1024 * 1024) throw new AdminManagementError("oci_manifest_too_large", 422);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024)
      throw new AdminManagementError("invalid_oci_manifest", 422);
    const computedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const digest = response.headers.get("docker-content-digest")?.toLowerCase();
    if (!digest || !digestPattern.test(digest) || digest !== computedDigest) {
      throw new AdminManagementError("oci_manifest_digest_mismatch", 422);
    }
    if (parsed.pinnedDigest && parsed.pinnedDigest !== digest) {
      throw new AdminManagementError("oci_pinned_digest_mismatch", 409);
    }
    let manifest: {
      mediaType?: unknown;
      config?: { digest?: unknown };
      annotations?: Record<string, unknown>;
    };
    try {
      manifest = JSON.parse(Buffer.from(bytes).toString("utf8")) as typeof manifest;
    } catch {
      throw new AdminManagementError("invalid_oci_manifest", 422);
    }
    const mediaType =
      typeof manifest.mediaType === "string" ? manifest.mediaType : response.headers.get("content-type");
    const configDigest = manifest.config?.digest;
    if (
      !mediaType ||
      !manifestAccept.includes(mediaType) ||
      typeof configDigest !== "string" ||
      !digestPattern.test(configDigest)
    ) {
      throw new AdminManagementError("invalid_oci_manifest", 422);
    }
    let releaseMetadata: ResolvedOciImage["releaseMetadata"];
    const encodedReleaseManifest = manifest.annotations?.[releaseManifestAnnotation];
    const workflowHash = manifest.annotations?.[workflowHashAnnotation];
    if (encodedReleaseManifest !== undefined || workflowHash !== undefined) {
      if (
        typeof encodedReleaseManifest !== "string" ||
        encodedReleaseManifest.length > 256 * 1024 ||
        typeof workflowHash !== "string" ||
        !sha256Pattern.test(workflowHash)
      ) {
        throw new AdminManagementError("invalid_astra_image_metadata", 422);
      }
      let releaseManifest: unknown;
      try {
        releaseManifest = JSON.parse(encodedReleaseManifest);
      } catch {
        throw new AdminManagementError("invalid_astra_image_metadata", 422);
      }
      const parsedReleaseManifest = releaseManifestSchema.safeParse(releaseManifest);
      if (!parsedReleaseManifest.success) {
        throw new AdminManagementError("invalid_astra_image_metadata", 422);
      }
      releaseMetadata = {
        workflowHash,
        manifest: parsedReleaseManifest.data,
      };
    }
    return {
      sourceImage,
      digest,
      mediaType,
      configDigest,
      manifestSizeBytes: bytes.byteLength,
      ...(releaseMetadata ? { releaseMetadata } : {}),
    };
  }
}
