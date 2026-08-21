import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { AdminManagementService, createDatabase, type OciImageResolver } from "./index.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integrationTest = database ? test : test.skip;

afterAll(async () => {
  await database?.client.end();
});

const manifest = {
  worker_contract_version: "v1",
  modalities: ["video"],
  operations: ["generation", "edit"],
  capabilities: { durations: [4, 6, 10, 15], resolution_matrix: { "16:9/720p": { width: 1280, height: 720 } } },
  parameter_schema: { type: "object", additionalProperties: false },
  output_contract: { media_types: ["video/mp4"], preserve_original_bytes: true },
  resource_requirements: { gpu_skus: ["rtx5090"], gpu_memory_bytes: 34359738368, concurrency: 1 },
  components: [{ name: "comfyui", commit: "1234567" }],
  weights: [{ logical_name: "model", sha256: "a".repeat(64), size_bytes: 1 }],
};

async function fixture() {
  if (!database) throw new Error("test database unavailable");
  const suffix = randomUUID().replaceAll("-", "");
  const organizationId = `org_manage_${suffix}`;
  const projectId = `project_manage_${suffix}`;
  const sessionId = `session_manage_${suffix}`;
  const actorId = `operator_${suffix}`;
  const tokenHash = createHash("sha256").update(`session:${suffix}`).digest("hex");
  const csrfHash = createHash("sha256").update(`csrf:${suffix}`).digest("hex");
  const oidcHash = createHash("sha256").update(`oidc:${suffix}`).digest("hex");
  await database.client.begin(async (transaction) => {
    await transaction`INSERT INTO organizations (id, name, status) VALUES (${organizationId}, ${suffix}, 'active')`;
    await transaction`INSERT INTO projects (id, organization_id, name, status) VALUES (${projectId}, ${organizationId}, ${suffix}, 'active')`;
    await transaction`INSERT INTO organization_memberships (id, organization_id, subject_type, subject_id, role, created_at)
      VALUES (${`orgmem_${suffix}`}, ${organizationId}, 'oidc_user', ${actorId}, 'admin', now())`;
    await transaction`INSERT INTO project_memberships (id, organization_id, project_id, subject_type, subject_id, role, created_at)
      VALUES (${`promem_${suffix}`}, ${organizationId}, ${projectId}, 'oidc_user', ${actorId}, 'admin', now())`;
    await transaction`INSERT INTO admin_sessions (
      id, issuer, subject, oidc_groups, organization_id, project_id, token_hash, csrf_hash,
      oidc_token_hash, status, expires_at, created_at
    ) VALUES (
      ${sessionId}, 'https://issuer.test', ${actorId}, ARRAY[]::text[], ${organizationId}, ${projectId},
      ${tokenHash}, ${csrfHash}, ${oidcHash}, 'active', now() + interval '1 hour', now()
    )`;
  });
  return {
    actor: { actorId, sessionId, organizationId, projectId },
    request: { requestId: `req_${suffix}` },
    suffix,
  };
}

