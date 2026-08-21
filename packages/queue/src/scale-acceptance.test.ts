import { describe, expect, test } from "bun:test";
import { planCapacity, planDeterministicAssignments, type DispatchableReplica } from "./index.ts";

const schedulingDefaults = {
  predictionP95Seconds: 1200,
  predictionSource: "cold_baseline" as const,
  projectWeight: 100,
  virtualGpuMilliseconds: 0,
  batchMinSharePercent: 10,
  agingSeconds: 1800,
  laneAssignedGpuSeconds: { online: 0, batch: 0 },
};

const replicas: readonly DispatchableReplica[] = Array.from({ length: 256 }, (_, index) => ({
  replicaId: `replica_${String(index).padStart(3, "0")}`,
  replicaVersion: 1,
  poolId: "pool_scale",
  releaseId: "release_image_and_video",
  workerId: `worker_${String(index).padStart(3, "0")}`,
  regionId: index % 2 === 0 ? "region_a" : "region_b",
  gpuSku: "reference-gpu",
  maximumConcurrency: 1,
  occupiedSlots: [],
  policyVersion: "capacity-v1",
}));

const capacityReplicas = replicas.map((replica) => ({
  replicaId: replica.replicaId,
  regionId: replica.regionId,
  gpuSku: replica.gpuSku,
  maximumConcurrency: replica.maximumConcurrency,
  runningSlots: 0,
  reservedSlots: 0,
  rolloutOwned: false,
  draining: false,
}));

const tasks = Array.from({ length: 300 }, (_, index) => ({
  taskId: `task_${String(index).padStart(3, "0")}`,
  projectId: `project_${index % 6}`,
  releaseId: "release_image_and_video",
  taskVersion: 0,
  lane: index % 5 === 0 ? ("batch" as const) : ("online" as const),
  createdAt: new Date(Date.UTC(2026, 7, 22, 0, 0, index)).toISOString(),
  expectedGpuSeconds: 240 + (index % 4) * 180,
  ...schedulingDefaults,
}));

describe("scale acceptance without model weights", () => {
  test("assigns 300 mixed image/video tasks across 256 single-slot replicas exactly once", () => {
    const observedAt = new Date("2026-08-22T01:00:00.000Z");
    const first = planDeterministicAssignments(tasks, replicas, observedAt);
    const second = planDeterministicAssignments([...tasks].reverse(), [...replicas].reverse(), observedAt);

    expect(first).toEqual(second);
    expect(first).toHaveLength(256);
    expect(new Set(first.map((assignment) => assignment.task.taskId)).size).toBe(first.length);
    expect(new Set(first.map((assignment) => `${assignment.replica.replicaId}:${assignment.slotIndex}`)).size).toBe(
      first.length,
    );
  });

  test("keeps the capacity decision bounded and deterministic for a mixed 4-15 second workload", () => {
    const snapshot = {
      now: new Date("2026-08-22T01:00:00.000Z"),
      currentReadyReplicas: 128,
      currentDesiredReplicas: 128,
      observedUtilizationPercent: 80,
      queue: tasks.map((task) => ({
        taskId: task.taskId,
        projectId: task.projectId,
        lane: task.lane,
        predictedGpuSeconds: task.expectedGpuSeconds,
      })),
      running: Array.from({ length: 128 }, (_, index) => ({
        attemptId: `attempt_${index}`,
        remainingGpuSeconds: 600 + (index % 5) * 120,
      })),
      arrivalGpuSecondsPerSecondP75: 0.4,
      approvedMaxConcurrency: 1,
      replicaGpuSku: "reference-gpu",
      replicaProvider: "reference",
      offers: [
        {
          provider: "reference",
          regionId: "region_a",
          gpuSku: "reference-gpu",
          availableReplicas: 512,
          pricePerGpuHourMinor: 300,
          coldStartSeconds: 120,
          failureRateBasisPoints: 10,
          transferCostMinorPerTask: 1,
          healthy: true,
          snapshotFresh: true,
        },
      ],
      budgetRemainingMinor: 10_000_000,
      rolloutInProgress: false,
      replicas: capacityReplicas,
    } as const;
    const policy = {
      mode: "automatic" as const,
      minReplicas: 1,
      maxReplicas: 512,
      queueTargetSeconds: 900,
      maxQueueEtaSeconds: 7200,
      backlogDrainSeconds: 3600,
      targetUtilizationPercent: 75,
      scaleUpStep: 64,
      emergencyScaleUpStep: 128,
      scaleDownStepPercent: 10,
      idleWindowSeconds: 900,
      scaleDownObservationSeconds: 900,
      scaleDownCooldownSeconds: 1200,
      scaleUpCooldownSeconds: 60,
      hysteresisPercent: 10,
      scaleDownSafetyMarginPercent: 25,
      minHoldSeconds: 1800,
      provisioningP90Seconds: 300,
      minNetBenefitMinor: 0,
      minNetSavingMinor: 0,
      waitValueMinorPerMinute: 100,
      sloPenaltyMinorPerMinute: 100,
      batchMinSharePercent: 10,
    };
    const decision = planCapacity(snapshot, policy);
    expect(decision.desiredReplicas).toBeGreaterThanOrEqual(1);
    expect(decision.desiredReplicas).toBeLessThanOrEqual(512);
    expect(decision.queueEtaSeconds).toBeGreaterThanOrEqual(0);
    expect(decision.placement?.gpuSku).toBe("reference-gpu");
  });
});
