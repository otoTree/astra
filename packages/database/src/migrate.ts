import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for migrations");

const migrationsDirectory = resolve(import.meta.dir, "../drizzle");
const sql = postgres(databaseUrl, { prepare: false, max: 1 });

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
await sql`SELECT pg_advisory_lock(hashtext('astra-schema-migrations'))`;
try {
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const source = await Bun.file(resolve(migrationsDirectory, name)).text();
    const checksum = createHash("sha256").update(source).digest("hex");
    const existing = await sql`SELECT sha256 FROM schema_migrations WHERE name=${name}`;
    if (existing[0]) {
      if (existing[0].sha256 !== checksum) throw new Error(`migration_checksum_mismatch:${name}`);
      continue;
    }
    await sql.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`INSERT INTO schema_migrations (name, sha256) VALUES (${name}, ${checksum})`;
    });
    console.log(JSON.stringify({ event: "migration_applied", name, checksum }));
  }
} finally {
  await sql`SELECT pg_advisory_unlock(hashtext('astra-schema-migrations'))`;
  await sql.end();
}
