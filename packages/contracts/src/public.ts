import { z } from "zod";

export const taskStatusSchema = z.enum([
  "queued",
  "scheduling",
  "provisioning",
  "running",
  "post_processing",
  "uploading",
  "completed",
  "failed",
  "canceling",
  "canceled",
  "expired",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const allowedInputContentTypes = {
  image: ["image/png", "image/jpeg", "image/webp"],
  video: ["video/mp4", "video/quicktime"],
  audio: ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/flac", "audio/x-flac"],
} as const;
export type InputMediaType = keyof typeof allowedInputContentTypes;

export function inputMediaTypeForContentType(contentType: string): InputMediaType | undefined {
  return (Object.entries(allowedInputContentTypes) as Array<[InputMediaType, readonly string[]]>).find(([, values]) =>
    values.includes(contentType),
  )?.[0];
}

export const fileUploadRequestSchema = z
  .object({
    filename: z.string().min(1).max(255),
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
    size_bytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    purpose: z.literal("generation_input"),
  })
  .strict();
export type FileUploadRequest = z.infer<typeof fileUploadRequestSchema>;

export const inputFileSchema = z
  .object({
    file_id: z.string().min(1),
    role: z.string().min(1),
  })
  .strict();

export const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

export const resolutionSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?mp$/)
  .max(16);
export type Resolution = z.infer<typeof resolutionSchema>;

const referenceImageSchema = z
  .object({
    file_id: z.string().min(1),
    type: z.literal("image"),
    role: z.enum(["reference_image", "first_frame", "last_frame"]),
  })
  .strict();

const referenceVideoSchema = z
  .object({
    file_id: z.string().min(1),
    type: z.literal("video"),
    role: z.enum(["reference_video", "source_video"]),
  })
  .strict();

const referenceAudioSchema = z
  .object({
    file_id: z.string().min(1),
    type: z.literal("audio"),
    role: z.enum(["reference_audio", "reference_video_audio", "source_audio"]),
  })
  .strict();

export const videoInputFileSchema = z.discriminatedUnion("type", [
  referenceImageSchema,
  referenceVideoSchema,
  referenceAudioSchema,
]);
export type VideoInputFile = z.infer<typeof videoInputFileSchema>;

const imageReferenceSchema = z
  .object({
    file_id: z.string().min(1),
    type: z.literal("image"),
    role: z.literal("reference_image"),
  })
  .strict();

const imageMaskSchema = z
  .object({
    file_id: z.string().min(1),
    type: z.literal("image"),
    role: z.literal("mask"),
  })
  .strict();

export const videoInputFilesSchema = z
  .array(videoInputFileSchema)
  .max(15)
  .superRefine((files, context) => {
    const counts = files.reduce<Record<string, number>>((accumulator, file) => {
      accumulator[file.role] = (accumulator[file.role] ?? 0) + 1;
      return accumulator;
    }, {});
    const limits: Record<string, number> = {
      reference_image: 9,
      first_frame: 1,
      last_frame: 1,
      reference_video: 3,
      source_video: 1,
      reference_audio: 3,
      reference_video_audio: 3,
      source_audio: 1,
    };
    for (const [role, count] of Object.entries(counts)) {
      const limit = limits[role];
      if (limit !== undefined && count > limit) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${role} accepts at most ${limit} file(s)` });
      }
    }
    const fileIds = files.map((file) => file.file_id);
    if (new Set(fileIds).size !== fileIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "input_files cannot contain duplicate file_id values" });
    }
  });

const metadataSchema = z.record(z.string().min(1).max(64), z.string().max(512)).superRefine((metadata, context) => {
  if (Object.keys(metadata).length > 16)
    context.addIssue({ code: z.ZodIssueCode.too_big, maximum: 16, inclusive: true, type: "array" });
});

const baseGenerationSchema = z
  .object({
    model: z.string().min(1),
    prompt: z.string().min(1).max(20_000),
    input_files: z.array(inputFileSchema).max(16).default([]),
    priority: z.enum(["online", "batch"]).default("online"),
    metadata: metadataSchema.optional(),
    model_options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const videoGenerationSchema = baseGenerationSchema
  .extend({
    aspect_ratio: aspectRatioSchema,
    resolution: resolutionSchema,
    duration: z.number().int().min(4).max(15),
    input_files: videoInputFilesSchema.default([]),
    audio: z
      .object({
        mode: z.enum(["native", "none", "reference", "lock_source", "remix_source"]),
        source_mix: z.number().min(0).max(1).optional(),
      })
      .strict()
      .superRefine((audio, context) => {
        if (audio.source_mix !== undefined && audio.mode !== "remix_source") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["source_mix"],
            message: "source_mix is only valid for remix_source",
          });
        }
      })
      .optional(),
  })
  .strict();
export type VideoGenerationRequest = z.infer<typeof videoGenerationSchema>;

export type VideoRuntimeProfile = Readonly<{
  fps: number;
  resolutionMatrix: Readonly<Record<string, Readonly<{ width: number; height: number }>>>;
}>;

export type ResolvedVideoGenerationRequest = VideoGenerationRequest & {
  seed: number;
  fps: number;
  width: number;
  height: number;
};

export function secureRandomSeed(): number {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  const seed = (BigInt((random[0] ?? 0) & 0x1f_ffff) << 32n) | BigInt(random[1] ?? 0);
  return Number(seed);
}

/** Server-side defaults. These values must be written to the Task request snapshot, never accepted from clients. */
export function resolveVideoGenerationRequest(
  request: VideoGenerationRequest,
  profile: VideoRuntimeProfile,
  createSeed: () => number = secureRandomSeed,
): ResolvedVideoGenerationRequest {
  const dimensions = profile.resolutionMatrix[`${request.aspect_ratio}/${request.resolution}`];
  if (!dimensions) throw new Error("model_capability_mismatch");
  const seed = createSeed();
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("invalid_system_seed");
  return { ...request, seed, fps: profile.fps, width: dimensions.width, height: dimensions.height };
}

export const imageGenerationSchema = baseGenerationSchema
  .extend({
    size: z.string().regex(/^\d+x\d+$/),
    quality: z.enum(["standard", "high"]).optional(),
    n: z.number().int().min(1).max(4).default(1),
    output_format: z.enum(["png", "jpeg", "webp"]).default("png"),
    input_files: z.array(imageReferenceSchema).max(16).default([]),
  })
  .strict();
export type ImageGenerationRequest = z.infer<typeof imageGenerationSchema>;

export const videoEditSchema = videoGenerationSchema.superRefine((request, context) => {
  if (request.input_files.filter((file) => file.role === "source_video").length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["input_files"],
      message: "video edits require exactly one source_video",
    });
  }
});
export type VideoEditRequest = z.infer<typeof videoEditSchema>;

export const imageEditSchema = baseGenerationSchema
  .extend({
    size: z.string().regex(/^\d+x\d+$/),
    quality: z.enum(["standard", "high"]).optional(),
    n: z.number().int().min(1).max(4).default(1),
    output_format: z.enum(["png", "jpeg", "webp"]).default("png"),
    input_files: z
      .array(z.union([imageReferenceSchema, imageMaskSchema]))
      .min(1)
      .max(17),
  })
  .strict()
  .superRefine((request, context) => {
    const references = request.input_files.filter((file) => file.role === "reference_image");
    const masks = request.input_files.filter((file) => file.role === "mask");
    if (references.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input_files"],
        message: "image edits require a reference_image",
      });
    }
    if (masks.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input_files"],
        message: "image edits accept at most one mask",
      });
    }
  });
export type ImageEditRequest = z.infer<typeof imageEditSchema>;

export const taskListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().min(1).optional(),
    type: z.enum(["video", "image"]).optional(),
    status: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    priority: z.enum(["online", "batch"]).optional(),
    created_after: z.coerce.number().int().nonnegative().optional(),
    created_before: z.coerce.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.created_after !== undefined &&
      query.created_before !== undefined &&
      query.created_after > query.created_before
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["created_after"],
        message: "created_after must not exceed created_before",
      });
    }
  });

export const modelListQuerySchema = z.object({ type: z.enum(["video", "image"]).optional() }).strict();

export const modelSchema = z
  .object({
    id: z.string(),
    object: z.literal("model"),
    type: z.enum(["video", "image"]),
    release: z.string(),
    maturity: z.enum(["candidate", "stable", "deprecated"]),
    operations: z.array(z.enum(["generation", "edit"])),
    capabilities: z.record(z.string(), z.unknown()),
    created_at: z.number().int(),
  })
  .strict();

export const taskSchema = z.object({
  id: z.string(),
  object: z.literal("generation.task"),
  type: z.enum(["video", "image"]),
  operation: z.enum(["generation", "edit"]),
  status: taskStatusSchema,
  model: z.string(),
  model_release: z.string(),
  priority: z.enum(["online", "batch"]),
  progress: z.number().int().min(0).max(100).nullable().optional(),
  status_reason: z.string().nullable().optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  output_file_ids: z.array(z.string()).default([]),
});
export type Task = z.infer<typeof taskSchema>;
