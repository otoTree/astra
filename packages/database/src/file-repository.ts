import type postgres from "postgres";
import { fileStatusSchema, mediaMetadataSchema, type FileUploadRequest, type MediaMetadata } from "@astra/contracts";

type SqlClient = ReturnType<typeof postgres>;
export type FileRecord = Readonly<{
  id: string;
  projectId: string;
  filename: string;
  purpose: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  status: "pending_upload" | "validating" | "available" | "rejected" | "expiring" | "expired";
  media: MediaMetadata | null;
  createdAt: Date | string;
  expiresAt: Date | string;
}>;

export type FileAdmissionContext = Readonly<{
  organizationId: string;
  projectId: string;
  apiKeyId: string;
}>;

const record = (row: Record<string, unknown>): FileRecord => ({
  id: String(row.id),
  projectId: String(row.project_id),
  filename: String(row.filename),
  purpose: String(row.purpose),
  contentType: String(row.content_type),
  sizeBytes: Number(row.size_bytes),
  sha256: String(row.sha256),
  objectKey: String(row.object_key),
  status: fileStatusSchema.parse(row.status),
  media: row.media === null || row.media === undefined ? null : mediaMetadataSchema.parse(row.media),
  createdAt: row.created_at as Date | string,
  expiresAt: row.expires_at as Date | string,
});

export class FileRepository {
  constructor(private readonly sql: SqlClient) {}

  async createPending(projectId: string, input: FileUploadRequest, clock = new Date()): Promise<FileRecord> {
    const fileId = `file_${Bun.randomUUIDv7()}`;
    const objectKey = `inputs/${projectId}/${clock.toISOString().slice(0, 10).replaceAll("-", "/")}/${fileId}`;
    const expiresAt = new Date(clock.getTime() + 15 * 60 * 1000);
    const rows = await this
      .sql`INSERT INTO files (id, project_id, filename, purpose, content_type, size_bytes, sha256, object_key, status, created_at, updated_at, expires_at)
      VALUES (${fileId}, ${projectId}, ${input.filename}, ${input.purpose}, ${input.content_type}, ${input.size_bytes}, ${input.sha256}, ${objectKey}, 'pending_upload', ${clock.toISOString()}, ${clock.toISOString()}, ${expiresAt.toISOString()}) RETURNING *`;
    return record(rows[0] as Record<string, unknown>);
  }

  async createPendingAuthorized(
    context: FileAdmissionContext,
    input: FileUploadRequest,
    clock = new Date(),
  ): Promise<FileRecord> {
    return this.sql.begin(async (transaction) => {
      const quotas = await transaction`SELECT q.* FROM project_quotas q
        JOIN projects p ON p.id=q.project_id
        JOIN organizations o ON o.id=p.organization_id
        JOIN api_keys k ON k.id=${context.apiKeyId} AND k.organization_id=p.organization_id
        JOIN api_key_project_grants g ON g.api_key_id=k.id AND g.project_id=p.id
        WHERE q.project_id=${context.projectId} AND p.organization_id=${context.organizationId}
          AND p.status='active' AND o.status='active' AND k.status='active'
          AND (k.expires_at IS NULL OR k.expires_at > ${clock.toISOString()})
        FOR UPDATE OF q`;
      const quota = quotas[0] as Record<string, unknown> | undefined;
      if (!quota) throw new Error("project_access_denied");
      if (input.size_bytes > Number(quota.max_file_size_bytes)) throw new Error("file_too_large");
      const dayStart = new Date(clock);
      dayStart.setUTCHours(0, 0, 0, 0);
      const totals = await transaction`SELECT
        COALESCE((SELECT sum(quantity) FROM usage_ledger
          WHERE project_id=${context.projectId} AND metric='upload_bytes' AND occurred_at >= ${dayStart.toISOString()}), 0)::bigint AS uploaded_bytes,
        COALESCE((SELECT sum(ar.reserved_bytes) FROM admission_reservations ar
          JOIN files f ON f.id=ar.resource_id
          WHERE ar.project_id=${context.projectId} AND ar.resource_type='file_upload' AND ar.status='held'
            AND f.status IN ('pending_upload', 'validating') AND ar.created_at >= ${dayStart.toISOString()}), 0)::bigint AS pending_upload_bytes,
        COALESCE((SELECT sum(ar.reserved_bytes) FROM admission_reservations ar
          WHERE ar.project_id=${context.projectId} AND ar.resource_type='file_upload' AND ar.status='held'), 0)::bigint AS active_file_bytes`;
      const total = totals[0] as Record<string, unknown>;
      if (
        Number(total.uploaded_bytes) + Number(total.pending_upload_bytes) + input.size_bytes >
        Number(quota.daily_upload_bytes_limit)
      ) {
        throw new Error("daily_upload_quota_exceeded");
      }
      if (Number(total.active_file_bytes) + input.size_bytes > Number(quota.active_file_bytes_limit)) {
        throw new Error("active_file_storage_quota_exceeded");
      }
      const fileId = `file_${Bun.randomUUIDv7()}`;
      const objectKey = `inputs/${context.projectId}/${clock.toISOString().slice(0, 10).replaceAll("-", "/")}/${fileId}`;
      const expiresAt = new Date(clock.getTime() + 15 * 60 * 1000);
      const rows = await transaction`INSERT INTO files (
        id, project_id, filename, purpose, content_type, size_bytes, sha256,
        object_key, status, created_at, updated_at, expires_at
      ) VALUES (
        ${fileId}, ${context.projectId}, ${input.filename}, ${input.purpose}, ${input.content_type},
        ${input.size_bytes}, ${input.sha256}, ${objectKey}, 'pending_upload', ${clock.toISOString()},
        ${clock.toISOString()}, ${expiresAt.toISOString()}
      ) RETURNING *`;
      await transaction`INSERT INTO admission_reservations (
        id, project_id, api_key_id, resource_type, resource_id, status,
        estimated_gpu_seconds, estimated_cost_minor, reserved_bytes, created_at
      ) VALUES (
        ${`reservation_${Bun.randomUUIDv7()}`}, ${context.projectId}, ${context.apiKeyId},
        'file_upload', ${fileId}, 'held', 0, 0, ${input.size_bytes}, ${clock.toISOString()}
      )`;
      return record(rows[0] as Record<string, unknown>);
    });
  }

