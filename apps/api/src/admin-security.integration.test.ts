import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@astra/database";

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
});

type ListResponse = { data: Array<Record<string, unknown>> };
