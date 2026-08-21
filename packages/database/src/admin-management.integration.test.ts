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

  integrationTest("previews, starts, controls and reverses a digest-pinned rollout", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await fixture();
    let resolution = 0;
    const resolver: OciImageResolver = {
      resolve: async (sourceImage) => {
        resolution += 1;
        return {
          sourceImage,
          digest: `sha256:${String(resolution).repeat(64)}`,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          configDigest: `sha256:${String(resolution + 4).repeat(64)}`,
          manifestSizeBytes: 512,
        };
      },
    };
    const service = new AdminManagementService(
      database.client,
      resolver,
      "management-audit-signing-key-at-least-32-bytes",
    );
    const model = await service.createModel(context.actor, context.request, `rollout-model-${context.suffix}`, {
      alias: `rollout-video-${context.suffix}`,
      modality: "video",
      description: "rollout contract model",
      reason: "Create rollout contract model",
    });
    const source = await service.createRelease(context.actor, context.request, `rollout-source-${context.suffix}`, {
      model_id: String(model.body.id),
      source_image: "registry-reference:5000/astra/source:stable",
      workflow_hash: "1".repeat(64),
      maturity: "stable",
      manifest,
      reason: "Register stable rollout source",
    });
    const target = await service.createRelease(context.actor, context.request, `rollout-target-${context.suffix}`, {
      model_id: String(model.body.id),
      source_image: "registry-reference:5000/astra/target:candidate",
      workflow_hash: "2".repeat(64),
      maturity: "candidate",
      manifest,
      reason: "Register candidate rollout target",
    });
    for (const [name, release] of [
      ["source", source],
      ["target", target],
    ] as const) {
      await service.approveRelease(
        context.actor,
        context.request,
        `rollout-approve-${name}-${context.suffix}`,
        String(release.body.id),
        { expected_version: 1, decision: "approve", reason: `Approve rollout ${name} release` },
      );
    }
    const provider = `reference_${context.suffix}`;
    const region = `region_${context.suffix}`;
    const run = `snapshot_${context.suffix}`;
    await database.client.begin(async (transaction) => {
      await transaction`INSERT INTO provider_regions (id, provider, name, status, created_at, updated_at)
        VALUES (${region}, ${provider}, 'Rollout Region', 'healthy', now(), now())`;
      await transaction`INSERT INTO provider_inventory (
          id, provider, region_id, gpu_sku, gpu_memory_bytes, available_replicas,
          price_per_gpu_hour_minor, currency, snapshot_version, observed_at, created_at
        ) VALUES (
          ${`inventory_${context.suffix}`}, ${provider}, ${region}, 'rtx5090', 34359738368, 10,
          300, 'CNY', ${run}, now(), now()
        )`;
      await transaction`INSERT INTO provider_snapshot_runs (
          id, provider, contract_version, status, observed_at, expires_at, payload_hash,
          object_count, quarantine_reasons, started_at, completed_at
        ) VALUES (
          ${run}, ${provider}, 'reference-v1', 'published', now(), now() + interval '1 hour',
          ${"a".repeat(64)}, 1, '[]'::jsonb, now(), now()
        )`;
      await transaction`INSERT INTO provider_snapshot_state (
          provider, latest_attempt_run_id, latest_published_run_id, status, observed_at,
          expires_at, version, updated_at
        ) VALUES (
          ${provider}, ${run}, ${run}, 'fresh', now(), now() + interval '1 hour', 1, now()
        )`;
    });
    const pool = await service.createPool(context.actor, context.request, `rollout-pool-${context.suffix}`, {
      release_id: String(source.body.id),
      provider,
      region_id: region,
      gpu_sku: "rtx5090",
      execution_mode: "deployment",
      reason: "Create rollout source pool",
    });
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
        allowed_regions: [region],
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
        `rollout-validate-${policyType}-${context.suffix}`,
        {
          policy_type: policyType,
          pool_id: String(pool.body.id),
          configuration,
          reason: `Validate rollout ${policyType}`,
        },
      );
      const policyPreview = await service.previewPolicy(
        context.actor,
        context.request,
        `rollout-policy-preview-${policyType}-${context.suffix}`,
        String(policy.body.id),
        {
          expected_policy_version: Number(policy.body.version),
          horizon_seconds: 3600,
          reason: `Preview rollout ${policyType}`,
        },
      );
      await service.publishPolicy(
        context.actor,
        context.request,
        `rollout-publish-${policyType}-${context.suffix}`,
        String(policy.body.id),
        {
          expected_policy_version: Number(policy.body.version),
          preview_id: String(policyPreview.body.id),
          reason: `Publish rollout ${policyType}`,
        },
      );
    }
    await service.updatePool(
      context.actor,
      context.request,
      `rollout-activate-${context.suffix}`,
      String(pool.body.id),
      { expected_version: 1, status: "active", reason: "Activate rollout source pool" },
    );
    const strategy = {
      max_surge: 1,
      max_unavailable: 0,
      batch_size: 1,
      readiness_timeout_seconds: 1800,
      readiness_stability_seconds: 60,
      progress_deadline_seconds: 7200,
      pause_on_failure: true,
      maximum_failure_rate_basis_points: 500,
      maximum_duration_regression_basis_points: 2500,
      maximum_extra_cost_minor: 600,
      currency: "CNY",
      rollback_retention_seconds: 604800,
    };
    const preview = await service.previewRollout(context.actor, context.request, `rollout-preview-${context.suffix}`, {
      release_id: String(target.body.id),
      pool_id: String(pool.body.id),
      expected_pool_version: 2,
      strategy,
      reason: "Preview digest pinned rollout",
    });
    expect(preview.body).toMatchObject({
      object: "rollout.preview",
      source_release_id: source.body.id,
      target_release_id: target.body.id,
      impact: { estimated_extra_cost_minor: 600 },
    });
    const rolloutInput = {
      release_id: String(target.body.id),
      pool_id: String(pool.body.id),
      preview_id: String(preview.body.id),
      expected_pool_version: 2,
      reason: "Start digest pinned rollout",
    };
    const rollout = await service.createRollout(
      context.actor,
      context.request,
      `rollout-create-${context.suffix}`,
      rolloutInput,
    );
    const replay = await service.createRollout(
      context.actor,
      context.request,
      `rollout-create-${context.suffix}`,
      rolloutInput,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.body.id).toBe(rollout.body.id);
    const paused = await service.pauseRollout(
      context.actor,
      context.request,
      `rollout-pause-${context.suffix}`,
      String(rollout.body.id),
      { expected_version: 1, reason: "Pause rollout for operator review" },
    );
    expect(paused.body).toMatchObject({ status: "paused", version: 2 });
    const resumed = await service.resumeRollout(
      context.actor,
      context.request,
      `rollout-resume-${context.suffix}`,
      String(rollout.body.id),
      { expected_version: 2, reason: "Resume rollout after operator review" },
    );
    expect(resumed.body).toMatchObject({ status: "pending", version: 3 });
    const reversed = await service.rollbackRollout(
      context.actor,
      context.request,
      `rollout-rollback-${context.suffix}`,
      String(rollout.body.id),
      { expected_version: 3, reason: "Restore stable digest before reverse rollout" },
    );
    expect(reversed.body).toMatchObject({ status: "rolling_back", direction: "rollback", version: 4 });
    const aliases = await database.client`SELECT release_id FROM model_alias_versions
      WHERE project_id=${context.actor.projectId} AND alias=${String(model.body.alias)} AND status='active'`;
    expect(aliases[0]?.release_id).toBe(source.body.id);
    const events = await database.client`SELECT event_type FROM rollout_events
      WHERE rollout_id=${String(rollout.body.id)} ORDER BY created_at, id`;
    expect(events.map((row) => row.event_type)).toEqual([
      "rollout.created",
      "rollout.pause",
      "rollout.resume",
      "rollout.rollback",
    ]);
  });
});
