import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { AdminManagementService, createDatabase, type ManagementActor, type OciImageResolver } from "@astra/database";

const adminApiUrl = process.env.ASTRA_TEST_ADMIN_API_URL;
const identityUrl = process.env.ASTRA_TEST_IDENTITY_URL;
const publicApiUrl = process.env.ASTRA_TEST_PUBLIC_API_URL;
const publicApiKey = process.env.ASTRA_TEST_PUBLIC_API_KEY;
const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const enabled = adminApiUrl && identityUrl && publicApiUrl && publicApiKey && databaseUrl;
const integrationTest = enabled ? test : test.skip;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;

afterAll(async () => {
  if (database) await database.client.end();
});

const issueToken = async (input: Record<string, unknown> = {}): Promise<string> => {
  const response = await fetch(`${identityUrl}/v1/id-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  return String(((await response.json()) as { id_token: string }).id_token);
};

const cookies = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");

const exchange = async (idToken: string) => {
  const response = await fetch(`${adminApiUrl}/admin/v1/sessions/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
    body: JSON.stringify({ organization_id: "org_local", project_id: "project_local" }),
  });
  return { response, cookie: cookies(response), body: (await response.json()) as { csrf_token?: string } };
};

const rolloutManifest = {
  worker_contract_version: "v1",
  modalities: ["video"],
  operations: ["generation", "edit"],
  capabilities: { durations: [4, 6, 10, 15] },
  parameter_schema: { type: "object", additionalProperties: false },
  output_contract: { media_types: ["video/mp4"], preserve_original_bytes: true },
  resource_requirements: { gpu_skus: ["rtx5090"], gpu_memory_bytes: 34359738368, concurrency: 1 },
  components: [{ name: "model-app", commit: "1234567" }],
  weights: [{ logical_name: "video-model", sha256: "b".repeat(64), size_bytes: 1 }],
};

