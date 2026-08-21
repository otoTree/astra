import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const roots = ["apps", "packages", "model-workers/reference"];
const sourceFiles: string[] = [];

async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) sourceFiles.push(path);
  }
}
for (const root of roots) await walk(root);

const violations: string[] = [];
for (const file of sourceFiles) {
  const source = await Bun.file(file).text();
  const imports = [...source.matchAll(/(?:from\s+|import\s*\()?["']([^"']+)["']/g)].map((match) => match[1]);
  for (const specifier of imports) {
    if (!specifier) continue;
    if (specifier.startsWith("@astra/") && specifier.split("/").length > 2) {
      violations.push(`${relative(".", file)}: deep package import ${specifier}`);
    }
    if (file.startsWith("packages/contracts/") && specifier.startsWith("@astra/")) {
      violations.push(`${relative(".", file)}: contracts must not depend on ${specifier}`);
    }
    if (file.startsWith("packages/database/") && specifier.startsWith("@astra/") && specifier !== "@astra/contracts") {
      violations.push(`${relative(".", file)}: database must not depend on ${specifier}`);
    }
    if (file.startsWith("packages/provider-core/") && specifier.includes("gongji")) {
      violations.push(`${relative(".", file)}: provider-core must not depend on Gongji transport`);
    }
    if (file.startsWith("packages/queue/") && specifier === "@astra/database") {
      violations.push(`${relative(".", file)}: queue must not own database state transitions`);
    }
  }
}

if (violations.length > 0) throw new Error(`dependency_boundary_violation\n${violations.join("\n")}`);
console.log(JSON.stringify({ checked_files: sourceFiles.length, status: "ok" }));
