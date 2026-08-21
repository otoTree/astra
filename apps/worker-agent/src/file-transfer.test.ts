import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LeasedAttempt, OutputManifest } from "@astra/contracts";
import { downloadInputs, uploadOutput, verifyOutputs } from "./file-transfer.ts";

const directories: string[] = [];
const servers: Bun.Server<unknown>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "astra-worker-transfer-"));
  directories.push(created);
  return created;
}

describe("Worker Agent file transfer", () => {
  test("streams an input to its declared path and preserves exact bytes", async () => {
    const root = await directory();
    const bytes = new TextEncoder().encode("contract input bytes");
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    });
    servers.push(server);
    const inputPath = join(root, "attempt", "inputs", "reference.png");
    const outputDirectory = join(root, "attempt", "outputs");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const lease = {
      inference: {
        output_dir: outputDirectory,
        inputs: [
          {
            file_id: "file_input",
            path: inputPath,
            content_type: "image/png",
            size_bytes: bytes.byteLength,
            sha256,
          },
        ],
      },
      input_downloads: [
        { file_id: "file_input", url: `http://127.0.0.1:${server.port}/input`, headers: {}, expires_at: 1 },
      ],
    } as LeasedAttempt;
    await downloadInputs(lease, root);
    expect(new Uint8Array(await readFile(inputPath))).toEqual(bytes);
    await downloadInputs(lease, root);
    expect(new Uint8Array(await readFile(inputPath))).toEqual(bytes);
  });

  test("rejects a response MIME mismatch and removes partial files", async () => {
    const root = await directory();
    const bytes = new TextEncoder().encode("wrong media response");
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(bytes, { headers: { "content-type": "video/mp4" } }),
    });
    servers.push(server);
    const inputDirectory = join(root, "attempt", "inputs");
    const inputPath = join(inputDirectory, "reference.png");
    const lease = {
      inference: {
        output_dir: join(root, "attempt", "outputs"),
        inputs: [
          {
            file_id: "file_input",
            path: inputPath,
            content_type: "image/png",
            size_bytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      },
      input_downloads: [
        { file_id: "file_input", url: `http://127.0.0.1:${server.port}/input`, headers: {}, expires_at: 1 },
      ],
    } as LeasedAttempt;
    await expect(downloadInputs(lease, root)).rejects.toThrow("input_content_type_mismatch");
    expect(await Array.fromAsync(new Bun.Glob("*.part").scan({ cwd: inputDirectory }))).toEqual([]);
  });

  test("rejects output symlink escape before upload", async () => {
    const root = await directory();
    const outputDirectory = join(root, "attempt", "outputs");
    await mkdir(outputDirectory, { recursive: true });
    const outside = join(root, "outside.png");
    const bytes = new TextEncoder().encode("outside");
    await writeFile(outside, bytes);
    const outputPath = join(outputDirectory, "result.png");
    await symlink(outside, outputPath);
    const manifest = {
      execution_id: "execution_test",
      status: "completed",
      outputs: [
        {
          role: "result",
          path: outputPath,
          content_type: "image/png",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size_bytes: bytes.byteLength,
          media: { media_type: "image", container: "png_pipe", width: 1, height: 1 },
          provenance: { producer: "model_app", transformations: [] },
        },
      ],
      usage: {},
    } as OutputManifest;
    await expect(verifyOutputs(manifest, outputDirectory)).rejects.toThrow("output_path_invalid");
  });

  test("uploads the original file body and classifies transient storage errors", async () => {
    const root = await directory();
    const path = join(root, "result.bin");
    const bytes = new TextEncoder().encode("unaltered model output");
    await writeFile(path, bytes);
    let received = new Uint8Array();
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received = new Uint8Array(await request.arrayBuffer());
        return new Response(null, { status: 200 });
      },
    });
    servers.push(server);
    await uploadOutput(path, { url: `http://127.0.0.1:${server.port}/output`, headers: {} });
    expect(received).toEqual(bytes);
    const unavailable = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 503 }) });
    servers.push(unavailable);
    await expect(
      uploadOutput(path, { url: `http://127.0.0.1:${unavailable.port}/output`, headers: {} }),
    ).rejects.toEqual(expect.objectContaining({ code: "output_upload_failed", retryable: true }));
  });
});
