import { describe, expect, test } from "bun:test";
import { planDeterministicAssignments, type DispatchableReplica } from "./index.ts";

const scheduling = {
  expectedGpuSeconds: 60,
  predictionP95Seconds: 90,
  predictionSource: "cold_baseline" as const,
  projectWeight: 100,
  virtualGpuMilliseconds: 0,
  batchMinSharePercent: 0,
  agingSeconds: 1800,
  laneAssignedGpuSeconds: { online: 0, batch: 0 },
};

const replicas: readonly DispatchableReplica[] = [
  {
    replicaId: "replica_b",
    replicaVersion: 2,
    poolId: "pool_a",
    releaseId: "release_a",
    workerId: "worker_b",
    regionId: "region_b",
    gpuSku: "rtx5090",
    maximumConcurrency: 2,
    occupiedSlots: [0],
    policyVersion: "baseline-v1",
  },
  {
    replicaId: "replica_a",
    replicaVersion: 1,
    poolId: "pool_a",
    releaseId: "release_a",
    workerId: "worker_a",
    regionId: "region_a",
    gpuSku: "rtx5090",
    maximumConcurrency: 1,
    occupiedSlots: [],
    policyVersion: "baseline-v1",
  },
];

describe("deterministic phase-6 scheduling", () => {
  test("uses stable lane, age and placement ordering without counting reservations as throughput", () => {
    const tasks = [
      {
        taskId: "task_batch",
        projectId: "project_a",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "batch" as const,
        createdAt: "2026-08-21T00:00:00.000Z",
        ...scheduling,
      },
      {
        taskId: "task_online_late",
        projectId: "project_a",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "online" as const,
        createdAt: "2026-08-21T00:00:02.000Z",
        ...scheduling,
      },
      {
        taskId: "task_online_early",
        projectId: "project_a",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "online" as const,
        createdAt: "2026-08-21T00:00:01.000Z",
        ...scheduling,
      },
    ];
    const first = planDeterministicAssignments(tasks, replicas);
    const second = planDeterministicAssignments([...tasks].reverse(), [...replicas].reverse());
    expect(second).toEqual(first);
    expect(first.map((assignment) => assignment.task.taskId)).toEqual(["task_online_early", "task_online_late"]);
    expect(first.map((assignment) => [assignment.replica.replicaId, assignment.slotIndex])).toEqual([
      ["replica_a", 0],
      ["replica_b", 1],
    ]);
  });

  test("never assigns a task to another release or beyond approved concurrency", () => {
    const assignments = planDeterministicAssignments(
      [
        {
          taskId: "task_other",
          projectId: "project_a",
          releaseId: "release_other",
          taskVersion: 0,
          lane: "online",
          createdAt: "2026-08-21T00:00:00.000Z",
          ...scheduling,
        },
      ],
      replicas,
    );
    expect(assignments).toHaveLength(0);
  });

  test("preserves a batch floor and charges projects by predicted GPU time divided by weight", () => {
    const advancedReplicas = replicas.map((replica) => ({ ...replica, maximumConcurrency: 2, occupiedSlots: [] }));
    const tasks = [
      {
        taskId: "task_online_a_long",
        projectId: "project_a",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "online" as const,
        createdAt: "2026-08-22T00:00:01.000Z",
        ...scheduling,
        expectedGpuSeconds: 900,
        batchMinSharePercent: 20,
      },
      {
        taskId: "task_online_b_short",
        projectId: "project_b",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "online" as const,
        createdAt: "2026-08-22T00:00:02.000Z",
        ...scheduling,
        expectedGpuSeconds: 120,
        projectWeight: 200,
        batchMinSharePercent: 20,
      },
      {
        taskId: "task_batch_floor",
        projectId: "project_c",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "batch" as const,
        createdAt: "2026-08-22T00:00:00.000Z",
        ...scheduling,
        expectedGpuSeconds: 300,
        batchMinSharePercent: 20,
      },
    ];
    const assignments = planDeterministicAssignments(tasks, advancedReplicas, new Date("2026-08-22T00:01:00.000Z"));
    expect(assignments.map((assignment) => assignment.task.taskId)).toEqual([
      "task_online_b_short",
      "task_batch_floor",
      "task_online_a_long",
    ]);
    expect(assignments[1]?.reason).toBe("batch_minimum_share");
  });

  test("ages a long task ahead of newer short work without changing deterministic output", () => {
    const oneSlot = replicas.slice(0, 1).map((replica) => ({ ...replica, maximumConcurrency: 1, occupiedSlots: [] }));
    const tasks = [
      {
        taskId: "task_old_long",
        projectId: "project_a",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "online" as const,
        createdAt: "2026-08-22T00:00:00.000Z",
        ...scheduling,
        expectedGpuSeconds: 900,
        agingSeconds: 60,
      },
      {
        taskId: "task_new_short",
        projectId: "project_a",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "online" as const,
        createdAt: "2026-08-22T00:15:30.000Z",
        ...scheduling,
        expectedGpuSeconds: 60,
        agingSeconds: 60,
      },
    ];
    const assignments = planDeterministicAssignments(tasks, oneSlot, new Date("2026-08-22T00:16:00.000Z"));
    expect(assignments[0]?.task.taskId).toBe("task_old_long");
    expect(assignments[0]?.reason).toBe("aged_shortest_job");
  });
});
