import { describe, expect, test } from "bun:test";
import {
  capabilitiesSchema,
  executionInputSchema,
  imageEditSchema,
  imageGenerationSchema,
  inputMediaTypeForContentType,
  outputManifestSchema,
  resolveVideoGenerationRequest,
  videoEditSchema,
  videoGenerationSchema,
} from "./index.ts";

describe("contracts", () => {
  test("accepts a valid video generation request", () => {
    const result = videoGenerationSchema.parse({
      model: "minimax-h3-10eros",
      prompt: "a slow camera move",
      aspect_ratio: "16:9",
      resolution: "0.7mp",
      duration: 15,
    });
    expect(result.priority).toBe("online");
    expect(result.input_files).toEqual([]);
  });

  test("rejects an invalid aspect ratio", () => {
    expect(() =>
      videoGenerationSchema.parse({
        model: "h3",
        prompt: "x",
        aspect_ratio: "wide",
        resolution: "0.7mp",
        duration: 15,
      }),
    ).toThrow();
  });

  test("rejects client-controlled seed, fps, negative prompt and arbitrary URLs", () => {
    expect(() =>
      videoGenerationSchema.parse({
        model: "h3",
        prompt: "x",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        seed: 1,
      }),
    ).toThrow();
    expect(() =>
      videoGenerationSchema.parse({
        model: "h3",
        prompt: "x",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        fps: 24,
      }),
    ).toThrow();
    expect(() =>
      videoGenerationSchema.parse({
        model: "h3",
        prompt: "x",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        negative_prompt: "x",
      }),
    ).toThrow();
    expect(() =>
      videoGenerationSchema.parse({
        model: "h3",
        prompt: "x",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        input_files: [
          { file_id: "file_1", type: "image", role: "reference_image", url: "https://example.invalid/a.png" },
        ],
      }),
    ).toThrow();
  });

  test("resolves system seed and release fps", () => {
    const request = videoGenerationSchema.parse({
      model: "h3",
      prompt: "x",
      aspect_ratio: "16:9",
      resolution: "0.7mp",
      duration: 15,
    });
    const resolved = resolveVideoGenerationRequest(request, {
      fps: 24,
      resolutionMatrix: { "16:9/0.7mp": { width: 1152, height: 640 } },
    });
    expect(resolved.fps).toBe(24);
    expect([resolved.width, resolved.height]).toEqual([1152, 640]);
    expect(Number.isSafeInteger(resolved.seed)).toBe(true);
  });

  test("rejects a resolution combination not declared by the release", () => {
    const request = videoGenerationSchema.parse({
      model: "h3",
      prompt: "x",
      aspect_ratio: "9:16",
      resolution: "0.7mp",
      duration: 15,
    });
    expect(() =>
      resolveVideoGenerationRequest(request, {
        fps: 24,
        resolutionMatrix: { "16:9/0.7mp": { width: 1152, height: 640 } },
      }),
    ).toThrow("model_capability_mismatch");
  });

  test("strictly binds input media type to role", () => {
    expect(() =>
      videoGenerationSchema.parse({
        model: "h3",
        prompt: "x",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        input_files: [{ file_id: "file_1", type: "audio", role: "reference_image" }],
      }),
    ).toThrow();
    const request = videoGenerationSchema.parse({
      model: "h3",
      prompt: "x",
      aspect_ratio: "16:9",
      resolution: "0.7mp",
      duration: 15,
      input_files: [{ file_id: "file_1", type: "audio", role: "reference_audio" }],
    });
    expect(request.input_files[0]?.type).toBe("audio");
  });

  test("strictly validates source audio mixing", () => {
    expect(() =>
      videoGenerationSchema.parse({
        model: "h3",
        prompt: "x",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        audio: { mode: "native", source_mix: 0.5 },
      }),
    ).toThrow();
    expect(() =>
      videoGenerationSchema.parse({
        model: "h3",
        prompt: "x",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        audio: { mode: "remix_source", source_mix: 0.5 },
        input_files: [{ file_id: "file_source", type: "audio", role: "source_audio" }],
      }),
    ).not.toThrow();
  });

  test("strictly separates generation and edit input roles", () => {
    expect(() =>
      imageGenerationSchema.parse({
        model: "image",
        prompt: "x",
        size: "1024x1024",
        input_files: [{ file_id: "file_1", type: "image", role: "mask" }],
      }),
    ).toThrow();
    expect(() =>
      imageEditSchema.parse({
        model: "image",
        prompt: "x",
        size: "1024x1024",
        input_files: [{ file_id: "file_1", type: "image", role: "reference_image" }],
      }),
    ).not.toThrow();
    expect(() =>
      videoEditSchema.parse({
        model: "h3",
        prompt: "x",
        aspect_ratio: "16:9",
        resolution: "0.7mp",
        duration: 15,
        input_files: [],
      }),
    ).toThrow();
  });

  test("maps only approved reference MIME types", () => {
    expect(inputMediaTypeForContentType("image/png")).toBe("image");
    expect(inputMediaTypeForContentType("video/mp4")).toBe("video");
    expect(inputMediaTypeForContentType("audio/mpeg")).toBe("audio");
    expect(inputMediaTypeForContentType("application/pdf")).toBeUndefined();
    expect(inputMediaTypeForContentType("image/svg+xml")).toBeUndefined();
  });

  test("requires a declared worker contract", () => {
    expect(() => capabilitiesSchema.parse({ contract_version: "1.0" })).toThrow();
  });

  test("rejects links and undeclared fields in a worker execution input", () => {
    expect(() =>
      executionInputSchema.parse({
        file_id: "file_1",
        type: "image",
        role: "reference_image",
        path: "/work/tasks/task_1/inputs/file_1.png",
        content_type: "image/png",
        size_bytes: 1,
        sha256: "0".repeat(64),
        url: "https://example.invalid/a.png",
      }),
    ).toThrow();
  });

  test("requires output provenance and execution usage", () => {
    expect(() =>
      outputManifestSchema.parse({
        execution_id: "execution_1",
        status: "completed",
        outputs: [
          {
            role: "result",
            path: "/work/tasks/attempt_1/outputs/result.mp4",
            content_type: "video/mp4",
            sha256: "0".repeat(64),
            size_bytes: 1,
            media: {},
            provenance: { producer: "model_app", transformations: ["platform_transcode"] },
          },
        ],
      }),
    ).toThrow();
  });
});
