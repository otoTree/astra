import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(import.meta.dir, "../packages/database/drizzle");
const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
if (files.length === 0) throw new Error("migration_set_empty");

const names = new Set<string>();
for (const name of files) {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) throw new Error(`invalid_migration_name:${name}`);
  if (names.has(name)) throw new Error(`duplicate_migration_name:${name}`);
  names.add(name);
  const source = await Bun.file(resolve(directory, name)).text();
  if (source.trim().length === 0) throw new Error(`empty_migration:${name}`);
  console.log(JSON.stringify({ migration: name, sha256: createHash("sha256").update(source).digest("hex") }));
}
