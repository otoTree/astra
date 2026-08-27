import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

export type ProviderSyncRequestClaim = Readonly<{
  id: string;
  provider: string;
  projectId: string;
  attemptCount: number;
}>;

export class ProviderSyncRequestRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claim(provider: string, owner: string, leaseSeconds: number): Promise<ProviderSyncRequestClaim | undefined> {
    if (!owner) throw new Error("provider_sync_owner_required");
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30) throw new Error("provider_sync_lease_invalid");
    const timestamp = this.now();
    const expiresAt = new Date(timestamp.getTime() + leaseSeconds * 1000);
    const rows = await this.sql.begin(async (transaction) => {
      await transaction`UPDATE provider_sync_requests SET status='failed', error_code='sync_attempts_exhausted',
          lease_owner=NULL, lease_expires_at=NULL, completed_at=${timestamp.toISOString()},
          updated_at=${timestamp.toISOString()}, version=version+1
        WHERE provider=${provider} AND status='running' AND lease_expires_at<=${timestamp.toISOString()}
          AND attempt_count>=3`;
      return transaction`WITH candidate AS (
          SELECT id FROM provider_sync_requests
          WHERE provider=${provider} AND attempt_count<3 AND (
            status='pending' OR (status='running' AND lease_expires_at<=${timestamp.toISOString()})
          )
          ORDER BY requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) UPDATE provider_sync_requests r SET
          status='running', attempt_count=r.attempt_count+1, lease_owner=${owner},
          lease_expires_at=${expiresAt.toISOString()}, started_at=COALESCE(r.started_at, ${timestamp.toISOString()}),
          updated_at=${timestamp.toISOString()}, version=r.version+1
        FROM candidate WHERE r.id=candidate.id
        RETURNING r.id, r.provider, r.project_id, r.attempt_count`;
    });
    const row = rows[0];
    return row
      ? {
          id: String(row.id),
          provider: String(row.provider),
          projectId: String(row.project_id),
          attemptCount: Number(row.attempt_count),
        }
      : undefined;
  }

  async latestPending(provider: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM provider_sync_requests
      WHERE provider=${provider} AND status IN ('pending', 'running') LIMIT 1`;
    return Boolean(rows[0]);
  }

  async release(claim: ProviderSyncRequestClaim, owner: string): Promise<void> {
    await this.sql`UPDATE provider_sync_requests SET status='pending', lease_owner=NULL, lease_expires_at=NULL,
        updated_at=${this.now().toISOString()}, version=version+1
      WHERE id=${claim.id} AND status='running' AND lease_owner=${owner}`;
  }

  async complete(
    claim: ProviderSyncRequestClaim,
    owner: string,
    result: Readonly<{ snapshotRunId: string; errorCode?: string }>,
  ): Promise<void> {
    const timestamp = this.now();
    const status = result.errorCode ? "failed" : "succeeded";
    const rows = await this.sql`UPDATE provider_sync_requests SET status=${status},
        snapshot_run_id=${result.snapshotRunId}, error_code=${result.errorCode ?? null},
        lease_owner=NULL, lease_expires_at=NULL, completed_at=${timestamp.toISOString()},
        updated_at=${timestamp.toISOString()}, version=version+1
      WHERE id=${claim.id} AND status='running' AND lease_owner=${owner}
      RETURNING id`;
    if (!rows[0]) throw new Error("provider_sync_claim_lost");
  }
}
