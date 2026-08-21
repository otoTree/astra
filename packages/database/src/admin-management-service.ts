import { createHash, createHmac } from "node:crypto";
import type postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;
type TransactionClient = postgres.TransactionSql;
type Sql = SqlClient | TransactionClient;

export type ManagementActor = Readonly<{
  actorId: string;
  sessionId: string;
  organizationId: string;
  projectId: string;
}>;

export type ManagementRequest = Readonly<{
  requestId: string;
  sourceIp?: string;
  userAgent?: string;
  traceId?: string;
}>;

export type ResolvedOciImage = Readonly<{
  sourceImage: string;
  digest: string;
  mediaType: string;
  configDigest: string;
  manifestSizeBytes: number;
}>;

export interface OciImageResolver {
  resolve(sourceImage: string): Promise<ResolvedOciImage>;
}

export class AdminManagementError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly retryable = false,
  ) {
    super(code);
  }
}

type MutationResult = Readonly<{ status: number; body: Record<string, unknown> }>;

type RolloutStrategy = Readonly<{
  max_surge: number;
  max_unavailable: number;
  batch_size: number;
  readiness_timeout_seconds: number;
  readiness_stability_seconds: number;
  progress_deadline_seconds: number;
  pause_on_failure: boolean;
  maximum_failure_rate_basis_points: number;
  maximum_duration_regression_basis_points: number;
  maximum_extra_cost_minor: number;
  currency: string;
  rollback_retention_seconds: number;
}>;

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const id = (prefix: string): string => `${prefix}_${Bun.randomUUIDv7()}`;
const unix = (value: Date | string): number => Math.floor(new Date(value).getTime() / 1000);

export class AdminManagementService {
  private readonly auditKey: Buffer;

  constructor(
    private readonly sql: SqlClient,
    private readonly imageResolver: OciImageResolver,
    auditSigningKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.auditKey = createHash("sha256").update(`astra-admin-audit-v1:${auditSigningKey}`).digest();
  }

  private async audit(
    sql: Sql,
    actor: ManagementActor,
    request: ManagementRequest,
    action: string,
    resourceType: string,
    resourceId: string,
    reason: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const eventId = id("audit");
    const createdAt = this.now();
    const payload = JSON.stringify({
      id: eventId,
      actor_type: "oidc_user",
      actor_id: actor.actorId,
      api_key_id: null,
      organization_id: actor.organizationId,
      project_id: actor.projectId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      outcome: "success",
      reason_code: null,
      source_ip: request.sourceIp ?? null,
      user_agent: request.userAgent ?? null,
      request_id: request.requestId,
      trace_id: request.traceId ?? null,
      purpose: null,
      details: { ...details, reason },
      created_at: createdAt.toISOString(),
    });
    const signature = createHmac("sha256", this.auditKey).update(payload).digest("base64url");
    await sql`INSERT INTO audit_events (
      id, actor_type, actor_id, organization_id, project_id, action, resource_type,
      resource_id, outcome, request_id, source_ip, user_agent, trace_id, details, signature, created_at
    ) VALUES (
      ${eventId}, 'oidc_user', ${actor.actorId}, ${actor.organizationId}, ${actor.projectId}, ${action},
      ${resourceType}, ${resourceId}, 'success', ${request.requestId}, ${request.sourceIp ?? null},
      ${request.userAgent ?? null}, ${request.traceId ?? null}, ${JSON.stringify({ ...details, reason })},
      ${signature}, ${createdAt.toISOString()}
    )`;
  }

