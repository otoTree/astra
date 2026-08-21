import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AdminQueryService, createDatabase } from "./index.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integrationTest = database ? test : test.skip;

afterAll(async () => {
  if (database) await database.client.end();
});

async function fixture() {
  if (!database) throw new Error("test database unavailable");
  const suffix = randomUUID().replaceAll("-", "");
  const organizationId = `org_${suffix}`;
  const projectId = `project_${suffix}`;
  const foreignOrganizationId = `org_foreign_${suffix}`;
  const foreignProjectId = `project_foreign_${suffix}`;
  await database.client.begin(async (transaction) => {
    await transaction`INSERT INTO organizations (id, name, status) VALUES
      (${organizationId}, ${suffix}, 'active'), (${foreignOrganizationId}, ${`foreign-${suffix}`}, 'active')`;
    await transaction`INSERT INTO projects (id, organization_id, name, status) VALUES
      (${projectId}, ${organizationId}, ${suffix}, 'active'),
      (${foreignProjectId}, ${foreignOrganizationId}, ${`foreign-${suffix}`}, 'active')`;
    for (const [index, selectedProject] of [projectId, projectId, projectId, foreignProjectId].entries()) {
      const taskId = `task_admin_${index}_${suffix}`;
      const createdAt = new Date(Date.now() - index * 1_000).toISOString();
      await transaction`INSERT INTO tasks (
        id, project_id, type, operation, status, priority, model_release_id,
        request_ciphertext, request_hash, version, created_at, updated_at
      ) VALUES (
        ${taskId}, ${selectedProject}, 'video', 'generation', 'queued', 'online',
        'release_local_reference', 'encrypted-test-value', ${"a".repeat(64)}, 0, ${createdAt}, ${createdAt}
      )`;
      await transaction`INSERT INTO task_state_events (id, task_id, from_status, to_status, version, created_at)
        VALUES (${`event_${index}_${suffix}`}, ${taskId}, NULL, 'queued', 0, ${createdAt})`;
    }
  });
  return { organizationId, projectId, foreignOrganizationId, foreignProjectId, suffix };
}

describe("AdminQueryService PostgreSQL contract", () => {
  integrationTest("isolates projects, paginates stably and binds cursors to a resource", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await fixture();
    const service = new AdminQueryService(database.client, "admin-query-integration-key-at-least-32-bytes");
    const first = await service.listTasks(context, { limit: 1 });
    expect(first.data).toHaveLength(1);
    expect(first.has_more).toBe(true);
    expect(first.next_after).toBeString();
    const second = await service.listTasks(context, { limit: 2, after: String(first.next_after) });
    expect(second.data).toHaveLength(2);
    expect(new Set([...first.data, ...second.data].map((row) => row.id)).size).toBe(3);
    expect([...first.data, ...second.data].every((row) => row.project_id === context.projectId)).toBe(true);
    await expect(service.list(context, "models", { limit: 1, after: String(first.next_after) })).rejects.toThrow(
      "invalid_cursor",
    );
  });

  integrationTest("returns an operational timeline without exposing encrypted request material", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await fixture();
    const service = new AdminQueryService(database.client, "admin-query-integration-key-at-least-32-bytes");
    const list = await service.listTasks(context, { limit: 1 });
    const detail = await service.taskDetail(context, String(list.data[0]?.id));
    expect(detail).toBeDefined();
    expect(detail).not.toHaveProperty("request_ciphertext");
    expect(detail).not.toHaveProperty("request");
    expect(detail?.timeline).toEqual([expect.objectContaining({ to_status: "queued", version: 0 })]);
    expect(await service.taskDetail(context, `task_admin_3_${context.suffix}`)).toBeUndefined();
  });

  integrationTest("uses the bounded project cursor index for task lists", async () => {
    if (!database) throw new Error("test database unavailable");
    const context = await fixture();
    const plan = await database.client.begin(async (transaction) => {
      await transaction`SET LOCAL enable_seqscan = off`;
      return transaction`EXPLAIN (FORMAT TEXT) SELECT id FROM tasks
        WHERE project_id=${context.projectId} ORDER BY created_at DESC, id DESC LIMIT 50`;
    });
    expect(plan.map((row) => String(row["QUERY PLAN"])).join("\n")).toContain("tasks_project_created_idx");
  });
});
