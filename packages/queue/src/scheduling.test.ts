import { describe, expect, test } from "bun:test";
import { planDeterministicAssignments, type DispatchableReplica } from "./index.ts";

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
      },
      {
        taskId: "task_online_late",
        projectId: "project_a",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "online" as const,
        createdAt: "2026-08-21T00:00:02.000Z",
      },
      {
        taskId: "task_online_early",
        projectId: "project_a",
        releaseId: "release_a",
        taskVersion: 0,
        lane: "online" as const,
        createdAt: "2026-08-21T00:00:01.000Z",
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
        },
      ],
      replicas,
    );
    expect(assignments).toHaveLength(0);
  });
});
