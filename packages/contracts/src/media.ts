import { z } from "zod";

export const mediaValidationRequestSchema = z
  .object({
    file_id: z.string().min(1),
    object_key: z.string().min(1),
    content_type: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "video/mp4",
      "video/quicktime",
      "audio/wav",
      "audio/x-wav",
      "audio/mpeg",
      "audio/flac",
      "audio/x-flac",
    ]),
    size_bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type MediaValidationRequest = z.infer<typeof mediaValidationRequestSchema>;

export const mediaMetadataSchema = z
  .object({
    media_type: z.enum(["image", "video", "audio"]),
    container: z.string().min(1),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    duration_seconds: z.number().positive().optional(),
    fps: z.number().positive().optional(),
    video_codec: z.string().min(1).optional(),
    audio_codec: z.string().min(1).optional(),
    audio_sample_rate: z.number().int().positive().optional(),
    audio_channels: z.number().int().positive().optional(),
  })
  .strict();
export type MediaMetadata = z.infer<typeof mediaMetadataSchema>;

export const mediaValidationResponseSchema = z
  .object({
    file_id: z.string().min(1),
    valid: z.literal(true),
    media: mediaMetadataSchema,
  })
  .strict();
