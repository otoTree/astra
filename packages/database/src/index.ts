import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export * from "./task-service.ts";
export * from "./file-repository.ts";
export * from "./asset-expiration.ts";
export * from "./identity-repository.ts";
export * from "./admin-query-service.ts";

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { prepare: false });
  return { client, db: drizzle(client, { schema }) };
}

export class DatabaseHealth {
  constructor(private readonly client: ReturnType<typeof postgres>) {}

  async ready(): Promise<boolean> {
    try {
      const rows = await this.client`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS migrated`;
      return rows[0]?.migrated === true;
    } catch {
      return false;
    }
  }
}
