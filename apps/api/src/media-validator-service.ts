import { createHash, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  errorResponse,
  inputMediaTypeForContentType,
  mediaMetadataSchema,
  mediaValidationRequestSchema,
  type MediaMetadata,
} from "@astra/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { Counter, Histogram, createMetricRegistry, metricResponse } from "@astra/observability";

export type MediaValidatorServiceOptions = Readonly<{
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  token: string;
  maxBytes: number;
  timeoutSeconds: number;
}>;

const probeSchema = z
  .object({
    streams: z.array(
      z
        .object({
          codec_type: z.enum(["video", "audio"]).optional(),
          codec_name: z.string().optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          avg_frame_rate: z.string().optional(),
          sample_rate: z.string().optional(),
          channels: z.number().int().positive().optional(),
          duration: z.string().optional(),
        })
        .passthrough(),
    ),
    format: z.object({ format_name: z.string().optional(), duration: z.string().optional() }).passthrough(),
  })
  .passthrough();

const equalToken = (authorization: string | undefined, expected: string): boolean => {
  const actual = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const fraction = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const [numeratorValue, denominatorValue] = value.split("/");
  const numerator = Number(numeratorValue);
  const denominator = Number(denominatorValue ?? 1);
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
};

type ProcessResult = Readonly<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

async function run(command: string[], timeoutSeconds: number): Promise<ProcessResult> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    process.kill("SIGKILL");
  }, timeoutSeconds * 1000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

type DetectedMedia = "png" | "jpeg" | "webp" | "iso-bmff" | "wav" | "mp3" | "flac";

function detectedMedia(bytes: Uint8Array): DetectedMedia | undefined {
  const ascii = (start: number, end: number): string => new TextDecoder("ascii").decode(bytes.slice(start, end));
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp") return "iso-bmff";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "mp3";
  return undefined;
}

async function verifySignature(path: string, contentType: string): Promise<void> {
  const signature = await Bun.file(path).slice(0, 16).bytes();
  const detected = detectedMedia(signature);
  const accepted: Readonly<Record<string, readonly DetectedMedia[]>> = {
    "image/png": ["png"],
    "image/jpeg": ["jpeg"],
    "image/webp": ["webp"],
    "video/mp4": ["iso-bmff"],
    "video/quicktime": ["iso-bmff"],
    "audio/wav": ["wav"],
    "audio/x-wav": ["wav"],
    "audio/mpeg": ["mp3"],
    "audio/flac": ["flac"],
    "audio/x-flac": ["flac"],
  };
  if (!detected || !accepted[contentType]?.includes(detected)) throw new Error("media_signature_mismatch");
}

async function inspect(path: string, contentType: string, timeoutSeconds: number): Promise<MediaMetadata> {
  const decode = await run(
    [
      "ffmpeg",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-i",
      path,
      "-map",
      "0",
      "-f",
      "null",
      "-",
    ],
    timeoutSeconds,
  );
  if (decode.timedOut) throw new Error("media_decode_timeout");
  if (decode.exitCode !== 0) throw new Error("media_decode_failed");

  const probe = await run(
    ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    Math.min(timeoutSeconds, 60),
  );
  if (probe.timedOut) throw new Error("media_probe_timeout");
  if (probe.exitCode !== 0) throw new Error("media_probe_failed");
  const parsed = probeSchema.safeParse(JSON.parse(probe.stdout));
  if (!parsed.success) throw new Error("media_probe_invalid");
  const expectedType = inputMediaTypeForContentType(contentType);
  const video = parsed.data.streams.find((stream) => stream.codec_type === "video");
  const audio = parsed.data.streams.find((stream) => stream.codec_type === "audio");
  if ((expectedType === "image" || expectedType === "video") && !video) throw new Error("media_type_mismatch");
  if (expectedType === "audio" && (!audio || video)) throw new Error("media_type_mismatch");
  if (expectedType === "image" && audio) throw new Error("media_type_mismatch");
  if ((expectedType === "image" || expectedType === "video") && (!video?.width || !video.height)) {
    throw new Error("media_dimensions_missing");
  }
  const durationValue = Number(parsed.data.format.duration ?? video?.duration ?? audio?.duration);
  const duration = Number.isFinite(durationValue) && durationValue > 0 ? durationValue : undefined;
  if (expectedType === "video" && !duration) throw new Error("media_duration_missing");
  return mediaMetadataSchema.parse({
    media_type: expectedType,
    container: parsed.data.format.format_name ?? "unknown",
    ...(video?.width ? { width: video.width } : {}),
    ...(video?.height ? { height: video.height } : {}),
    ...(duration ? { duration_seconds: duration } : {}),
    ...(fraction(video?.avg_frame_rate) ? { fps: fraction(video?.avg_frame_rate) } : {}),
    ...(video?.codec_name ? { video_codec: video.codec_name } : {}),
    ...(audio?.codec_name ? { audio_codec: audio.codec_name } : {}),
    ...(audio?.sample_rate && Number(audio.sample_rate) > 0 ? { audio_sample_rate: Number(audio.sample_rate) } : {}),
    ...(audio?.channels ? { audio_channels: audio.channels } : {}),
  });
}

