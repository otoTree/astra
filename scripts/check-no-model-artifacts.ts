import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const forbiddenExtensions = new Set([".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".onnx"]);
// Generated work/data directories are intentionally scanned: a local model download must fail the same gate as a committed file.
const ignoredDirectories = new Set([".git", "node_modules", "coverage"]);
const violations: string[] = [];

async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
    if (forbiddenExtensions.has(extension)) violations.push(relative(".", path));
  }
}

await walk(".");
if (violations.length > 0) {
  throw new Error(`model_artifact_present\n${violations.join("\n")}`);
}

console.log(JSON.stringify({ forbidden_extensions: [...forbiddenExtensions], status: "clear" }));
