import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

export type ExpiringAsset = Readonly<{ id: string; objectKey: string }>;
export type AssetExpirationOptions = Readonly<{
  now?: () => Date;
  createId?: (prefix: string) => string;
  reclaimAfterMilliseconds?: number;
  validatingReclaimAfterMilliseconds?: number;
}>;

export class AssetExpirationRepository {
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private readonly reclaimAfterMilliseconds: number;
  private readonly validatingReclaimAfterMilliseconds: number;

  constructor(
    private readonly sql: SqlClient,
    options: AssetExpirationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${Bun.randomUUIDv7()}`);
    this.reclaimAfterMilliseconds = options.reclaimAfterMilliseconds ?? 5 * 60 * 1000;
    this.validatingReclaimAfterMilliseconds = options.validatingReclaimAfterMilliseconds ?? 15 * 60 * 1000;
  }

  async claim(limit: number): Promise<ExpiringAsset[]> {
    const timestamp = this.now();
    const reclaimBefore = new Date(timestamp.getTime() - this.reclaimAfterMilliseconds);
    const validatingBefore = new Date(timestamp.getTime() - this.validatingReclaimAfterMilliseconds);
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`SELECT f.id, f.object_key FROM files f
        WHERE (
          (f.status IN ('pending_upload', 'available') AND f.expires_at <= ${timestamp.toISOString()})
          OR (f.status='validating' AND f.expires_at <= ${timestamp.toISOString()} AND f.updated_at <= ${validatingBefore.toISOString()})
          OR (f.status='expiring' AND f.updated_at <= ${reclaimBefore.toISOString()})
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_files tf
          JOIN attempts a ON a.task_id=tf.task_id
          JOIN leases l ON l.attempt_id=a.id
          WHERE tf.file_id=f.id AND tf.direction='input' AND l.expires_at > ${timestamp.toISOString()}
        )
        ORDER BY expires_at ASC, id ASC
        FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      if (rows.length === 0) return [];
      const ids = rows.map((row) => String(row.id));
      await transaction`UPDATE files SET status='expiring', updated_at=${timestamp.toISOString()}
        WHERE id=ANY(${this.sql.array(ids)}::text[])`;
      return rows.map((row) => ({ id: String(row.id), objectKey: String(row.object_key) }));
    });
  }

  async complete(fileId: string): Promise<void> {
    const timestamp = this.now();
    await this.sql.begin(async (transaction) => {
      const files = await transaction`SELECT id FROM files WHERE id=${fileId} AND status='expiring' FOR UPDATE`;
      if (!files[0]) return;
      await transaction`UPDATE files SET status='expired', updated_at=${timestamp.toISOString()} WHERE id=${fileId}`;
      await transaction`UPDATE admission_reservations
        SET status='released', release_reason='file_expired', released_at=${timestamp.toISOString()}
        WHERE resource_type='file_upload' AND resource_id=${fileId} AND status='held'`;
      const tasks = await transaction`SELECT t.id, t.status, t.version
        FROM tasks t
        WHERE t.status IN ('queued', 'scheduling', 'provisioning')
          AND EXISTS (
            SELECT 1 FROM task_files tf
            WHERE tf.task_id=t.id AND tf.file_id=${fileId} AND tf.direction='input'
          )
        FOR UPDATE`;
      for (const task of tasks) {
        const taskId = String(task.id);
        const fromStatus = String(task.status);
        const version = Number(task.version) + 1;
        const error = {
          code: "input_asset_expired",
          message: "Input asset expired before execution",
          retryable: false,
        };
        const changed =
          await transaction`UPDATE tasks SET status='failed', error=${JSON.stringify(error)}, version=${version}, updated_at=${timestamp.toISOString()}, completed_at=${timestamp.toISOString()}
          WHERE id=${taskId} AND version=${Number(task.version)} RETURNING id`;
        if (!changed[0]) throw new Error("task_expiration_cas_conflict");
        await transaction`INSERT INTO task_state_events (id, task_id, from_status, to_status, reason, version, created_at)
          VALUES (${this.createId("evt")}, ${taskId}, ${fromStatus}, 'failed', 'input_asset_expired', ${version}, ${timestamp.toISOString()})`;
        await transaction`INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at)
          VALUES (${this.createId("evt")}, 'generation_task', ${taskId}, 'task.failed', ${JSON.stringify({ task_id: taskId, error_code: "input_asset_expired" })}, ${timestamp.toISOString()})`;
        await transaction`UPDATE admission_reservations
          SET status='released', release_reason='input_asset_expired', released_at=${timestamp.toISOString()}
          WHERE resource_type='task' AND resource_id=${taskId} AND status='held'`;
      }
    });
  }
}