  async get(projectId: string, fileId: string): Promise<FileRecord | undefined> {
    const rows = await this.sql`SELECT * FROM files WHERE id=${fileId} AND project_id=${projectId}`;
    return rows[0] ? record(rows[0] as Record<string, unknown>) : undefined;
  }

  async abortPending(projectId: string, fileId: string, clock = new Date()): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE files SET status='rejected', updated_at=${clock.toISOString()}
        WHERE id=${fileId} AND project_id=${projectId} AND status='pending_upload'`;
      await transaction`UPDATE admission_reservations
        SET status='released', release_reason='upload_reservation_failed', released_at=${clock.toISOString()}
        WHERE project_id=${projectId} AND resource_type='file_upload' AND resource_id=${fileId} AND status='held'`;
    });
  }

  async markValidating(projectId: string, fileId: string, clock: Date): Promise<FileRecord | undefined> {
    const rows = await this.sql`UPDATE files SET status='validating', updated_at=${clock.toISOString()}
      WHERE id=${fileId} AND project_id=${projectId} AND status IN ('pending_upload', 'validating') RETURNING *`;
    return rows[0] ? record(rows[0] as Record<string, unknown>) : undefined;
  }

  async markAvailable(
    projectId: string,
    fileId: string,
    media: MediaMetadata,
    clock: Date,
  ): Promise<FileRecord | undefined> {
    return this.sql.begin(async (transaction) => {
      const expiresAt = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
      const rows = await transaction`UPDATE files
        SET status='available', media=${JSON.stringify(media)}, updated_at=${clock.toISOString()}, expires_at=${expiresAt.toISOString()}
        WHERE id=${fileId} AND project_id=${projectId} AND status IN ('validating', 'available') RETURNING *`;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const reservations = await transaction`SELECT ar.id, p.organization_id FROM admission_reservations ar
        JOIN projects p ON p.id=ar.project_id
        WHERE ar.project_id=${projectId} AND ar.resource_type='file_upload' AND ar.resource_id=${fileId}
        FOR UPDATE OF ar`;
      const reservation = reservations[0] as Record<string, unknown> | undefined;
      if (reservation) {
        await transaction`INSERT INTO usage_ledger (
          id, organization_id, project_id, reservation_id, source_type, source_id,
          metric, quantity, occurred_at, created_at
        ) VALUES (
          ${`usage_${Bun.randomUUIDv7()}`}, ${String(reservation.organization_id)}, ${projectId},
          ${String(reservation.id)}, 'file_upload', ${fileId}, 'upload_bytes', ${Number(row.size_bytes)},
          ${clock.toISOString()}, ${clock.toISOString()}
        ) ON CONFLICT (source_type, source_id, metric) DO NOTHING`;
      }
      return record(row);
    });
  }

  async markRejected(projectId: string, fileId: string, clock = new Date()): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE files SET status='rejected', updated_at=${clock.toISOString()}
        WHERE id=${fileId} AND project_id=${projectId} AND status IN ('pending_upload', 'validating')`;
      await transaction`UPDATE admission_reservations
        SET status='released', release_reason='upload_rejected', released_at=${clock.toISOString()}
        WHERE project_id=${projectId} AND resource_type='file_upload' AND resource_id=${fileId} AND status='held'`;
    });
  }
}
