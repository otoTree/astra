import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export * from "./task-service.ts";
export * from "./file-repository.ts";
export * from "./asset-expiration.ts";
export * from "./identity-repository.ts";
export * from "./admin-query-service.ts";
export * from "./admin-management-service.ts";
export * from "./event-repository.ts";
export * from "./scheduling-repository.ts";
export * from "./request-cipher.ts";
export * from "./worker-control-repository.ts";
export * from "./provider-snapshot-repository.ts";
export * from "./provider-operation-repository.ts";
export * from "./retry-policy.ts";
export * from "./capacity-plan-repository.ts";
export * from "./provider-credential-repository.ts";
export * from "./provider-sync-request-repository.ts";

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
