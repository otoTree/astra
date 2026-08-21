import type postgres from "postgres";
import type { FileUploadRequest } from "@astra/contracts";

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
  status: string;
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
  status: String(row.status),
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
      .sql`INSERT INTO files (id, project_id, filename, purpose, content_type, size_bytes, sha256, object_key, status, created_at, expires_at)
      VALUES (${fileId}, ${projectId}, ${input.filename}, ${input.purpose}, ${input.content_type}, ${input.size_bytes}, ${input.sha256}, ${objectKey}, 'pending_upload', ${clock.toISOString()}, ${expiresAt.toISOString()}) RETURNING *`;
    return record(rows[0] as Record<string, unknown>);
  }

  async get(projectId: string, fileId: string): Promise<FileRecord | undefined> {
    const rows = await this.sql`SELECT * FROM files WHERE id=${fileId} AND project_id=${projectId}`;
    return rows[0] ? record(rows[0] as Record<string, unknown>) : undefined;
  }

  async markAvailable(projectId: string, fileId: string, clock = new Date()): Promise<FileRecord | undefined> {
    const expiresAt = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    const rows = await this
      .sql`UPDATE files SET status='available', expires_at=${expiresAt.toISOString()} WHERE id=${fileId} AND project_id=${projectId} AND status IN ('pending_upload', 'available') RETURNING *`;
    return rows[0] ? record(rows[0] as Record<string, unknown>) : undefined;
  }

  async markRejected(projectId: string, fileId: string): Promise<void> {
    await this
      .sql`UPDATE files SET status='rejected' WHERE id=${fileId} AND project_id=${projectId} AND status='pending_upload'`;
  }
}