  private async mutate(
    actor: ManagementActor,
    endpoint: string,
    idempotencyKey: string,
    input: unknown,
    operation: (transaction: TransactionClient) => Promise<MutationResult>,
  ): Promise<MutationResult & { replayed: boolean }> {
    const requestHash = hash(input);
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.projectId}:${endpoint}:${idempotencyKey}`}, 0))`;
      const existing = await transaction`SELECT request_hash, response_status, response_body
        FROM admin_idempotency_records
        WHERE project_id=${actor.projectId} AND endpoint=${endpoint} AND idempotency_key=${idempotencyKey}
        FOR UPDATE`;
      if (existing[0]) {
        if (String(existing[0].request_hash) !== requestHash) {
          throw new AdminManagementError("idempotency_conflict", 409);
        }
        return {
          status: Number(existing[0].response_status),
          body: existing[0].response_body as Record<string, unknown>,
          replayed: true,
        };
      }
      const result = await operation(transaction);
      const resourceId = String(result.body.id ?? result.body.resource_id ?? "unknown");
      await transaction`INSERT INTO admin_idempotency_records (
        id, project_id, session_id, endpoint, idempotency_key, request_hash,
        resource_type, resource_id, response_status, response_body, created_at
      ) VALUES (
        ${id("adminidem")}, ${actor.projectId}, ${actor.sessionId}, ${endpoint}, ${idempotencyKey},
        ${requestHash}, ${endpoint.split("/")[1] ?? "management"}, ${resourceId}, ${result.status},
        ${JSON.stringify(result.body)}, ${this.now().toISOString()}
      )`;
      return { ...result, replayed: false };
    });
  }

  private async existingMutation(
    actor: ManagementActor,
    endpoint: string,
    idempotencyKey: string,
    input: unknown,
  ): Promise<(MutationResult & { replayed: true }) | undefined> {
    const rows = await this.sql`SELECT request_hash, response_status, response_body
      FROM admin_idempotency_records
      WHERE project_id=${actor.projectId} AND endpoint=${endpoint} AND idempotency_key=${idempotencyKey}`;
    if (!rows[0]) return undefined;
    if (String(rows[0].request_hash) !== hash(input)) throw new AdminManagementError("idempotency_conflict", 409);
    return {
      status: Number(rows[0].response_status),
      body: rows[0].response_body as Record<string, unknown>,
      replayed: true,
    };
  }

  async createModel(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    input: Readonly<{ alias: string; modality: "video" | "image"; description: string; reason: string }>,
  ) {
    return this.mutate(actor, "models:create", idempotencyKey, input, async (transaction) => {
      const modelId = id("model");
      const createdAt = this.now();
      try {
        await transaction`INSERT INTO models (
          id, project_id, alias, modality, description, status, version, created_at, updated_at
        ) VALUES (
          ${modelId}, ${actor.projectId}, ${input.alias}, ${input.modality}, ${input.description},
          'active', 1, ${createdAt.toISOString()}, ${createdAt.toISOString()}
        )`;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "23505") {
          throw new AdminManagementError("model_alias_conflict", 409);
        }
        throw error;
      }
      await this.audit(transaction, actor, request, "model.create", "model", modelId, input.reason);
      return {
        status: 201,
        body: {
          id: modelId,
          object: "model",
          alias: input.alias,
          modality: input.modality,
          description: input.description,
          status: "active",
          version: 1,
          created_at: unix(createdAt),
          updated_at: unix(createdAt),
        },
      };
    });
  }

  async updateModel(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    modelId: string,
    input: Readonly<{ expected_version: number; status: string; description: string; reason: string }>,
  ) {
    return this.mutate(actor, `models:update:${modelId}`, idempotencyKey, input, async (transaction) => {
      const updatedAt = this.now();
      const rows = await transaction`UPDATE models SET
        status=${input.status}, description=${input.description}, version=version+1, updated_at=${updatedAt.toISOString()}
        WHERE id=${modelId} AND project_id=${actor.projectId} AND version=${input.expected_version}
        RETURNING *`;
      if (!rows[0]) {
        const found =
          await transaction`SELECT version FROM models WHERE id=${modelId} AND project_id=${actor.projectId}`;
        throw new AdminManagementError(found[0] ? "version_conflict" : "model_not_found", found[0] ? 409 : 404);
      }
      await this.audit(transaction, actor, request, "model.update", "model", modelId, input.reason, {
        previous_version: input.expected_version,
      });
      return {
        status: 200,
        body: { ...rows[0], created_at: unix(rows[0].created_at as string), updated_at: unix(updatedAt) },
      };
    });
  }

  async createRelease(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    input: Readonly<{
      model_id: string;
      source_image: string;
      workflow_hash: string;
      maturity: string;
      manifest: Record<string, unknown>;
      reason: string;
    }>,
  ) {
    const existing = await this.existingMutation(actor, "releases:create", idempotencyKey, input);
    if (existing) return existing;
    const resolved = await this.imageResolver.resolve(input.source_image);
    return this.mutate(actor, "releases:create", idempotencyKey, input, async (transaction) => {
      const models = await transaction`SELECT id, alias, modality FROM models
        WHERE id=${input.model_id} AND project_id=${actor.projectId} AND status='active' FOR SHARE`;
      const model = models[0];
      if (!model) throw new AdminManagementError("model_not_found", 404);
      const modalities = Array.isArray(input.manifest.modalities) ? input.manifest.modalities : [];
      if (!modalities.includes(String(model.modality)))
        throw new AdminManagementError("release_modality_mismatch", 422);
      const releaseId = id("release");
      const createdAt = this.now();
      await transaction`INSERT INTO model_releases (
        id, project_id, model_id, alias, maturity, source_image, image_digest, workflow_hash,
        manifest, manifest_digest, manifest_media_type, config_digest, status, version,
        accept_new_tasks, created_by, created_at
      ) VALUES (
        ${releaseId}, ${actor.projectId}, ${input.model_id}, ${String(model.alias)}, ${input.maturity},
        ${input.source_image}, ${resolved.digest}, ${input.workflow_hash}, ${JSON.stringify(input.manifest)},
        ${resolved.digest}, ${resolved.mediaType}, ${resolved.configDigest}, 'draft', 1, false,
        ${actor.actorId}, ${createdAt.toISOString()}
      )`;
      await this.audit(transaction, actor, request, "release.create", "model_release", releaseId, input.reason, {
        source_image: input.source_image,
        resolved_digest: resolved.digest,
        manifest_size_bytes: resolved.manifestSizeBytes,
      });
      return {
        status: 201,
        body: {
          id: releaseId,
          object: "model.release",
          model_id: input.model_id,
          source_image: input.source_image,
          image_digest: resolved.digest,
          workflow_hash: input.workflow_hash,
          maturity: input.maturity,
          status: "draft",
          version: 1,
          accept_new_tasks: false,
          created_at: unix(createdAt),
        },
      };
    });
  }

  async approveRelease(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    releaseId: string,
    input: Readonly<{ expected_version: number; decision: "approve" | "reject"; reason: string }>,
  ) {
    return this.mutate(actor, `releases:approve:${releaseId}`, idempotencyKey, input, async (transaction) => {
      const status = input.decision === "approve" ? "approved" : "rejected";
      const rows = await transaction`UPDATE model_releases SET status=${status}, version=version+1
        WHERE id=${releaseId} AND project_id=${actor.projectId} AND version=${input.expected_version} AND status='draft'
        RETURNING *`;
      if (!rows[0]) {
        const found = await transaction`SELECT version, status FROM model_releases
          WHERE id=${releaseId} AND project_id=${actor.projectId}`;
        throw new AdminManagementError(found[0] ? "version_conflict" : "release_not_found", found[0] ? 409 : 404);
      }
      await transaction`INSERT INTO release_approvals (
        id, project_id, release_id, release_version, decision, reason, created_by, created_at
      ) VALUES (
        ${id("approval")}, ${actor.projectId}, ${releaseId}, ${input.expected_version}, ${status},
        ${input.reason}, ${actor.actorId}, ${this.now().toISOString()}
      )`;
      await this.audit(transaction, actor, request, `release.${status}`, "model_release", releaseId, input.reason, {
        image_digest: rows[0].image_digest,
      });
      return {
        status: 200,
        body: { id: releaseId, status, version: Number(rows[0].version), image_digest: rows[0].image_digest },
      };
    });
  }

  async createPool(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    input: Readonly<{
      release_id: string;
      provider: string;
      region_id: string;
      gpu_sku: string;
      execution_mode: "deployment" | "batch";
      reason: string;
    }>,
  ) {
    return this.mutate(actor, "pools:create", idempotencyKey, input, async (transaction) => {
      const releases = await transaction`SELECT id FROM model_releases
        WHERE id=${input.release_id} AND project_id=${actor.projectId} AND status='approved' FOR SHARE`;
      if (!releases[0]) throw new AdminManagementError("approved_release_not_found", 422);
      const regions = await transaction`SELECT id FROM provider_regions
        WHERE id=${input.region_id} AND provider=${input.provider} AND status IN ('healthy', 'degraded') FOR SHARE`;
      if (!regions[0]) throw new AdminManagementError("provider_region_not_available", 422);
      const poolId = id("pool");
      const createdAt = this.now();
      await transaction`INSERT INTO model_pools (
        id, project_id, release_id, provider, region_id, gpu_sku, execution_mode, status,
        version, created_by, created_at, updated_at
      ) VALUES (
        ${poolId}, ${actor.projectId}, ${input.release_id}, ${input.provider}, ${input.region_id},
        ${input.gpu_sku}, ${input.execution_mode}, 'disabled', 1, ${actor.actorId},
        ${createdAt.toISOString()}, ${createdAt.toISOString()}
      )`;
      await this.audit(transaction, actor, request, "pool.create", "model_pool", poolId, input.reason);
      return {
        status: 201,
        body: {
          id: poolId,
          object: "model.pool",
          ...input,
          reason: undefined,
          status: "disabled",
          version: 1,
          created_at: unix(createdAt),
        },
      };
    });
  }

  async updatePool(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    poolId: string,
    input: Readonly<{ expected_version: number; status: string; reason: string }>,
  ) {
    return this.mutate(actor, `pools:update:${poolId}`, idempotencyKey, input, async (transaction) => {
      const updatedAt = this.now();
      if (input.status === "active") {
        const policies = await transaction`SELECT policy_type FROM policy_versions
          WHERE pool_id=${poolId} AND status='published' GROUP BY policy_type`;
        const types = new Set(policies.map((row) => String(row.policy_type)));
        if (!["capacity", "budget", "region", "retry"].every((type) => types.has(type))) {
          throw new AdminManagementError("pool_policy_incomplete", 422);
        }
      }
      const rows = await transaction`UPDATE model_pools SET
        status=${input.status}, version=version+1, updated_at=${updatedAt.toISOString()}
        WHERE id=${poolId} AND project_id=${actor.projectId} AND version=${input.expected_version}
        RETURNING *`;
      if (!rows[0]) {
        const found =
          await transaction`SELECT version FROM model_pools WHERE id=${poolId} AND project_id=${actor.projectId}`;
        throw new AdminManagementError(found[0] ? "version_conflict" : "pool_not_found", found[0] ? 409 : 404);
      }
      await this.audit(transaction, actor, request, "pool.update", "model_pool", poolId, input.reason, {
        previous_version: input.expected_version,
      });
      return {
        status: 200,
        body: { ...rows[0], created_at: unix(rows[0].created_at as string), updated_at: unix(updatedAt) },
      };
    });
  }

  private validatePolicyConfiguration(type: string, configuration: Record<string, unknown>): Record<string, unknown> {
    const errors: string[] = [];
    if (type === "capacity") {
      if (Number(configuration.max_replicas) < Number(configuration.min_replicas))
        errors.push("max_replicas_below_minimum");
      if (Number(configuration.target_utilization_percent) > 95) errors.push("target_utilization_above_safe_limit");
    }
    if (type === "budget" && Number(configuration.daily_limit_minor) < Number(configuration.hourly_limit_minor)) {
      errors.push("daily_limit_below_hourly_limit");
    }
    if (
      type === "region" &&
      (!Array.isArray(configuration.allowed_regions) || configuration.allowed_regions.length === 0)
    ) {
      errors.push("no_allowed_regions");
    }
    if (type === "retry" && Number(configuration.max_backoff_seconds) < Number(configuration.initial_backoff_seconds)) {
      errors.push("max_backoff_below_initial_backoff");
    }
    if (errors.length > 0) throw new AdminManagementError(errors[0] ?? "invalid_policy", 422);
    return { valid: true, checks: ["schema", "range", "cross_field"], warnings: [] };
  }

  async validatePolicy(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    input: Readonly<{ policy_type: string; pool_id: string; configuration: Record<string, unknown>; reason: string }>,
  ) {
    const validation = this.validatePolicyConfiguration(input.policy_type, input.configuration);
    return this.mutate(actor, "policies:validate", idempotencyKey, input, async (transaction) => {
      const pools = await transaction`SELECT id FROM model_pools
        WHERE id=${input.pool_id} AND project_id=${actor.projectId} FOR SHARE`;
      if (!pools[0]) throw new AdminManagementError("pool_not_found", 404);
      const versions = await transaction`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM policy_versions
        WHERE pool_id=${input.pool_id} AND policy_type=${input.policy_type}`;
      const version = Number(versions[0]?.version ?? 1);
      const policyId = id("policy");
      const createdAt = this.now();
      await transaction`INSERT INTO policy_versions (
        id, project_id, pool_id, policy_type, version, status, configuration, validation,
        reason, created_by, created_at
      ) VALUES (
        ${policyId}, ${actor.projectId}, ${input.pool_id}, ${input.policy_type}, ${version},
        'validated', ${JSON.stringify(input.configuration)}, ${JSON.stringify(validation)},
        ${input.reason}, ${actor.actorId}, ${createdAt.toISOString()}
      )`;
      await this.audit(transaction, actor, request, "policy.validate", "policy_version", policyId, input.reason);
      return {
        status: 201,
        body: {
          id: policyId,
          object: "policy.version",
          pool_id: input.pool_id,
          policy_type: input.policy_type,
          version,
          status: "validated",
          configuration: input.configuration,
          validation,
          created_at: unix(createdAt),
        },
      };
    });
  }

  async previewPolicy(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    policyId: string,
    input: Readonly<{ expected_policy_version: number; horizon_seconds: number; reason: string }>,
  ) {
    return this.mutate(actor, `policies:preview:${policyId}`, idempotencyKey, input, async (transaction) => {
      const rows = await transaction`SELECT p.*, mp.release_id,
        (SELECT COUNT(*)::int FROM tasks t WHERE t.model_release_id=mp.release_id AND t.status='queued') AS queued_tasks,
        (SELECT COUNT(*)::int FROM replicas r WHERE r.pool_id=mp.id AND r.observed_state IN ('ready','busy')) AS active_replicas
        FROM policy_versions p JOIN model_pools mp ON mp.id=p.pool_id
        WHERE p.id=${policyId} AND p.project_id=${actor.projectId} AND p.version=${input.expected_policy_version}
          AND p.status='validated' FOR SHARE`;
      const policy = rows[0];
      if (!policy) throw new AdminManagementError("policy_version_conflict", 409);
      const previewId = id("preview");
      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + 60 * 60 * 1000);
      const snapshot = {
        captured_at: unix(createdAt),
        queued_tasks: Number(policy.queued_tasks),
        active_replicas: Number(policy.active_replicas),
        horizon_seconds: input.horizon_seconds,
      };
      const configuration = policy.configuration as Record<string, unknown>;
      const impact = {
        current_replicas: Number(policy.active_replicas),
        projected_min_replicas: Number(configuration.min_replicas ?? policy.active_replicas),
        projected_max_replicas: Number(configuration.max_replicas ?? policy.active_replicas),
        queued_tasks_observed: Number(policy.queued_tasks),
        estimated_cost_change_minor: 0,
        warnings: Number(policy.queued_tasks) > 0 ? ["active_queue_present"] : [],
      };
      await transaction`INSERT INTO policy_impact_previews (
        id, project_id, policy_version_id, policy_version, snapshot, impact, reason,
        created_by, created_at, expires_at
      ) VALUES (
        ${previewId}, ${actor.projectId}, ${policyId}, ${input.expected_policy_version},
        ${JSON.stringify(snapshot)}, ${JSON.stringify(impact)}, ${input.reason}, ${actor.actorId},
        ${createdAt.toISOString()}, ${expiresAt.toISOString()}
      )`;
      await this.audit(transaction, actor, request, "policy.impact_preview", "policy_preview", previewId, input.reason);
      return {
        status: 201,
        body: {
          id: previewId,
          object: "policy.impact_preview",
          policy_version_id: policyId,
          policy_version: input.expected_policy_version,
          snapshot,
          impact,
          created_at: unix(createdAt),
          expires_at: unix(expiresAt),
        },
      };
    });
  }

  async publishPolicy(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    policyId: string,
    input: Readonly<{ expected_policy_version: number; preview_id: string; reason: string }>,
  ) {
    return this.mutate(actor, `policies:publish:${policyId}`, idempotencyKey, input, async (transaction) => {
      const rows = await transaction`SELECT p.* FROM policy_versions p
        JOIN policy_impact_previews i ON i.policy_version_id=p.id
        WHERE p.id=${policyId} AND p.project_id=${actor.projectId} AND p.version=${input.expected_policy_version}
          AND p.status='validated' AND i.id=${input.preview_id} AND i.expires_at>${this.now().toISOString()}
        FOR UPDATE`;
      const policy = rows[0];
      if (!policy) throw new AdminManagementError("valid_policy_preview_not_found", 409);
      await transaction`UPDATE policy_versions SET status='superseded'
        WHERE pool_id=${String(policy.pool_id)} AND policy_type=${String(policy.policy_type)} AND status='published'`;
      await transaction`UPDATE policy_versions SET status='published', published_at=${this.now().toISOString()} WHERE id=${policyId}`;
      await this.audit(transaction, actor, request, "policy.publish", "policy_version", policyId, input.reason, {
        preview_id: input.preview_id,
      });
      return {
        status: 200,
        body: {
          id: policyId,
          object: "policy.version",
          status: "published",
          version: Number(policy.version),
          preview_id: input.preview_id,
        },
      };
    });
  }

  async rollbackPolicy(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    poolId: string,
    policyType: string,
    input: Readonly<{ expected_current_version: number; target_policy_id: string; reason: string }>,
  ) {
    return this.mutate(
      actor,
      `policies:rollback:${poolId}:${policyType}`,
      idempotencyKey,
      input,
      async (transaction) => {
        const currentRows = await transaction`SELECT * FROM policy_versions
        WHERE pool_id=${poolId} AND policy_type=${policyType} AND project_id=${actor.projectId} AND status='published'
        FOR UPDATE`;
        const current = currentRows[0];
        if (!current || Number(current.version) !== input.expected_current_version) {
          throw new AdminManagementError("version_conflict", 409);
        }
        const targetRows = await transaction`SELECT configuration, validation FROM policy_versions
        WHERE id=${input.target_policy_id} AND pool_id=${poolId} AND policy_type=${policyType}
          AND project_id=${actor.projectId} FOR SHARE`;
        const target = targetRows[0];
        if (!target) throw new AdminManagementError("target_policy_not_found", 404);
        const next = await transaction`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM policy_versions
        WHERE pool_id=${poolId} AND policy_type=${policyType}`;
        const version = Number(next[0]?.version ?? input.expected_current_version + 1);
        const newPolicyId = id("policy");
        const createdAt = this.now();
        await transaction`UPDATE policy_versions SET status='superseded'
        WHERE id=${String(current.id)}`;
        await transaction`INSERT INTO policy_versions (
        id, project_id, pool_id, policy_type, version, status, configuration, validation,
        reason, created_by, created_at, published_at
      ) VALUES (
        ${newPolicyId}, ${actor.projectId}, ${poolId}, ${policyType}, ${version}, 'published',
        ${JSON.stringify(target.configuration)}, ${JSON.stringify(target.validation)}, ${input.reason},
        ${actor.actorId}, ${createdAt.toISOString()}, ${createdAt.toISOString()}
      )`;
        await this.audit(transaction, actor, request, "policy.rollback", "policy_version", newPolicyId, input.reason, {
          source_policy_id: current.id,
          target_policy_id: input.target_policy_id,
        });
        return {
          status: 201,
          body: {
            id: newPolicyId,
            object: "policy.version",
            pool_id: poolId,
            policy_type: policyType,
            version,
            status: "published",
            rolled_back_from: current.id,
            copied_from: input.target_policy_id,
          },
        };
      },
    );
  }

  async switchAlias(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    alias: string,
    input: Readonly<{ model_id: string; release_id: string; expected_version: number; reason: string }>,
  ) {
    return this.mutate(actor, `aliases:switch:${alias}`, idempotencyKey, input, async (transaction) => {
      const releases = await transaction`SELECT r.id, r.image_digest FROM model_releases r
        JOIN models m ON m.id=r.model_id
        WHERE r.id=${input.release_id} AND r.model_id=${input.model_id} AND r.project_id=${actor.projectId}
          AND r.status='approved' AND m.alias=${alias} FOR SHARE`;
      if (!releases[0]) throw new AdminManagementError("approved_release_not_found", 422);
      const current = await transaction`SELECT version, release_id FROM model_alias_versions
        WHERE project_id=${actor.projectId} AND alias=${alias} AND status='active' FOR UPDATE`;
      const currentVersion = current[0] ? Number(current[0].version) : 0;
      if (currentVersion !== input.expected_version) throw new AdminManagementError("version_conflict", 409);
      const required = await transaction`SELECT policy_type FROM policy_versions pv
        JOIN model_pools mp ON mp.id=pv.pool_id
        WHERE mp.project_id=${actor.projectId} AND mp.release_id=${input.release_id} AND pv.status='published'
        GROUP BY policy_type`;
      const policyTypes = new Set(required.map((row) => String(row.policy_type)));
      if (!["capacity", "budget", "region", "retry"].every((type) => policyTypes.has(type))) {
        throw new AdminManagementError("release_policy_incomplete", 422);
      }
      if (current[0]) {
        await transaction`UPDATE model_alias_versions SET status='superseded'
          WHERE project_id=${actor.projectId} AND alias=${alias} AND status='active'`;
      }
      const version = currentVersion + 1;
      const aliasVersionId = id("aliasver");
      await transaction`INSERT INTO model_alias_versions (
        id, project_id, alias, model_id, release_id, version, status, reason, created_by, created_at
      ) VALUES (
        ${aliasVersionId}, ${actor.projectId}, ${alias}, ${input.model_id}, ${input.release_id},
        ${version}, 'active', ${input.reason}, ${actor.actorId}, ${this.now().toISOString()}
      )`;
      await transaction`UPDATE model_releases SET accept_new_tasks=false WHERE model_id=${input.model_id}`;
      await transaction`UPDATE model_releases SET accept_new_tasks=true WHERE id=${input.release_id}`;
      await this.audit(transaction, actor, request, "model_alias.switch", "model_alias", alias, input.reason, {
        release_id: input.release_id,
        image_digest: releases[0].image_digest,
        previous_release_id: current[0]?.release_id ?? null,
      });
      return {
        status: 200,
        body: {
          id: aliasVersionId,
          object: "model.alias",
          alias,
          model_id: input.model_id,
          release_id: input.release_id,
          version,
          status: "active",
        },
      };
    });
  }

  async previewRollout(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    input: Readonly<{
      release_id: string;
      pool_id: string;
      expected_pool_version: number;
      strategy: RolloutStrategy;
      reason: string;
    }>,
  ) {
    return this.mutate(actor, "rollouts:preview", idempotencyKey, input, async (transaction) => {
      const rows = await transaction`SELECT p.*, source.model_id, source.alias,
          source.image_digest AS source_image_digest, target.image_digest AS target_image_digest,
          target.status AS target_status, target.manifest AS target_manifest
        FROM model_pools p
        JOIN model_releases source ON source.id=p.release_id
        JOIN model_releases target ON target.id=${input.release_id}
          AND target.project_id=p.project_id AND target.model_id=source.model_id
        WHERE p.id=${input.pool_id} AND p.project_id=${actor.projectId}
        FOR SHARE OF p, source, target`;
      const pool = rows[0];
      if (!pool) throw new AdminManagementError("rollout_target_not_found", 404);
      if (Number(pool.version) !== input.expected_pool_version) throw new AdminManagementError("version_conflict", 409);
      if (String(pool.status) !== "active") throw new AdminManagementError("rollout_pool_not_active", 422);
      if (String(pool.target_status) !== "approved") throw new AdminManagementError("approved_release_not_found", 422);
      if (String(pool.release_id) === input.release_id)
        throw new AdminManagementError("rollout_release_unchanged", 422);
      const active = await transaction`SELECT id FROM model_rollouts WHERE pool_id=${input.pool_id}
        AND status IN ('pending','validating','rolling','paused','rolling_back') LIMIT 1`;
      if (active[0]) throw new AdminManagementError("rollout_already_active", 409);
      const policies = await transaction`SELECT policy_type FROM policy_versions
        WHERE pool_id=${input.pool_id} AND status='published' GROUP BY policy_type`;
      const policyTypes = new Set(policies.map((row) => String(row.policy_type)));
      if (!["capacity", "budget", "region", "retry"].every((type) => policyTypes.has(type))) {
        throw new AdminManagementError("release_policy_incomplete", 422);
      }
      const providerState = await transaction`SELECT latest_published_run_id, expires_at
        FROM provider_snapshot_state WHERE provider=${String(pool.provider)}`;
      if (
        !providerState[0]?.latest_published_run_id ||
        !providerState[0].expires_at ||
        new Date(providerState[0].expires_at as string | Date) <= this.now()
      ) {
        throw new AdminManagementError("provider_snapshot_stale", 503, true);
      }
      const targetManifest = pool.target_manifest as Record<string, unknown>;
      const requirements = targetManifest.resource_requirements as Record<string, unknown> | undefined;
      const gpuSkus = Array.isArray(requirements?.gpu_skus) ? requirements.gpu_skus.map(String) : [];
      if (gpuSkus.length > 0 && !gpuSkus.includes(String(pool.gpu_sku))) {
        throw new AdminManagementError("rollout_hardware_incompatible", 422);
      }
      const inventory = await transaction`SELECT price_per_gpu_hour_minor, currency, available_replicas
        FROM provider_inventory WHERE provider=${String(pool.provider)} AND region_id=${String(pool.region_id)}
          AND gpu_sku=${String(pool.gpu_sku)} ORDER BY observed_at DESC LIMIT 1`;
      if (!inventory[0]) throw new AdminManagementError("rollout_inventory_unavailable", 503, true);
      if (String(inventory[0].currency) !== input.strategy.currency) {
        throw new AdminManagementError("rollout_currency_mismatch", 422);
      }
      if (Number(inventory[0].available_replicas) < input.strategy.max_surge) {
        throw new AdminManagementError("rollout_inventory_insufficient", 422);
      }
      const replicaCount = await transaction`SELECT count(*)::int AS count FROM replicas
        WHERE pool_id=${input.pool_id} AND release_id=${String(pool.release_id)}
          AND desired_state<>'terminated' AND observed_state<>'terminated'`;
      const sourceReplicas = Number(replicaCount[0]?.count ?? 0);
      const pricePerHour = Number(inventory[0].price_per_gpu_hour_minor);
      const estimatedExtraCost =
        input.strategy.max_surge * pricePerHour * Math.ceil(input.strategy.progress_deadline_seconds / 3600);
      if (estimatedExtraCost > input.strategy.maximum_extra_cost_minor) {
        throw new AdminManagementError("rollout_extra_cost_limit_exceeded", 422);
      }
      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000);
      const previewId = id("rolloutpreview");
      const snapshot = {
        provider_snapshot_run_id: providerState[0].latest_published_run_id,
        pool_version: Number(pool.version),
        source_replicas: sourceReplicas,
        available_replicas: Number(inventory[0].available_replicas),
        price_per_gpu_hour_minor: pricePerHour,
      };
      const impact = {
        estimated_extra_cost_minor: estimatedExtraCost,
        temporary_capacity_reduction: input.strategy.max_surge === 0 ? input.strategy.max_unavailable : 0,
        requires_queue_risk_acceptance: input.strategy.max_surge === 0,
        source_replicas: sourceReplicas,
        replacement_steps: Math.max(sourceReplicas, 1),
      };
      await transaction`INSERT INTO rollout_impact_previews (
          id, project_id, pool_id, source_release_id, target_release_id, pool_version,
          source_image_digest, target_image_digest, strategy, snapshot, impact, reason,
          created_by, created_at, expires_at
        ) VALUES (
          ${previewId}, ${actor.projectId}, ${input.pool_id}, ${String(pool.release_id)}, ${input.release_id},
          ${Number(pool.version)}, ${String(pool.source_image_digest)}, ${String(pool.target_image_digest)},
          ${JSON.stringify(input.strategy)}, ${JSON.stringify(snapshot)}, ${JSON.stringify(impact)}, ${input.reason},
          ${actor.actorId}, ${createdAt.toISOString()}, ${expiresAt.toISOString()}
        )`;
      await this.audit(transaction, actor, request, "rollout.preview", "rollout_preview", previewId, input.reason, {
        pool_id: input.pool_id,
        source_release_id: pool.release_id,
        target_release_id: input.release_id,
        estimated_extra_cost_minor: estimatedExtraCost,
        currency: input.strategy.currency,
      });
      return {
        status: 201,
        body: {
          id: previewId,
          object: "rollout.preview",
          pool_id: input.pool_id,
          source_release_id: pool.release_id,
          target_release_id: input.release_id,
          pool_version: Number(pool.version),
          strategy: input.strategy,
          snapshot,
          impact,
          created_at: unix(createdAt),
          expires_at: unix(expiresAt),
        },
      };
    });
  }

  async createRollout(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    input: Readonly<{
      release_id: string;
      pool_id: string;
      preview_id: string;
      expected_pool_version: number;
      reason: string;
    }>,
  ) {
    return this.mutate(actor, "rollouts:create", idempotencyKey, input, async (transaction) => {
      const previews = await transaction`SELECT rp.*, target.model_id, target.alias, p.provider, p.region_id, p.gpu_sku,
          p.status AS pool_status, p.version AS current_pool_version
        FROM rollout_impact_previews rp
        JOIN model_pools p ON p.id=rp.pool_id
        JOIN model_releases target ON target.id=rp.target_release_id
        WHERE rp.id=${input.preview_id} AND rp.project_id=${actor.projectId}
        FOR UPDATE OF rp, p, target`;
      const preview = previews[0];
      if (!preview) throw new AdminManagementError("rollout_preview_not_found", 404);
      if (String(preview.pool_id) !== input.pool_id || String(preview.target_release_id) !== input.release_id) {
        throw new AdminManagementError("rollout_preview_mismatch", 409);
      }
      if (new Date(preview.expires_at as string | Date) <= this.now()) {
        throw new AdminManagementError("rollout_preview_expired", 409);
      }
      if (
        Number(preview.pool_version) !== input.expected_pool_version ||
        Number(preview.current_pool_version) !== input.expected_pool_version
      ) {
        throw new AdminManagementError("version_conflict", 409);
      }
      if (String(preview.pool_status) !== "active") throw new AdminManagementError("rollout_pool_not_active", 422);
      const rolloutId = id("rollout");
      const createdAt = this.now();
      const progress = {
        total_steps: Number((preview.impact as Record<string, unknown>).replacement_steps ?? 1),
        completed_steps: 0,
      };
      try {
        await transaction`INSERT INTO model_rollouts (
            id, project_id, pool_id, model_id, alias, provider, region_id, gpu_sku, preview_id,
            source_release_id, target_release_id, source_image_digest, target_image_digest,
            direction, status, strategy, progress, spent_extra_cost_minor, currency, reason,
            created_by, version, created_at, updated_at
          ) VALUES (
            ${rolloutId}, ${actor.projectId}, ${input.pool_id}, ${String(preview.model_id)}, ${String(preview.alias)},
            ${String(preview.provider)}, ${String(preview.region_id)}, ${String(preview.gpu_sku)}, ${input.preview_id},
            ${String(preview.source_release_id)}, ${input.release_id}, ${String(preview.source_image_digest)},
            ${String(preview.target_image_digest)}, 'forward', 'pending', ${JSON.stringify(preview.strategy)},
            ${JSON.stringify(progress)}, 0, ${String((preview.strategy as Record<string, unknown>).currency)},
            ${input.reason}, ${actor.actorId}, 1, ${createdAt.toISOString()}, ${createdAt.toISOString()}
          )`;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "23505") {
          throw new AdminManagementError("rollout_already_active", 409);
        }
        throw error;
      }
      await transaction`INSERT INTO rollout_events (
          id, rollout_id, rollout_version, event_type, actor_type, actor_id, reason, details, created_at
        ) VALUES (
          ${id("rolloutevent")}, ${rolloutId}, 1, 'rollout.created', 'oidc_user', ${actor.actorId},
          ${input.reason}, ${JSON.stringify({ preview_id: input.preview_id, direction: "forward" })},
          ${createdAt.toISOString()}
        )`;
      await transaction`INSERT INTO outbox_events (
          id, aggregate_type, aggregate_id, aggregate_version, event_type, payload, trace_id, created_at
        ) VALUES (
          ${id("event")}, 'rollout', ${rolloutId}, 1, 'rollout.created.v1',
          ${JSON.stringify({ rollout_id: rolloutId, pool_id: input.pool_id, target_release_id: input.release_id })},
          ${request.traceId ?? request.requestId}, ${createdAt.toISOString()}
        )`;
      await this.audit(transaction, actor, request, "rollout.create", "rollout", rolloutId, input.reason, {
        pool_id: input.pool_id,
        source_release_id: preview.source_release_id,
        target_release_id: input.release_id,
        source_image_digest: preview.source_image_digest,
        target_image_digest: preview.target_image_digest,
      });
      return { status: 202, body: { id: rolloutId, object: "rollout", status: "pending", version: 1, progress } };
    });
  }

  private async controlRollout(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    rolloutId: string,
    action: "pause" | "resume" | "rollback",
    input: Readonly<{ expected_version: number; reason: string }>,
  ) {
    return this.mutate(actor, `rollouts:${action}:${rolloutId}`, idempotencyKey, input, async (transaction) => {
      const rows = await transaction`SELECT * FROM model_rollouts
        WHERE id=${rolloutId} AND project_id=${actor.projectId} FOR UPDATE`;
      const rollout = rows[0];
      if (!rollout) throw new AdminManagementError("rollout_not_found", 404);
      if (Number(rollout.version) !== input.expected_version) throw new AdminManagementError("version_conflict", 409);
      const current = String(rollout.status);
      const allowed =
        action === "pause"
          ? ["pending", "validating", "rolling", "rolling_back"]
          : action === "resume"
            ? ["paused"]
            : ["pending", "validating", "rolling", "paused", "completed", "failed"];
      if (!allowed.includes(current)) throw new AdminManagementError(`rollout_${action}_not_allowed`, 409);
      if (action === "rollback" && !rollout.source_release_id) {
        throw new AdminManagementError("rollout_rollback_source_missing", 422);
      }
      const nextStatus = action === "pause" ? "paused" : action === "resume" ? "pending" : "rolling_back";
      const nextVersion = input.expected_version + 1;
      const timestamp = this.now();
      await transaction`UPDATE model_rollouts SET
          status=${nextStatus}, direction=${action === "rollback" ? "rollback" : String(rollout.direction)},
          pause_code=${action === "pause" ? "operator_requested" : null},
          paused_at=${action === "pause" ? timestamp.toISOString() : null},
          rollback_requested_at=${action === "rollback" ? timestamp.toISOString() : rollout.rollback_requested_at},
          reason=${input.reason}, version=${nextVersion}, updated_at=${timestamp.toISOString()}, completed_at=NULL
        WHERE id=${rolloutId} AND version=${input.expected_version}`;
      if (action === "rollback") {
        await transaction`UPDATE model_releases SET accept_new_tasks=false WHERE id=${String(rollout.target_release_id)}`;
        await transaction`UPDATE model_releases SET accept_new_tasks=true, accept_existing_tasks=true
          WHERE id=${String(rollout.source_release_id)}`;
        const activeAlias = await transaction`SELECT version FROM model_alias_versions
          WHERE project_id=${actor.projectId} AND alias=${String(rollout.alias)} AND status='active' FOR UPDATE`;
        if (activeAlias[0]) {
          await transaction`UPDATE model_alias_versions SET status='superseded'
            WHERE project_id=${actor.projectId} AND alias=${String(rollout.alias)} AND status='active'`;
        }
        await transaction`INSERT INTO model_alias_versions (
            id, project_id, alias, model_id, release_id, version, status, reason, created_by, created_at
          ) VALUES (
            ${id("aliasver")}, ${actor.projectId}, ${String(rollout.alias)}, ${String(rollout.model_id)},
            ${String(rollout.source_release_id)}, ${Number(activeAlias[0]?.version ?? 0) + 1}, 'active',
            ${input.reason}, ${actor.actorId}, ${timestamp.toISOString()}
          )`;
      }
      await transaction`INSERT INTO rollout_events (
          id, rollout_id, rollout_version, event_type, actor_type, actor_id, reason, details, created_at
        ) VALUES (
          ${id("rolloutevent")}, ${rolloutId}, ${nextVersion}, ${`rollout.${action}`}, 'oidc_user',
          ${actor.actorId}, ${input.reason}, ${JSON.stringify({ previous_status: current, status: nextStatus })},
          ${timestamp.toISOString()}
        )`;
      await transaction`INSERT INTO outbox_events (
          id, aggregate_type, aggregate_id, aggregate_version, event_type, payload, trace_id, created_at
        ) VALUES (
          ${id("event")}, 'rollout', ${rolloutId}, ${nextVersion}, ${`rollout.${action}.v1`},
          ${JSON.stringify({ rollout_id: rolloutId, status: nextStatus, direction: action === "rollback" ? "rollback" : rollout.direction })},
          ${request.traceId ?? request.requestId}, ${timestamp.toISOString()}
        )`;
      await this.audit(transaction, actor, request, `rollout.${action}`, "rollout", rolloutId, input.reason, {
        previous_status: current,
        status: nextStatus,
        version: nextVersion,
      });
      return {
        status: action === "rollback" ? 202 : 200,
        body: {
          id: rolloutId,
          object: "rollout",
          status: nextStatus,
          direction: action === "rollback" ? "rollback" : rollout.direction,
          version: nextVersion,
        },
      };
    });
  }

  pauseRollout(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    rolloutId: string,
    input: Readonly<{ expected_version: number; reason: string }>,
  ) {
    return this.controlRollout(actor, request, idempotencyKey, rolloutId, "pause", input);
  }

  resumeRollout(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    rolloutId: string,
    input: Readonly<{ expected_version: number; reason: string }>,
  ) {
    return this.controlRollout(actor, request, idempotencyKey, rolloutId, "resume", input);
  }

  rollbackRollout(
    actor: ManagementActor,
    request: ManagementRequest,
    idempotencyKey: string,
    rolloutId: string,
    input: Readonly<{ expected_version: number; reason: string }>,
  ) {
    return this.controlRollout(actor, request, idempotencyKey, rolloutId, "rollback", input);
  }
}