export function createMediaValidatorService(options: MediaValidatorServiceOptions): Hono {
  const storage = new S3Client({
    endpoint: options.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
  });
  const app = new Hono();
  const metrics = createMetricRegistry("media-validator");
  const validations = new Counter({
    name: "astra_media_validations_total",
    help: "Media validation requests by HTTP result",
    labelNames: ["status"] as const,
    registers: [metrics],
  });
  const validationDuration = new Histogram({
    name: "astra_media_validation_duration_seconds",
    help: "Strict media validation duration",
    labelNames: ["status"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 300, 600],
    registers: [metrics],
  });
  app.use("/internal/v1/media/validate", async (context, next) => {
    const started = performance.now();
    await next();
    const status = String(context.res.status);
    validations.inc({ status });
    validationDuration.observe({ status }, (performance.now() - started) / 1000);
  });
  app.get("/health/live", (context) => context.json({ status: "ok" }));
  app.get("/health/ready", async (context) => {
    try {
      await storage.send(new HeadBucketCommand({ Bucket: options.bucket }));
      return context.json({ status: "ready", storage: "ready", media_toolchain: "ready" });
    } catch {
      return context.json({ status: "not_ready", storage: "unavailable", media_toolchain: "ready" }, 503);
    }
  });
  app.get("/metrics", () => metricResponse(metrics));
  app.post("/internal/v1/media/validate", async (context) => {
    const requestId = context.req.header("x-request-id") ?? `req_${Bun.randomUUIDv7()}`;
    if (!equalToken(context.req.header("authorization"), options.token)) {
      return errorResponse(requestId, 401, "invalid_service_token", "Service authentication failed");
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return errorResponse(requestId, 400, "invalid_json", "Request body must be valid JSON");
    }
    const parsed = mediaValidationRequestSchema.safeParse(body);
    if (!parsed.success) return errorResponse(requestId, 422, "invalid_request", "Validation request is invalid");
    if (parsed.data.size_bytes > options.maxBytes) {
      return errorResponse(requestId, 422, "media_too_large", "Media exceeds validator limit");
    }

    const directory = await mkdtemp(join(tmpdir(), "astra-media-"));
    const path = join(directory, "input");
    try {
      const object = await storage.send(new GetObjectCommand({ Bucket: options.bucket, Key: parsed.data.object_key }));
      if (!object.Body) {
        return errorResponse(requestId, 503, "storage_stream_unavailable", "Storage stream is unavailable", true);
      }
      if (object.ContentLength !== parsed.data.size_bytes) {
        return errorResponse(requestId, 422, "media_integrity_mismatch", "Stored media size does not match");
      }
      const digest = createHash("sha256");
      const reader = object.Body.transformToWebStream().getReader();
      async function* chunks(): AsyncGenerator<Uint8Array> {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            if (chunk.value instanceof Uint8Array) {
              digest.update(chunk.value);
              yield chunk.value;
            } else throw new Error("storage_stream_invalid");
          }
        } finally {
          reader.releaseLock();
        }
      }
      await pipeline(chunks(), createWriteStream(path, { flags: "wx", mode: 0o600 }));
      if (digest.digest("hex") !== parsed.data.sha256) {
        return errorResponse(requestId, 422, "media_integrity_mismatch", "Stored media hash does not match");
      }
      await verifySignature(path, parsed.data.content_type);
      const media = await inspect(path, parsed.data.content_type, options.timeoutSeconds);
      return context.json({ file_id: parsed.data.file_id, valid: true as const, media });
    } catch (error) {
      const invalidCodes = new Set([
        "media_decode_failed",
        "media_probe_failed",
        "media_probe_invalid",
        "media_type_mismatch",
        "media_duration_missing",
        "media_dimensions_missing",
        "media_signature_mismatch",
      ]);
      const code = error instanceof Error ? error.message : "media_validator_failed";
      if (invalidCodes.has(code)) {
        console.warn(JSON.stringify({ level: "warn", service: "media-validator", code, request_id: requestId }));
        return errorResponse(requestId, 422, code, "Media failed strict validation");
      }
      if (code === "media_decode_timeout" || code === "media_probe_timeout") {
        return errorResponse(requestId, 503, code, "Media validation timed out", true);
      }
      console.error(JSON.stringify({ level: "error", service: "media-validator", code, request_id: requestId }));
      return errorResponse(
        requestId,
        503,
        "media_validator_failed",
        "Media validation is temporarily unavailable",
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return app;
}
