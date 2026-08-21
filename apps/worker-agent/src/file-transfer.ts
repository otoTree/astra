import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { LeasedAttempt, OutputManifest } from "@astra/contracts";

export class FileTransferError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

const within = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

async function ensureDirectory(root: string, directory: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const resolvedDirectory = resolve(directory);
  if (!within(resolvedRoot, resolvedDirectory)) throw new Error("worker_path_escape");
  await mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
  const [actualRoot, actualDirectory] = await Promise.all([realpath(resolvedRoot), realpath(resolvedDirectory)]);
  if (!within(actualRoot, actualDirectory)) throw new Error("worker_path_escape");
  return actualDirectory;
}

async function existingMatches(path: string, sizeBytes: number, sha256: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== sizeBytes) return false;
    return (await fileHash(path)) === sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  const reader = Bun.file(path).stream().getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      digest.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return digest.digest("hex");
}

export async function downloadInputs(lease: LeasedAttempt, workRoot: string): Promise<void> {
  const declared = new Map(lease.inference.inputs.map((input) => [input.file_id, input]));
  if (declared.size !== lease.input_downloads.length) throw new Error("input_download_set_mismatch");
  await ensureDirectory(workRoot, dirname(lease.inference.output_dir));
  for (const download of lease.input_downloads) {
    const input = declared.get(download.file_id);
    if (!input) throw new Error("input_download_set_mismatch");
    const requestedDirectory = resolve(dirname(input.path));
    const requestedTarget = resolve(input.path);
    if (dirname(requestedTarget) !== requestedDirectory) throw new Error("worker_path_escape");
    const directory = await ensureDirectory(workRoot, requestedDirectory);
    const target = resolve(directory, basename(requestedTarget));
    if (await existingMatches(target, input.size_bytes, input.sha256)) continue;
    const temporary = `${target}.${Bun.randomUUIDv7()}.part`;
    const file = await open(temporary, "wx", 0o600);
    const digest = createHash("sha256");
    let written = 0;
    let completed = false;
    try {
      const response = await fetch(download.url, {
        headers: download.headers,
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      if (!response.ok || !response.body) {
        throw new FileTransferError("input_download_failed", response.status === 429 || response.status >= 500);
      }
      const responseContentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (responseContentType && responseContentType !== input.content_type)
        throw new Error("input_content_type_mismatch");
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          written += chunk.value.byteLength;
          if (written > input.size_bytes) throw new Error("input_size_mismatch");
          digest.update(chunk.value);
          await file.write(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      await file.sync();
      completed = true;
    } finally {
      await file.close();
      if (!completed)
        await Bun.file(temporary)
          .delete()
          .catch(() => undefined);
    }
    if (written !== input.size_bytes || digest.digest("hex") !== input.sha256) {
      await Bun.file(temporary).delete();
      throw new Error("input_integrity_mismatch");
    }
    await rename(temporary, target);
  }
  await ensureDirectory(workRoot, lease.inference.output_dir);
}

export async function verifyOutputs(
  manifest: OutputManifest,
  outputDirectory: string,
): Promise<readonly { index: number; path: string; sha256: string; sizeBytes: number }[]> {
  const requestedDirectory = resolve(outputDirectory);
  const actualDirectory = await realpath(requestedDirectory);
  const verified = [];
  for (const [index, output] of manifest.outputs.entries()) {
    const expected = resolve(output.path);
    if (!within(requestedDirectory, expected)) throw new Error("output_path_escape");
    const info = await lstat(expected);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("output_path_invalid");
    const actualPath = await realpath(expected);
    if (!within(actualDirectory, actualPath)) throw new Error("output_path_escape");
    const sha256 = await fileHash(actualPath);
    if (info.size !== output.size_bytes || sha256 !== output.sha256) throw new Error("output_integrity_mismatch");
    verified.push({ index, path: actualPath, sha256, sizeBytes: info.size });
  }
  return verified;
}

export async function uploadOutput(
  path: string,
  upload: Readonly<{ url: string; headers: Record<string, string> }>,
): Promise<void> {
  const response = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Bun.file(path) });
  if (!response.ok) {
    throw new FileTransferError("output_upload_failed", response.status === 429 || response.status >= 500);
  }
}