const rolloutFixture = async (cookie: string) => {
  if (!database) throw new Error("test database unavailable");
  const sessionToken = cookie.match(/(?:^|; )astra_admin_session=([^;]+)/)?.[1];
  if (!sessionToken) throw new Error("admin session cookie unavailable");
  const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
  const sessions = await database.client`SELECT id, subject, organization_id, project_id FROM admin_sessions
    WHERE token_hash=${tokenHash} AND status='active'`;
  const session = sessions[0];
  if (!session) throw new Error("admin session unavailable");
  const actor: ManagementActor = {
    actorId: String(session.subject),
    sessionId: String(session.id),
    organizationId: String(session.organization_id),
    projectId: String(session.project_id),
  };
  const suffix = randomUUID().replaceAll("-", "");
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
  const management = new AdminManagementService(
    database.client,
    resolver,
    "http-rollout-audit-signing-key-at-least-32-bytes",
  );
  const request = { requestId: `req_rollout_${suffix}` };
  const model = await management.createModel(actor, request, `rollout-model-${suffix}`, {
    alias: `http-rollout-${suffix}`,
    modality: "video",
    description: "HTTP rollout contract",
    reason: "Create HTTP rollout contract model",
  });
  const source = await management.createRelease(actor, request, `rollout-source-${suffix}`, {
    model_id: String(model.body.id),
    source_image: "registry.invalid/astra/source:stable",
    workflow_hash: "1".repeat(64),
    maturity: "stable",
    manifest: rolloutManifest,
    reason: "Register HTTP rollout source image",
  });
  const target = await management.createRelease(actor, request, `rollout-target-${suffix}`, {
    model_id: String(model.body.id),
    source_image: "registry.invalid/astra/target:candidate",
    workflow_hash: "2".repeat(64),
    maturity: "candidate",
    manifest: rolloutManifest,
    reason: "Register HTTP rollout target image",
  });
  for (const [name, release] of [
    ["source", source],
    ["target", target],
  ] as const) {
    await management.approveRelease(actor, request, `rollout-approve-${name}-${suffix}`, String(release.body.id), {
      expected_version: 1,
      decision: "approve",
      reason: `Approve HTTP rollout ${name} image`,
    });
  }
  const provider = `reference_http_${suffix}`;
  const region = `region_http_${suffix}`;
  const run = `snapshot_http_${suffix}`;
  await database.client.begin(async (transaction) => {
    await transaction`INSERT INTO provider_regions (id, provider, name, status, created_at, updated_at)
      VALUES (${region}, ${provider}, 'HTTP Rollout Region', 'healthy', now(), now())`;
    await transaction`INSERT INTO provider_inventory (
        id, provider, region_id, gpu_sku, gpu_memory_bytes, available_replicas,
        price_per_gpu_hour_minor, currency, snapshot_version, observed_at, created_at
      ) VALUES (
        ${`inventory_http_${suffix}`}, ${provider}, ${region}, 'rtx5090', 34359738368, 10,
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
      ) VALUES (${provider}, ${run}, ${run}, 'fresh', now(), now() + interval '1 hour', 1, now())`;
  });
  const pool = await management.createPool(actor, request, `rollout-pool-${suffix}`, {
    release_id: String(source.body.id),
    provider,
    region_id: region,
    gpu_sku: "rtx5090",
    execution_mode: "deployment",
    reason: "Create HTTP rollout source pool",
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
    retry: {
      max_attempts: 3,
      initial_backoff_seconds: 5,
      max_backoff_seconds: 60,
      retryable_codes: ["worker_lost"],
    },
  };
  for (const [policyType, configuration] of Object.entries(configurations)) {
    const policy = await management.validatePolicy(actor, request, `rollout-policy-${policyType}-${suffix}`, {
      policy_type: policyType,
      pool_id: String(pool.body.id),
      configuration,
      reason: `Validate HTTP rollout ${policyType}`,
    });
    const preview = await management.previewPolicy(
      actor,
      request,
      `rollout-policy-preview-${policyType}-${suffix}`,
      String(policy.body.id),
      {
        expected_policy_version: Number(policy.body.version),
        horizon_seconds: 3600,
        reason: `Preview HTTP rollout ${policyType}`,
      },
    );
    await management.publishPolicy(
      actor,
      request,
      `rollout-policy-publish-${policyType}-${suffix}`,
      String(policy.body.id),
      {
        expected_policy_version: Number(policy.body.version),
        preview_id: String(preview.body.id),
        reason: `Publish HTTP rollout ${policyType}`,
      },
    );
  }
  await management.updatePool(actor, request, `rollout-pool-activate-${suffix}`, String(pool.body.id), {
    expected_version: 1,
    status: "active",
    reason: "Activate HTTP rollout source pool",
  });
  return { suffix, poolId: String(pool.body.id), targetReleaseId: String(target.body.id) };
};

describe("Admin API OIDC and session HTTP contract", () => {
  integrationTest("exchanges OIDC once, authenticates by cookie, enforces CSRF and revokes immediately", async () => {
    const idToken = await issueToken();
    const issued = await exchange(idToken);
    expect(issued.response.status).toBe(201);
    expect(issued.cookie).toContain("astra_admin_session=");
    expect(issued.cookie).toContain("astra_admin_csrf=");
    expect(issued.body.csrf_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await exchange(idToken)).response.status).toBe(401);

    const current = await fetch(`${adminApiUrl}/admin/v1/sessions/current`, { headers: { cookie: issued.cookie } });
    expect(current.status).toBe(200);
    expect(((await current.json()) as { permissions: string[] }).permissions).toContain("tasks:read_sensitive");

    const missingCsrf = await fetch(`${adminApiUrl}/admin/v1/sessions/current`, {
      method: "DELETE",
      headers: { cookie: issued.cookie },
    });
    expect(missingCsrf.status).toBe(403);
    const revoked = await fetch(`${adminApiUrl}/admin/v1/sessions/current`, {
      method: "DELETE",
      headers: { cookie: issued.cookie, "x-csrf-token": String(issued.body.csrf_token) },
    });
    expect(revoked.status).toBe(204);
    expect(
      (await fetch(`${adminApiUrl}/admin/v1/sessions/current`, { headers: { cookie: issued.cookie } })).status,
    ).toBe(401);
  });

  integrationTest("requires the intersected sensitive permission and records the access purpose", async () => {
    if (!database) throw new Error("test database unavailable");
    const taskResponse = await fetch(`${publicApiUrl}/v1/videos/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${publicApiKey}`,
        "content-type": "application/json",
        "idempotency-key": `admin-sensitive-${randomUUID()}`,
      },
      body: JSON.stringify({
        model: "local-reference-release",
        prompt: "sensitive audit contract",
        aspect_ratio: "16:9",
        resolution: "0.2mp",
        duration: 5,
      }),
    });
    expect(taskResponse.status).toBe(202);
    const taskId = String(((await taskResponse.json()) as { id: string }).id);
    const admin = await exchange(await issueToken());
    const purpose = "incident investigation integration test";
    const sensitive = await fetch(`${adminApiUrl}/admin/v1/tasks/${taskId}/sensitive-request`, {
      headers: { cookie: admin.cookie, "x-access-purpose": purpose },
    });
    expect(sensitive.status).toBe(200);
    expect(((await sensitive.json()) as { request: { prompt: string } }).request.prompt).toBe(
      "sensitive audit contract",
    );
    const audit = await database.client`SELECT purpose, outcome FROM audit_events
      WHERE action='task.sensitive_request.read' AND resource_id=${taskId}
      ORDER BY created_at DESC LIMIT 1`;
    expect(audit[0]).toEqual(expect.objectContaining({ purpose, outcome: "success" }));

    const suffix = randomUUID().replaceAll("-", "");
    const subject = `viewer_${suffix}`;
    await database.client`INSERT INTO organization_memberships (
      id, organization_id, subject_type, subject_id, role
    ) VALUES (${`orgmem_${suffix}`}, 'org_local', 'oidc_user', ${subject}, 'admin')`;
    await database.client`INSERT INTO project_memberships (
      id, organization_id, project_id, subject_type, subject_id, role
    ) VALUES (${`projmem_${suffix}`}, 'org_local', 'project_local', 'oidc_user', ${subject}, 'viewer')`;
    const viewer = await exchange(await issueToken({ subject, groups: [] }));
    expect(viewer.response.status).toBe(201);
    const denied = await fetch(`${adminApiUrl}/admin/v1/tasks/${taskId}/sensitive-request`, {
      headers: { cookie: viewer.cookie, "x-access-purpose": purpose },
    });
    expect(denied.status).toBe(403);
  });

  integrationTest("serves every read-only operations view and keeps normal task details non-sensitive", async () => {
    const admin = await exchange(await issueToken());
    expect(admin.response.status).toBe(201);
    const paths = [
      "models",
      "releases",
      "pools",
      "rollouts",
      "workers",
      "replicas",
      "provider-operations",
      "regions",
      "inventory",
      "audit-events",
      "aliases",
      "policies",
      "policy-previews",
      "release-approvals",
    ];
    for (const path of paths) {
      const response = await fetch(`${adminApiUrl}/admin/v1/${path}?limit=2`, { headers: { cookie: admin.cookie } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        expect.objectContaining({ object: "list", data: expect.any(Array), has_more: expect.any(Boolean) }),
      );
    }
    const tasks = await fetch(`${adminApiUrl}/admin/v1/tasks?limit=1`, { headers: { cookie: admin.cookie } });
    expect(tasks.status).toBe(200);
    const taskList = (await tasks.json()) as ListResponse;
    if (taskList.data[0]) {
      const detail = await fetch(`${adminApiUrl}/admin/v1/tasks/${String(taskList.data[0].id)}`, {
        headers: { cookie: admin.cookie },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("request");
      expect(body).not.toHaveProperty("request_ciphertext");
      expect(body).toEqual(expect.objectContaining({ timeline: expect.any(Array), attempts: expect.any(Array) }));
    }
    expect((await fetch(`${adminApiUrl}/admin/v1/cost-summary`, { headers: { cookie: admin.cookie } })).status).toBe(
      200,
    );
  });

  integrationTest("enforces CSRF, idempotency and version preconditions for Release management", async () => {
    const admin = await exchange(await issueToken());
    expect(admin.response.status).toBe(201);
    const suffix = randomUUID().replaceAll("-", "");
    const key = `create-model-${suffix}`;
    const modelBody = {
      alias: `managed-video-${suffix}`,
      modality: "video",
      description: "HTTP management contract",
      reason: "Create model through management contract",
    };
    const withoutCsrf = await fetch(`${adminApiUrl}/admin/v1/models`, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(modelBody),
    });
    expect(withoutCsrf.status).toBe(403);
    const headers = {
      cookie: admin.cookie,
      "content-type": "application/json",
      "x-csrf-token": String(admin.body.csrf_token),
    };
    const created = await fetch(`${adminApiUrl}/admin/v1/models`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
      body: JSON.stringify(modelBody),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("idempotency-replayed")).toBe("false");
    const model = (await created.json()) as { id: string; alias: string };
    const replay = await fetch(`${adminApiUrl}/admin/v1/models`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
      body: JSON.stringify(modelBody),
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(((await replay.json()) as { id: string }).id).toBe(model.id);

    const failedPrecondition = await fetch(`${adminApiUrl}/admin/v1/models/${model.id}`, {
      method: "PATCH",
      headers: { ...headers, "idempotency-key": `update-model-${suffix}`, "if-match": '"2"' },
      body: JSON.stringify({
        expected_version: 1,
        status: "active",
        description: "changed",
        reason: "Update model description",
      }),
    });
    expect(failedPrecondition.status).toBe(409);

    const release = await fetch(`${adminApiUrl}/admin/v1/releases`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": `release-${suffix}` },
      body: JSON.stringify({
        model_id: model.id,
        source_image: "registry-reference:5000/astra/model-app:local",
        workflow_hash: "a".repeat(64),
        maturity: "candidate",
        manifest: {
          worker_contract_version: "v1",
          modalities: ["video"],
          operations: ["generation"],
          capabilities: { durations: [15] },
          parameter_schema: { type: "object", additionalProperties: false },
          output_contract: { media_types: ["video/mp4"], preserve_original_bytes: true },
          resource_requirements: { gpu_skus: ["rtx5090"], gpu_memory_bytes: 34359738368, concurrency: 1 },
          components: [{ name: "model-app", commit: "1234567" }],
          weights: [{ logical_name: "video-model", sha256: "b".repeat(64), size_bytes: 1 }],
        },
        reason: "Resolve and register candidate image",
      }),
    });
    expect(release.status).toBe(201);
    const releaseBody = (await release.json()) as {
      id: string;
      source_image: string;
      image_digest: string;
      status: string;
    };
    expect(releaseBody.source_image).toBe("registry-reference:5000/astra/model-app:local");
    expect(releaseBody.image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(releaseBody.status).toBe("draft");
    const approval = await fetch(`${adminApiUrl}/admin/v1/releases/${releaseBody.id}/approval`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": `approve-${suffix}`, "if-match": '"1"' },
      body: JSON.stringify({ expected_version: 1, decision: "approve", reason: "Approve verified contract image" }),
    });
    expect(approval.status).toBe(200);
    expect(await approval.json()).toEqual(
      expect.objectContaining({ id: releaseBody.id, status: "approved", version: 2 }),
    );
  });

  integrationTest("controls a digest-pinned rollout through the authenticated HTTP boundary", async () => {
    if (!database) throw new Error("test database unavailable");
    const admin = await exchange(await issueToken());
    expect(admin.response.status).toBe(201);
    const fixture = await rolloutFixture(admin.cookie);
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
    const previewBody = {
      release_id: fixture.targetReleaseId,
      pool_id: fixture.poolId,
      expected_pool_version: 2,
      strategy,
      reason: "Preview rollout through authenticated HTTP boundary",
    };
    const baseHeaders = {
      cookie: admin.cookie,
      "content-type": "application/json",
      "x-csrf-token": String(admin.body.csrf_token),
    };

    const withoutCsrf = await fetch(`${adminApiUrl}/admin/v1/rollouts/preview`, {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/json",
        "idempotency-key": `rollout-no-csrf-${fixture.suffix}`,
        "if-match": '"2"',
      },
      body: JSON.stringify(previewBody),
    });
    expect(withoutCsrf.status).toBe(403);

    const viewerSubject = `rollout_viewer_${fixture.suffix}`;
    await database.client`INSERT INTO organization_memberships (
      id, organization_id, subject_type, subject_id, role
    ) VALUES (${`orgmem_rollout_${fixture.suffix}`}, 'org_local', 'oidc_user', ${viewerSubject}, 'viewer')`;
    await database.client`INSERT INTO project_memberships (
      id, organization_id, project_id, subject_type, subject_id, role
    ) VALUES (${`projmem_rollout_${fixture.suffix}`}, 'org_local', 'project_local', 'oidc_user', ${viewerSubject}, 'viewer')`;
    const viewer = await exchange(await issueToken({ subject: viewerSubject, groups: [] }));
    expect(viewer.response.status).toBe(201);
    const forbidden = await fetch(`${adminApiUrl}/admin/v1/rollouts/preview`, {
      method: "POST",
      headers: {
        cookie: viewer.cookie,
        "content-type": "application/json",
        "x-csrf-token": String(viewer.body.csrf_token),
        "idempotency-key": `rollout-viewer-${fixture.suffix}`,
        "if-match": '"2"',
      },
      body: JSON.stringify(previewBody),
    });
    expect(forbidden.status).toBe(403);

    const wrongVersion = await fetch(`${adminApiUrl}/admin/v1/rollouts/preview`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "idempotency-key": `rollout-wrong-version-${fixture.suffix}`,
        "if-match": '"1"',
      },
      body: JSON.stringify(previewBody),
    });
    expect(wrongVersion.status).toBe(409);
    expect(((await wrongVersion.json()) as { error: { code: string } }).error.code).toBe("version_precondition_failed");

    const previewKey = `rollout-preview-http-${fixture.suffix}`;
    const preview = await fetch(`${adminApiUrl}/admin/v1/rollouts/preview`, {
      method: "POST",
      headers: { ...baseHeaders, "idempotency-key": previewKey, "if-match": '"2"' },
      body: JSON.stringify(previewBody),
    });
    expect(preview.status).toBe(201);
    expect(preview.headers.get("idempotency-replayed")).toBe("false");
    const previewResult = (await preview.json()) as { id: string; impact: { estimated_extra_cost_minor: number } };
    expect(previewResult.impact.estimated_extra_cost_minor).toBe(600);
    const previewReplay = await fetch(`${adminApiUrl}/admin/v1/rollouts/preview`, {
      method: "POST",
      headers: { ...baseHeaders, "idempotency-key": previewKey, "if-match": '"2"' },
      body: JSON.stringify(previewBody),
    });
    expect(previewReplay.status).toBe(201);
    expect(previewReplay.headers.get("idempotency-replayed")).toBe("true");
    expect(((await previewReplay.json()) as { id: string }).id).toBe(previewResult.id);

    const createBody = {
      release_id: fixture.targetReleaseId,
      pool_id: fixture.poolId,
      preview_id: previewResult.id,
      expected_pool_version: 2,
      reason: "Start rollout through authenticated HTTP boundary",
    };
    const createKey = `rollout-create-http-${fixture.suffix}`;
    const created = await fetch(`${adminApiUrl}/admin/v1/rollouts`, {
      method: "POST",
      headers: { ...baseHeaders, "idempotency-key": createKey, "if-match": '"2"' },
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(202);
    const rollout = (await created.json()) as { id: string; status: string; version: number };
    expect(rollout).toEqual(expect.objectContaining({ status: "pending", version: 1 }));
    const createReplay = await fetch(`${adminApiUrl}/admin/v1/rollouts`, {
      method: "POST",
      headers: { ...baseHeaders, "idempotency-key": createKey, "if-match": '"2"' },
      body: JSON.stringify(createBody),
    });
    expect(createReplay.status).toBe(202);
    expect(createReplay.headers.get("idempotency-replayed")).toBe("true");
    expect(((await createReplay.json()) as { id: string }).id).toBe(rollout.id);

    const detail = await fetch(`${adminApiUrl}/admin/v1/rollouts/${rollout.id}`, {
      headers: { cookie: admin.cookie },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(
      expect.objectContaining({
        id: rollout.id,
        source_release_id: expect.any(String),
        target_release_id: fixture.targetReleaseId,
        steps: expect.any(Array),
        timeline: expect.any(Array),
        replicas: expect.any(Array),
        provider_operations: expect.any(Array),
      }),
    );

    const control = async (action: "pause" | "resume" | "rollback", version: number) => {
      const response = await fetch(`${adminApiUrl}/admin/v1/rollouts/${rollout.id}/${action}`, {
        method: "POST",
        headers: {
          ...baseHeaders,
          "idempotency-key": `rollout-${action}-http-${fixture.suffix}`,
          "if-match": `"${String(version)}"`,
        },
        body: JSON.stringify({
          expected_version: version,
          reason: `${action} rollout through authenticated HTTP boundary`,
        }),
      });
      return { response, body: (await response.json()) as { status: string; version: number; direction?: string } };
    };
    const paused = await control("pause", 1);
    expect(paused.response.status).toBe(200);
    expect(paused.body).toEqual(expect.objectContaining({ status: "paused", version: 2 }));
    const resumed = await control("resume", 2);
    expect(resumed.response.status).toBe(200);
    expect(resumed.body).toEqual(expect.objectContaining({ status: "pending", version: 3 }));
    const rolledBack = await control("rollback", 3);
    expect(rolledBack.response.status).toBe(202);
    expect(rolledBack.body).toEqual(
      expect.objectContaining({ status: "rolling_back", direction: "rollback", version: 4 }),
    );
  });
});

type ListResponse = { data: Array<Record<string, unknown>> };
