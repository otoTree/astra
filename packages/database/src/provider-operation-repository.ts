import { createHash } from "node:crypto";
import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

export type ProviderOperationType = "prewarm" | "provision" | "drain" | "terminate";
export type ProviderOperationPayload = Readonly<{
  image_digest?: string;
  image_reference?: string;
  region?: string;
  gpu_sku?: string;
  provider_resource_id?: string;
}>;

export type ProviderOperationClaim = Readonly<{
  id: string;
  projectId: string;
  provider: string;
  operationKey: string;
  operationType: ProviderOperationType;
  resourceType?: string;
  resourceId?: string;
  providerResourceId?: string;
  payload: ProviderOperationPayload;
  retryCount: number;
  maximumAttempts: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  reconciling: boolean;
}>;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
};

const requestHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

const validatePayload = (type: ProviderOperationType, payload: ProviderOperationPayload): void => {
  const imageOperation = type === "prewarm" || type === "provision";
  if (imageOperation) {
    if (!payload.image_digest?.startsWith("sha256:") || !payload.region || !payload.gpu_sku) {
      throw new Error("invalid_provider_image_operation_payload");
    }
  } else if (!payload.provider_resource_id) {
    throw new Error("invalid_provider_resource_operation_payload");
  }
};

export class ProviderOperationRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: (prefix: string) => string = (prefix) => `${prefix}_${Bun.randomUUIDv7()}`,
  ) {}

  async enqueue(
    input: Readonly<{
      projectId: string;
      provider: string;
      operationKey: string;
      operationType: ProviderOperationType;
      resourceType?: string;
      resourceId?: string;
      payload: ProviderOperationPayload;
      maximumAttempts: number;
    }>,
  ): Promise<Readonly<{ id: string; status: string; replayed: boolean }>> {
    validatePayload(input.operationType, input.payload);
    if (!/^[A-Za-z0-9._:-]{8,256}$/.test(input.operationKey)) throw new Error("invalid_provider_operation_key");
    if (!Number.isInteger(input.maximumAttempts) || input.maximumAttempts < 1 || input.maximumAttempts > 100) {
      throw new Error("invalid_provider_operation_maximum_attempts");
    }
    const hash = requestHash({
      provider: input.provider,
      operation_type: input.operationType,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      payload: input.payload,
    });
    const timestamp = this.now();
    return this.sql.begin(async (transaction) => {
      const existing = await transaction`SELECT id, request_hash, status FROM provider_operations
        WHERE operation_key=${input.operationKey} FOR UPDATE`;
      if (existing[0]) {
        if (String(existing[0].request_hash) !== hash) throw new Error("provider_operation_key_conflict");
        return { id: String(existing[0].id), status: String(existing[0].status), replayed: true };
      }
      const capacityAction = input.operationType === "prewarm" || input.operationType === "provision";
      const snapshot = capacityAction
        ? await transaction`SELECT expires_at FROM provider_snapshot_state
            WHERE provider=${input.provider} AND latest_published_run_id IS NOT NULL`
        : [];
      const usable =
        !capacityAction || (snapshot[0]?.expires_at && new Date(snapshot[0].expires_at as Date | string) > timestamp);
      const status = usable ? "pending" : "suppressed";
      const error = usable ? null : { code: "provider_snapshot_stale", retryable: true };
      const id = this.createId("provider_operation");
      await transaction`INSERT INTO provider_operations (
          id, project_id, provider, operation_key, operation_type, status, resource_type, resource_id,
          request_hash, retry_count, cost_minor, currency, error, desired_payload, next_attempt_at,
          maximum_attempts, version, created_at, updated_at
        ) VALUES (
          ${id}, ${input.projectId}, ${input.provider}, ${input.operationKey}, ${input.operationType}, ${status},
          ${input.resourceType ?? null}, ${input.resourceId ?? null}, ${hash}, 0, 0, 'CNY',
          ${error ? JSON.stringify(error) : null}, ${JSON.stringify(input.payload)}, ${timestamp.toISOString()},
          ${input.maximumAttempts}, 1, ${timestamp.toISOString()}, ${timestamp.toISOString()}
        )`;
      return { id, status, replayed: false };
    });
  }

  async reactivateSuppressed(provider: string, limit: number): Promise<number> {
    const timestamp = this.now();
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const rows = await this.sql`WITH candidates AS (
        SELECT po.id FROM provider_operations po JOIN provider_snapshot_state ps ON ps.provider=po.provider
        WHERE po.provider=${provider} AND po.status='suppressed' AND po.operation_type IN ('prewarm','provision')
          AND ps.latest_published_run_id IS NOT NULL AND ps.expires_at>${timestamp.toISOString()}
        ORDER BY po.created_at, po.id LIMIT ${boundedLimit} FOR UPDATE OF po SKIP LOCKED
      ) UPDATE provider_operations po SET status='pending', error=NULL, next_attempt_at=${timestamp.toISOString()},
        version=po.version+1, updated_at=${timestamp.toISOString()}
      FROM candidates c WHERE po.id=c.id RETURNING po.id`;
    return rows.length;
  }

  async claim(owner: string, provider: string, limit: number, leaseSeconds: number): Promise<ProviderOperationClaim[]> {
    if (!owner) throw new Error("provider_operation_owner_required");
    const timestamp = this.now();
    const expiresAt = new Date(timestamp.getTime() + leaseSeconds * 1000);
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const rows = await this.sql`WITH candidates AS (
        SELECT po.id FROM provider_operations po
        WHERE po.provider=${provider} AND po.next_attempt_at<=${timestamp.toISOString()}
          AND (
            po.status='pending' OR
            (po.status IN ('running','reconciling') AND po.lease_expires_at<=${timestamp.toISOString()})
          )
          AND (
            po.resource_type IS DISTINCT FROM 'replica' OR po.operation_type IN ('prewarm','provision') OR
            EXISTS (
              SELECT 1 FROM replicas r WHERE r.id=po.resource_id
                AND r.observed_state IN ('drained','terminated')
                AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.replica_id=r.id
                  AND a.status IN ('reserved','leased','running','unknown'))
            )
          )
        ORDER BY po.next_attempt_at, po.created_at, po.id
        LIMIT ${boundedLimit} FOR UPDATE SKIP LOCKED
      ) UPDATE provider_operations po SET
        status=CASE WHEN po.status='pending' THEN 'running' ELSE 'reconciling' END,
        lease_owner=${owner}, lease_expires_at=${expiresAt.toISOString()},
        version=po.version+1, updated_at=${timestamp.toISOString()}
      FROM candidates c WHERE po.id=c.id
      RETURNING po.*`;
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      provider: String(row.provider),
      operationKey: String(row.operation_key),
      operationType: String(row.operation_type) as ProviderOperationType,
      ...(row.resource_type ? { resourceType: String(row.resource_type) } : {}),
      ...(row.resource_id ? { resourceId: String(row.resource_id) } : {}),
      ...(row.provider_resource_id ? { providerResourceId: String(row.provider_resource_id) } : {}),
      payload: row.desired_payload as ProviderOperationPayload,
      retryCount: Number(row.retry_count),
      maximumAttempts: Number(row.maximum_attempts),
      leaseOwner: owner,
      leaseExpiresAt: expiresAt,
      reconciling: row.status === "reconciling",
    }));
  }

  async succeed(
    claim: ProviderOperationClaim,
    result: Readonly<{
      providerResourceId?: string;
      providerState?: string;
      response: Readonly<Record<string, string | number | boolean | null>>;
      costMinor?: number;
      currency?: string;
    }>,
  ): Promise<boolean> {
    const timestamp = this.now();
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`UPDATE provider_operations SET status='succeeded',
          provider_resource_id=${result.providerResourceId ?? claim.providerResourceId ?? null},
          provider_state=${result.providerState ?? null}, response_snapshot=${JSON.stringify(result.response)},
          cost_minor=${result.costMinor ?? 0}, currency=${result.currency ?? "CNY"}, error=NULL,
          lease_owner=NULL, lease_expires_at=NULL, completed_at=${timestamp.toISOString()},
          last_reconciled_at=${timestamp.toISOString()}, version=version+1, updated_at=${timestamp.toISOString()}
        WHERE id=${claim.id} AND lease_owner=${claim.leaseOwner}
          AND status IN ('running','reconciling') AND lease_expires_at>=${timestamp.toISOString()}
        RETURNING id`;
      if (!rows[0]) return false;
      if (claim.resourceType === "replica" && claim.resourceId) {
        const observed =
          claim.operationType === "terminate"
            ? "terminated"
            : claim.operationType === "drain"
              ? "draining"
              : result.providerState === "ready"
                ? "ready"
                : "provisioning";
        await transaction`UPDATE replicas SET
            provider_resource_id=COALESCE(${result.providerResourceId ?? null}, provider_resource_id),
            observed_state=${observed}, last_observed_at=${timestamp.toISOString()},
            version=version+1, updated_at=${timestamp.toISOString()}
          WHERE id=${claim.resourceId} AND provider=${claim.provider}`;
      }
      return true;
    });
  }

  async fail(
    claim: ProviderOperationClaim,
    error: Readonly<{ code: string; retryable: boolean; retryAfterSeconds?: number }>,
  ): Promise<"retrying" | "failed" | "stale_lease"> {
    const timestamp = this.now();
    const retryCount = claim.retryCount + 1;
    const canRetry = error.retryable && retryCount < claim.maximumAttempts;
    const delaySeconds = error.retryAfterSeconds ?? Math.min(300, 2 ** Math.min(retryCount, 8));
    const nextAttemptAt = new Date(timestamp.getTime() + delaySeconds * 1000);
    const rows = await this.sql`UPDATE provider_operations SET
        status=${canRetry ? "pending" : "failed"}, retry_count=${retryCount},
        error=${JSON.stringify({ code: error.code, retryable: error.retryable })},
        lease_owner=NULL, lease_expires_at=NULL, next_attempt_at=${nextAttemptAt.toISOString()},
        completed_at=${canRetry ? null : timestamp.toISOString()}, version=version+1, updated_at=${timestamp.toISOString()}
      WHERE id=${claim.id} AND lease_owner=${claim.leaseOwner}
        AND status IN ('running','reconciling') AND lease_expires_at>=${timestamp.toISOString()}
      RETURNING id`;
    if (!rows[0]) return "stale_lease";
    return canRetry ? "retrying" : "failed";
  }

  async backlog(provider: string): Promise<readonly Record<string, unknown>[]> {
    return this.sql`SELECT status, operation_type, count(*)::int AS count,
        COALESCE(EXTRACT(EPOCH FROM (${this.now().toISOString()}::timestamptz-min(created_at))),0)::bigint AS oldest_age_seconds
      FROM provider_operations WHERE provider=${provider} AND status<>'succeeded'
      GROUP BY status, operation_type ORDER BY status, operation_type`;
  }
}
