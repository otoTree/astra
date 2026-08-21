import { loadMediaValidatorConfig } from "@astra/config";
import { createMediaValidatorService } from "./media-validator-service.ts";
import { serve } from "./server.ts";

const config = loadMediaValidatorConfig();
const ffmpeg = Bun.spawnSync(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" });
const ffprobe = Bun.spawnSync(["ffprobe", "-version"], { stdout: "ignore", stderr: "ignore" });
if (ffmpeg.exitCode !== 0 || ffprobe.exitCode !== 0) throw new Error("media_toolchain_unavailable");
serve(
  createMediaValidatorService({
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    token: config.MEDIA_VALIDATOR_TOKEN,
    maxBytes: config.MEDIA_VALIDATOR_MAX_BYTES,
    timeoutSeconds: config.MEDIA_VALIDATOR_TIMEOUT_SECONDS,
  }),
  config.MEDIA_VALIDATOR_PORT,
  "media-validator",
);
