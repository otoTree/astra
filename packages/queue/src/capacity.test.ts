import { describe, expect, test } from "bun:test";
import { planCapacity, simulateQueue, type CapacityPolicy, type CapacitySnapshot } from "./capacity.ts";

const policy: CapacityPolicy = {
  mode: "automatic",
  minReplicas: 1,
  maxReplicas: 20,
  queueTargetSeconds: 120,
  maxQueueEtaSeconds: 900,
  backlogDrainSeconds: 1800,
  targetUtilizationPercent: 75,
  scaleUpStep: 2,
  emergencyScaleUpStep: 10,
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
  waitValueMinorPerMinute: 10,
  sloPenaltyMinorPerMinute: 20,
  batchMinSharePercent: 10,
};

const snapshot = (overrides: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({
  now: new Date("2026-08-22T00:00:00.000Z"),
  currentReadyReplicas: 1,
  currentDesiredReplicas: 1,
  observedUtilizationPercent: 100,
  queue: [
    { taskId: "short", projectId: "p1", lane: "online", predictedGpuSeconds: 840 },
    { taskId: "long", projectId: "p2", lane: "batch", predictedGpuSeconds: 1800 },
  ],
  running: [],
  arrivalGpuSecondsPerSecondP75: 0,
  approvedMaxConcurrency: 1,
  replicaGpuSku: "rtx5090",
  replicaProvider: "reference",
  offers: [
    {
      provider: "reference",
      regionId: "region_a",
      gpuSku: "rtx5090",
      availableReplicas: 20,
      pricePerGpuHourMinor: 300,
      coldStartSeconds: 120,
      failureRateBasisPoints: 50,
      transferCostMinorPerTask: 10,
      healthy: true,
      snapshotFresh: true,
    },
  ],
  budgetRemainingMinor: 100_000,
  rolloutInProgress: false,
  replicas: [],
  ...overrides,
});

describe("capacity planning", () => {
  test("simulates queue waits from running service time and returns a deterministic P95", () => {
    const result = simulateQueue(
      2,
      1,
      [{ attemptId: "running", remainingGpuSeconds: 60 }],
      [
        { taskId: "a", projectId: "p", lane: "online", predictedGpuSeconds: 30 },
        { taskId: "b", projectId: "p", lane: "online", predictedGpuSeconds: 90 },
      ],
    );
    expect(result.waits).toEqual([0, 30]);
    expect(result.p95WaitSeconds).toBe(30);
    expect(result.drainSeconds).toBe(120);
  });

  test("scales a 4-15 second mixed workload by GPU work, not output duration", () => {
    const result = planCapacity(snapshot(), policy);
    expect(result.workloadReplicas).toBeGreaterThan(1);
    expect(result.queueSloReplicas).toBeGreaterThan(1);
    expect(result.desiredReplicas).toBe(2);
    expect(result.placement?.regionId).toBe("region_a");
    expect(result.admissionControl).toBe(false);
  });

  test("selects an allowed cross-provider region when it is cheaper and faster", () => {
    const result = planCapacity(
      snapshot({
        offers: [
          {
            provider: "reference",
            regionId: "region_a",
            gpuSku: "rtx5090",
            availableReplicas: 20,
            pricePerGpuHourMinor: 500,
            coldStartSeconds: 600,
            failureRateBasisPoints: 300,
            transferCostMinorPerTask: 50,
            healthy: true,
            snapshotFresh: true,
          },
          {
            provider: "gongji",
            regionId: "region_b",
            gpuSku: "rtx5090",
            availableReplicas: 20,
            pricePerGpuHourMinor: 250,
            coldStartSeconds: 90,
            failureRateBasisPoints: 25,
            transferCostMinorPerTask: 5,
            healthy: true,
            snapshotFresh: true,
          },
        ],
      }),
      {
        ...policy,
        allowedProviders: ["gongji"],
        allowedRegions: ["region_b"],
        maxPricePerGpuHourMinor: 300,
      },
    );

    expect(result.placement?.provider).toBe("gongji");
    expect(result.placement?.regionId).toBe("region_b");
    expect(result.placement?.reasons).toContain("provider_policy_filtered");
    expect(result.placement?.reasons).toContain("price_policy_filtered");
    expect(result.placement?.reasons).toContain("region_policy_filtered");
  });

  test("applies placement weights from the capacity decision", () => {
    const result = planCapacity(
      snapshot({
        offers: [
          {
            provider: "reference",
            regionId: "region_a",
            gpuSku: "rtx5090",
            availableReplicas: 20,
            pricePerGpuHourMinor: 200,
            coldStartSeconds: 900,
            failureRateBasisPoints: 100,
            transferCostMinorPerTask: 1,
            healthy: true,
            snapshotFresh: true,
          },
          {
            provider: "gongji",
            regionId: "region_b",
            gpuSku: "rtx5090",
            availableReplicas: 20,
            pricePerGpuHourMinor: 600,
            coldStartSeconds: 30,
            failureRateBasisPoints: 20,
            transferCostMinorPerTask: 1,
            healthy: true,
            snapshotFresh: true,
          },
        ],
      }),
      {
        ...policy,
        allowedProviders: ["reference", "gongji"],
        allowedRegions: ["region_a", "region_b"],
        placementCompletionWeight: 100,
        placementCostWeight: 0,
        placementFailureWeight: 0,
        placementColdStartWeight: 0,
        placementTransferWeight: 0,
      },
    );

    expect(result.placement?.provider).toBe("gongji");
  });

  test("suppresses expansion on stale inventory, budget, or rollout and never drains busy replicas", () => {
    expect(planCapacity(snapshot({ offers: [], currentDesiredReplicas: 1 }), policy).suppressedBy).toBe("inventory");
    expect(planCapacity(snapshot({ budgetRemainingMinor: 1, currentDesiredReplicas: 1 }), policy).suppressedBy).toBe(
      "budget",
    );
    const now = new Date("2026-08-22T00:00:00.000Z");
    const result = planCapacity(
      snapshot({
        currentReadyReplicas: 10,
        currentDesiredReplicas: 10,
        queue: [],
        rolloutInProgress: false,
        replicas: Array.from({ length: 10 }, (_, index) => ({
          replicaId: `r${index}`,
          regionId: "region_a",
          gpuSku: "rtx5090",
          maximumConcurrency: 1,
          runningSlots: index === 0 ? 1 : 0,
          reservedSlots: 0,
          idleSince: new Date(now.getTime() - 3600_000),
          readyAt: new Date(now.getTime() - 3600_000),
          lastScaleActionAt: new Date(now.getTime() - 3600_000),
          rolloutOwned: false,
          draining: false,
        })),
      }),
      policy,
    );
    expect(result.drainReplicaIds).not.toContain("r0");
  });
});
