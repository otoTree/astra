import type { CapacityPlanRepository } from "@astra/database";
import { planCapacity, type CapacityPolicy, type CapacitySnapshot } from "@astra/queue";

const policyFromDatabase = (value: Record<string, unknown>): CapacityPolicy => ({
  mode: value.mode === "protected" || value.mode === "manual" ? value.mode : "automatic",
  minReplicas: Math.max(0, Number(value.min_replicas ?? 1)),
  maxReplicas: Math.max(1, Number(value.max_replicas ?? 1)),
  ...(value.manual_replicas === undefined ? {} : { manualReplicas: Math.max(0, Number(value.manual_replicas)) }),
  queueTargetSeconds: Math.max(1, Number(value.queue_target_seconds ?? 120)),
  maxQueueEtaSeconds: Math.max(1, Number(value.max_queue_eta_seconds ?? 900)),
  backlogDrainSeconds: Math.max(1, Number(value.backlog_drain_seconds ?? 1800)),
  targetUtilizationPercent: Math.min(100, Math.max(1, Number(value.target_utilization_percent ?? 75))),
  scaleUpStep: Math.max(1, Number(value.scale_up_step ?? 1)),
  emergencyScaleUpStep: Math.max(1, Number(value.emergency_scale_up_step ?? 10)),
  scaleDownStepPercent: Math.min(100, Math.max(1, Number(value.scale_down_step_percent ?? 10))),
  idleWindowSeconds: Math.max(60, Number(value.idle_window_seconds ?? 900)),
  scaleDownObservationSeconds: Math.max(60, Number(value.scale_down_observation_seconds ?? 900)),
  scaleDownCooldownSeconds: Math.max(60, Number(value.scale_down_cooldown_seconds ?? 1200)),
  scaleUpCooldownSeconds: Math.max(1, Number(value.scale_up_cooldown_seconds ?? 60)),
  hysteresisPercent: Math.min(100, Math.max(0, Number(value.hysteresis_percent ?? 10))),
  scaleDownSafetyMarginPercent: Math.min(100, Math.max(0, Number(value.scale_down_safety_margin_percent ?? 25))),
  minHoldSeconds: Math.max(60, Number(value.min_hold_seconds ?? 1800)),
  provisioningP90Seconds: Math.max(1, Number(value.provisioning_p90_seconds ?? 300)),
  minNetBenefitMinor: Math.max(0, Number(value.min_net_benefit_minor ?? 0)),
  minNetSavingMinor: Math.max(0, Number(value.min_net_saving_minor ?? 0)),
  waitValueMinorPerMinute: Math.max(0, Number(value.wait_value_minor_per_minute ?? 0)),
  sloPenaltyMinorPerMinute: Math.max(0, Number(value.slo_penalty_minor_per_minute ?? 0)),
  batchMinSharePercent: Math.min(100, Math.max(0, Number(value.batch_min_share_percent ?? 10))),
  ...(Array.isArray(value.allowed_providers)
    ? { allowedProviders: value.allowed_providers.filter((item): item is string => typeof item === "string") }
    : {}),
  ...(Array.isArray(value.allowed_regions)
    ? { allowedRegions: value.allowed_regions.filter((item): item is string => typeof item === "string") }
    : {}),
  ...(value.max_price_per_gpu_hour_minor === undefined
    ? {}
    : { maxPricePerGpuHourMinor: Math.max(0, Number(value.max_price_per_gpu_hour_minor)) }),
  ...(value.completion_weight === undefined
    ? {}
    : { placementCompletionWeight: Math.max(0, Number(value.completion_weight)) }),
  ...(value.cost_weight === undefined ? {} : { placementCostWeight: Math.max(0, Number(value.cost_weight)) }),
  ...(value.failure_weight === undefined ? {} : { placementFailureWeight: Math.max(0, Number(value.failure_weight)) }),
  ...(value.cold_start_weight === undefined
    ? {}
    : { placementColdStartWeight: Math.max(0, Number(value.cold_start_weight)) }),
  ...(value.transfer_weight === undefined
    ? {}
    : { placementTransferWeight: Math.max(0, Number(value.transfer_weight)) }),
});

const toCapacitySnapshot = (
  source: Awaited<ReturnType<CapacityPlanRepository["activePoolSnapshots"]>>[number],
): CapacitySnapshot => ({
  now: new Date(),
  currentReadyReplicas: source.currentReadyReplicas,
  currentDesiredReplicas: source.currentDesiredReplicas,
  observedUtilizationPercent: 0,
  queue: source.queue,
  running: source.running,
  arrivalGpuSecondsPerSecondP75: 0,
  approvedMaxConcurrency: source.approvedMaxConcurrency,
  replicaGpuSku: source.gpuSku,
  replicaProvider: source.provider,
  offers: source.offers,
  budgetRemainingMinor: Number(source.policy.daily_limit_minor ?? Number.MAX_SAFE_INTEGER),
  rolloutInProgress: source.replicas.some((replica) => replica.rolloutOwned),
  replicas: source.replicas,
});

export type CapacityPlannerResult = Readonly<{ planned: number; suppressed: number; admissionControl: number }>;

export class CapacityPlanner {
  constructor(private readonly repository: CapacityPlanRepository) {}

  async runOnce(): Promise<CapacityPlannerResult> {
    const pools = await this.repository.activePoolSnapshots();
    let suppressed = 0;
    let admissionControl = 0;
    for (const pool of pools) {
      const result = planCapacity(toCapacitySnapshot(pool), policyFromDatabase(pool.policy));
      const status = result.admissionControl ? "admission_control" : result.suppressedBy ? "suppressed" : "planned";
      if (result.suppressedBy) suppressed += 1;
      if (result.admissionControl) admissionControl += 1;
      await this.repository.record({
        snapshot: pool,
        result: {
          desired_replicas: result.desiredReplicas,
          workload_replicas: result.workloadReplicas,
          queue_slo_replicas: result.queueSloReplicas,
          affordable_replicas: result.affordableReplicas,
          queue_eta_seconds: result.queueEtaSeconds,
          cost_minor: result.costMinor,
          benefit_minor: result.benefitMinor,
          net_benefit_minor: result.netBenefitMinor,
          ...(result.suppressedBy ? { suppressed_by: result.suppressedBy } : {}),
          admission_control: result.admissionControl,
          ...(result.placement ? { placement: result.placement } : {}),
          drain_replica_ids: result.drainReplicaIds,
        },
        status,
        strategyVersion: pool.policyVersionId ?? "capacity-v1",
      });
    }
    return { planned: pools.length, suppressed, admissionControl };
  }
}