describe("AdminManagementService PostgreSQL contract", () => {
  integrationTest("freezes an OCI digest, converges idempotency and records approval atomically", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await fixture();
    let resolutions = 0;
    const resolver: OciImageResolver = {
      resolve: async (sourceImage) => {
        resolutions += 1;
        return {
          sourceImage,
          digest: `sha256:${"4".repeat(64)}`,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          configDigest: `sha256:${"5".repeat(64)}`,
          manifestSizeBytes: 512,
        };
      },
    };
    const service = new AdminManagementService(
      database.client,
      resolver,
      "management-audit-signing-key-at-least-32-bytes",
    );
    const model = await service.createModel(context.actor, context.request, `model-key-${context.suffix}`, {
      alias: `video-${context.suffix}`,
      modality: "video",
      description: "integration model",
      reason: "Create integration model",
    });
    const modelReplay = await service.createModel(context.actor, context.request, `model-key-${context.suffix}`, {
      alias: `video-${context.suffix}`,
      modality: "video",
      description: "integration model",
      reason: "Create integration model",
    });
    expect(modelReplay.replayed).toBe(true);
    expect(modelReplay.body.id).toBe(model.body.id);

    const input = {
      model_id: String(model.body.id),
      source_image: "registry-reference:5000/astra/model-app:local",
      workflow_hash: "6".repeat(64),
      maturity: "candidate",
      manifest,
      reason: "Register immutable candidate image",
    };
    const release = await service.createRelease(context.actor, context.request, `release-key-${context.suffix}`, input);
    const replay = await service.createRelease(context.actor, context.request, `release-key-${context.suffix}`, input);
    expect(replay.replayed).toBe(true);
    expect(replay.body.id).toBe(release.body.id);
    expect(resolutions).toBe(1);
    expect(release.body.image_digest).toBe(`sha256:${"4".repeat(64)}`);
    const approval = await service.approveRelease(
      context.actor,
      context.request,
      `approval-key-${context.suffix}`,
      String(release.body.id),
      { expected_version: 1, decision: "approve", reason: "Mechanical gates passed" },
    );
    expect(approval.body).toMatchObject({ status: "approved", version: 2 });
    const rows =
      await database.client`SELECT source_image, image_digest, status FROM model_releases WHERE id=${String(release.body.id)}`;
    expect(rows[0]).toMatchObject({
      source_image: input.source_image,
      image_digest: `sha256:${"4".repeat(64)}`,
      status: "approved",
    });
    let releaseGuard = "";
    try {
      await database.client`UPDATE model_releases SET source_image='registry.invalid/changed:tag' WHERE id=${String(release.body.id)}`;
    } catch (error) {
      releaseGuard = error instanceof Error ? error.message : String(error);
    }
    expect(releaseGuard).toContain("immutable_model_release_metadata");
    let idempotencyGuard = "";
    try {
      await database.client`DELETE FROM admin_idempotency_records WHERE resource_id=${String(release.body.id)}`;
    } catch (error) {
      idempotencyGuard = error instanceof Error ? error.message : String(error);
    }
    expect(idempotencyGuard).toContain("immutable_admin_history");
    const audits = await database.client`SELECT action FROM audit_events
      WHERE project_id=${context.actor.projectId} AND action IN ('model.create','release.create','release.approved') ORDER BY action`;
    expect(audits.map((row) => row.action)).toEqual(["model.create", "release.approved", "release.create"]);
  });

  integrationTest("requires validated previews and all policy classes before traffic activation", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await fixture();
    const resolver: OciImageResolver = {
      resolve: async (sourceImage) => ({
        sourceImage,
        digest: `sha256:${"7".repeat(64)}`,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        configDigest: `sha256:${"8".repeat(64)}`,
        manifestSizeBytes: 512,
      }),
    };
    const service = new AdminManagementService(
      database.client,
      resolver,
      "management-audit-signing-key-at-least-32-bytes",
    );
    const model = await service.createModel(context.actor, context.request, `model-key-${context.suffix}`, {
      alias: `video-${context.suffix}`,
      modality: "video",
      description: "",
      reason: "Create policy model",
    });
    const release = await service.createRelease(context.actor, context.request, `release-key-${context.suffix}`, {
      model_id: String(model.body.id),
      source_image: "registry-reference:5000/astra/model-app:local",
      workflow_hash: "9".repeat(64),
      maturity: "candidate",
      manifest,
      reason: "Create policy release",
    });
    await service.approveRelease(
      context.actor,
      context.request,
      `approval-key-${context.suffix}`,
      String(release.body.id),
      { expected_version: 1, decision: "approve", reason: "Approve policy release" },
    );
    const pool = await service.createPool(context.actor, context.request, `pool-key-${context.suffix}`, {
      release_id: String(release.body.id),
      provider: "reference",
      region_id: "region_local",
      gpu_sku: "rtx5090",
      execution_mode: "deployment",
      reason: "Create capacity pool",
    });
    await expect(
      service.updatePool(context.actor, context.request, `early-pool-${context.suffix}`, String(pool.body.id), {
        expected_version: 1,
        status: "active",
        reason: "Activate capacity pool",
      }),
    ).rejects.toThrow("pool_policy_incomplete");

    const configurations: Record<string, Record<string, unknown>> = {
      capacity: {
        min_replicas: 0,
        max_replicas: 10,
        queue_target_seconds: 60,
        target_utilization_percent: 75,
        scale_up_step: 2,
        scale_down_step_percent: 10,
        idle_window_seconds: 900,
        scale_down_cooldown_seconds: 1200,
        hysteresis_percent: 10,
      },
      budget: { currency: "CNY", hourly_limit_minor: 3000, daily_limit_minor: 30000, minimum_margin_minor: 10 },
      region: {
        allowed_regions: ["region_local"],
        max_price_per_gpu_hour_minor: 300,
        completion_weight: 5,
        cost_weight: 5,
        failure_weight: 5,
        cold_start_weight: 5,
        transfer_weight: 5,
      },
      retry: { max_attempts: 3, initial_backoff_seconds: 5, max_backoff_seconds: 60, retryable_codes: ["worker_lost"] },
    };
    for (const [policyType, configuration] of Object.entries(configurations)) {
      const policy = await service.validatePolicy(
        context.actor,
        context.request,
        `validate-${policyType}-${context.suffix}`,
        {
          policy_type: policyType,
          pool_id: String(pool.body.id),
          configuration,
          reason: `Validate ${policyType} policy`,
        },
      );
      const preview = await service.previewPolicy(
        context.actor,
        context.request,
        `preview-${policyType}-${context.suffix}`,
        String(policy.body.id),
        {
          expected_policy_version: Number(policy.body.version),
          horizon_seconds: 3600,
          reason: `Preview ${policyType} policy`,
        },
      );
      await service.publishPolicy(
        context.actor,
        context.request,
        `publish-${policyType}-${context.suffix}`,
        String(policy.body.id),
        {
          expected_policy_version: Number(policy.body.version),
          preview_id: String(preview.body.id),
          reason: `Publish ${policyType} policy`,
        },
      );
    }
    const activated = await service.updatePool(
      context.actor,
      context.request,
      `activate-pool-${context.suffix}`,
      String(pool.body.id),
      { expected_version: 1, status: "active", reason: "Activate configured pool" },
    );
    expect(activated.body).toMatchObject({ status: "active", version: 2 });
    let policyGuard = "";
    try {
      await database.client`UPDATE policy_versions SET configuration='{}'::jsonb
        WHERE pool_id=${String(pool.body.id)} AND status='published'`;
    } catch (error) {
      policyGuard = error instanceof Error ? error.message : String(error);
    }
    expect(policyGuard).toContain("immutable_policy_version");
    const alias = await service.switchAlias(
      context.actor,
      context.request,
      `alias-key-${context.suffix}`,
      String(model.body.alias),
      {
        model_id: String(model.body.id),
        release_id: String(release.body.id),
        expected_version: 0,
        reason: "Activate approved release alias",
      },
    );
    expect(alias.body).toMatchObject({ release_id: release.body.id, version: 1, status: "active" });
  });
});
