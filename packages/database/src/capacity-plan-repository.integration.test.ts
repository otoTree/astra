import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase, CapacityPlanRepository } from "./index.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integrationTest = database ? test : test.skip;

afterAll(async () => {
  await database?.client.end();
});

describe("CapacityPlanRepository PostgreSQL contract", () => {
  integrationTest("records an immutable capacity decision with suppression and admission explanation", async () => {
    if (!database) throw new Error("test_database_unavailable");
    const suffix = randomUUID().replaceAll("-", "");
    const repository = new CapacityPlanRepository(database.client, () => new Date("2026-08-22T03:00:00.000Z"));
    const planId = await repository.record({
      snapshot: {
        projectId: "project_local",
        poolId: "pool_local_reference",
        provider: "reference",
        regionId: "region_local",
        gpuSku: "reference-gpu",
        policy: { mode: "automatic" },
        currentReadyReplicas: 1,
        currentDesiredReplicas: 1,
        approvedMaxConcurrency: 1,
        queue: [],
        running: [],
        replicas: [],
        offers: [],
      },
      result: {
        desired_replicas: 1,
        workload_replicas: 2,
        queue_slo_replicas: 2,
        cost_minor: 0,
        benefit_minor: 0,
        net_benefit_minor: 0,
        admission_control: true,
        suppressed_by: "inventory",
        marker: suffix,
      },
      status: "admission_control",
      strategyVersion: "capacity-v1",
    });
    const row = await database.client`SELECT status, desired_replicas, admission_control, result
      FROM capacity_plans WHERE id=${planId}`;
    expect(row[0]).toMatchObject({ status: "admission_control", desired_replicas: 1, admission_control: true });
    let guard = "";
    try {
      await database.client`UPDATE capacity_plans SET result='{}'::jsonb WHERE id=${planId}`;
    } catch (error) {
      guard = error instanceof Error ? error.message : String(error);
    }
    expect(guard).toContain("immutable_capacity_plan");
  });
});
