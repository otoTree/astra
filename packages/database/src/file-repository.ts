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

  async get(projectId: string, fileId: string): Promise<FileRecord | undefined> {
    const rows = await this.sql`SELECT * FROM files WHERE id=${fileId} AND project_id=${projectId}`;
    return rows[0] ? record(rows[0] as Record<string, unknown>) : undefined;
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
    const expiresAt = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    const rows = await this
      .sql`UPDATE files SET status='available', media=${JSON.stringify(media)}, updated_at=${clock.toISOString()}, expires_at=${expiresAt.toISOString()}
      WHERE id=${fileId} AND project_id=${projectId} AND status IN ('validating', 'available') RETURNING *`;
    return rows[0] ? record(rows[0] as Record<string, unknown>) : undefined;
  }

  async markRejected(projectId: string, fileId: string, clock = new Date()): Promise<void> {
    await this.sql`UPDATE files SET status='rejected', updated_at=${clock.toISOString()}
      WHERE id=${fileId} AND project_id=${projectId} AND status IN ('pending_upload', 'validating')`;
  }
}
