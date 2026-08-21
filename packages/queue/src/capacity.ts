export type CapacityLane = "online" | "batch";

export type CapacityTask = Readonly<{
  taskId: string;
  projectId: string;
  lane: CapacityLane;
  predictedGpuSeconds: number;
  targetWaitSeconds?: number;
  waitValueMinorPerMinute?: number;
  sloPenaltyMinorPerMinute?: number;
}>;

export type RunningCapacityAttempt = Readonly<{
  attemptId: string;
  remainingGpuSeconds: number;
}>;

export type CapacityReplica = Readonly<{
  replicaId: string;
  regionId: string;
  gpuSku: string;
  maximumConcurrency: number;
  runningSlots: number;
  reservedSlots: number;
  idleSince?: Date;
  readyAt?: Date;
  lastScaleActionAt?: Date;
  rolloutOwned: boolean;
  draining: boolean;
}>;

export type CapacityOffer = Readonly<{
  provider: string;
  regionId: string;
  gpuSku: string;
  availableReplicas: number;
  pricePerGpuHourMinor: number;
  coldStartSeconds: number;
  failureRateBasisPoints: number;
  transferCostMinorPerTask: number;
  healthy: boolean;
  snapshotFresh: boolean;
}>;

export type CapacityPolicy = Readonly<{
  mode: "automatic" | "protected" | "manual";
  minReplicas: number;
  maxReplicas: number;
  manualReplicas?: number;
  queueTargetSeconds: number;
  maxQueueEtaSeconds: number;
  backlogDrainSeconds: number;
  targetUtilizationPercent: number;
  scaleUpStep: number;
  emergencyScaleUpStep: number;
  scaleDownStepPercent: number;
  idleWindowSeconds: number;
  scaleDownObservationSeconds: number;
  scaleDownCooldownSeconds: number;
  scaleUpCooldownSeconds: number;
  hysteresisPercent: number;
  scaleDownSafetyMarginPercent: number;
  minHoldSeconds: number;
  provisioningP90Seconds: number;
  minNetBenefitMinor: number;
  minNetSavingMinor: number;
  waitValueMinorPerMinute: number;
  sloPenaltyMinorPerMinute: number;
  batchMinSharePercent: number;
}>;

export type CapacitySnapshot = Readonly<{
  now: Date;
  currentReadyReplicas: number;
  currentDesiredReplicas: number;
  observedUtilizationPercent: number;
  lastScaleActionAt?: Date;
  queue: readonly CapacityTask[];
  running: readonly RunningCapacityAttempt[];
  arrivalGpuSecondsPerSecondP75: number;
  approvedMaxConcurrency: number;
  replicaGpuSku: string;
  replicaProvider: string;
  offers: readonly CapacityOffer[];
  budgetRemainingMinor: number;
  rolloutInProgress: boolean;
  replicas: readonly CapacityReplica[];
}>;

export type QueueSimulation = Readonly<{
  p95WaitSeconds: number;
  maximumWaitSeconds: number;
  drainSeconds: number;
  waits: readonly number[];
}>;

export type PlacementDecision = Readonly<{
  provider: string;
  regionId: string;
  gpuSku: string;
  score: number;
  estimatedCostMinor: number;
  estimatedCompletionSeconds: number;
  reasons: readonly string[];
}>;

export type CapacityDecision = Readonly<{
  desiredReplicas: number;
  workloadReplicas: number;
  queueSloReplicas: number;
  affordableReplicas: number;
  queueEtaSeconds: number;
  costMinor: number;
  benefitMinor: number;
  netBenefitMinor: number;
  placement?: PlacementDecision;
  suppressedBy?: "budget" | "inventory" | "rollout" | "cooldown" | "admission_control";
  admissionControl: boolean;
  drainReplicaIds: readonly string[];
}>;

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)] ?? 0;
};

const fairOrder = (tasks: readonly CapacityTask[]): readonly CapacityTask[] =>
  [...tasks].sort(
    (left, right) =>
      (left.lane === right.lane ? 0 : left.lane === "online" ? -1 : 1) ||
      left.predictedGpuSeconds - right.predictedGpuSeconds ||
      left.projectId.localeCompare(right.projectId) ||
      left.taskId.localeCompare(right.taskId),
  );

export function simulateQueue(
  replicas: number,
  maximumConcurrency: number,
  running: readonly RunningCapacityAttempt[],
  tasks: readonly CapacityTask[],
): QueueSimulation {
  const count = Math.max(1, Math.floor(replicas));
  const concurrency = Math.max(1, Math.floor(maximumConcurrency));
  const slots = Array.from({ length: count * concurrency }, () => 0);
  [...running]
    .sort(
      (left, right) =>
        right.remainingGpuSeconds - left.remainingGpuSeconds || left.attemptId.localeCompare(right.attemptId),
    )
    .slice(0, slots.length)
    .forEach((attempt, index) => {
      slots[index] = Math.max(0, attempt.remainingGpuSeconds);
    });
  const waits: number[] = [];
  for (const task of fairOrder(tasks)) {
    let slotIndex = 0;
    for (let index = 1; index < slots.length; index += 1) {
      if ((slots[index] ?? 0) < (slots[slotIndex] ?? 0)) slotIndex = index;
    }
    const availableAt = slots[slotIndex] ?? 0;
    waits.push(availableAt);
    slots[slotIndex] = availableAt + Math.max(1, task.predictedGpuSeconds);
  }
  return {
    p95WaitSeconds: percentile(waits, 0.95),
    maximumWaitSeconds: Math.max(0, ...waits),
    drainSeconds: Math.max(0, ...slots),
    waits,
  };
}

const estimateWorkloadReplicas = (snapshot: CapacitySnapshot, policy: CapacityPolicy): number => {
  const horizon = Math.max(policy.backlogDrainSeconds, policy.provisioningP90Seconds, 1);
  const queuedWork = snapshot.queue.reduce((total, task) => total + Math.max(1, task.predictedGpuSeconds), 0);
  const runningWork = snapshot.running.reduce((total, attempt) => total + Math.max(0, attempt.remainingGpuSeconds), 0);
  const arrivalWork = Math.max(0, snapshot.arrivalGpuSecondsPerSecondP75) * horizon;
  const requiredWorkPerSecond = (queuedWork + runningWork + arrivalWork) / horizon;
  const effectiveSlotRate = Math.max(1, policy.targetUtilizationPercent / 100) * Math.max(1, 1);
  const requiredSlots = Math.ceil(requiredWorkPerSecond / effectiveSlotRate);
  return Math.max(policy.minReplicas, Math.ceil(requiredSlots / Math.max(1, snapshot.approvedMaxConcurrency)));
};

const estimateQueueSloReplicas = (snapshot: CapacitySnapshot, policy: CapacityPolicy): number => {
  for (
    let replicas = Math.max(policy.minReplicas, snapshot.currentReadyReplicas, 1);
    replicas <= policy.maxReplicas;
    replicas += 1
  ) {
    const result = simulateQueue(replicas, snapshot.approvedMaxConcurrency, snapshot.running, snapshot.queue);
    if (result.p95WaitSeconds <= policy.queueTargetSeconds) return replicas;
  }
  return policy.maxReplicas;
};

const placement = (
  snapshot: CapacitySnapshot,
  policy: CapacityPolicy,
  replicas: number,
): PlacementDecision | undefined => {
  const candidates = snapshot.offers.filter(
    (offer) =>
      offer.provider === snapshot.replicaProvider &&
      offer.gpuSku === snapshot.replicaGpuSku &&
      offer.healthy &&
      offer.snapshotFresh &&
      offer.availableReplicas >= replicas,
  );
  if (candidates.length === 0) return undefined;
  const maxCost = Math.max(...candidates.map((candidate) => candidate.pricePerGpuHourMinor));
  const maxCold = Math.max(...candidates.map((candidate) => candidate.coldStartSeconds));
  const maxFailure = Math.max(...candidates.map((candidate) => candidate.failureRateBasisPoints));
  const maxTransfer = Math.max(...candidates.map((candidate) => candidate.transferCostMinorPerTask));
  const score = (offer: CapacityOffer): number => {
    const cost = maxCost === 0 ? 0 : offer.pricePerGpuHourMinor / maxCost;
    const cold = maxCold === 0 ? 0 : offer.coldStartSeconds / maxCold;
    const failure = maxFailure === 0 ? 0 : offer.failureRateBasisPoints / maxFailure;
    const transfer = maxTransfer === 0 ? 0 : offer.transferCostMinorPerTask / maxTransfer;
    return cost * 0.35 + cold * 0.2 + failure * 0.25 + transfer * 0.2;
  };
  const winner = [...candidates].sort(
    (left, right) =>
      score(left) - score(right) ||
      left.pricePerGpuHourMinor - right.pricePerGpuHourMinor ||
      left.regionId.localeCompare(right.regionId),
  )[0];
  if (!winner) return undefined;
  const horizon = Math.max(policy.backlogDrainSeconds, policy.provisioningP90Seconds);
  return {
    provider: winner.provider,
    regionId: winner.regionId,
    gpuSku: winner.gpuSku,
    score: score(winner),
    estimatedCostMinor: Math.ceil((winner.pricePerGpuHourMinor * replicas * horizon) / 3600),
    estimatedCompletionSeconds:
      winner.coldStartSeconds +
      simulateQueue(replicas, snapshot.approvedMaxConcurrency, snapshot.running, snapshot.queue).p95WaitSeconds,
    reasons: ["hardware_compatible", "fresh_inventory", "budget_filtered", "deterministic_score"],
  };
};

export function planCapacity(snapshot: CapacitySnapshot, policy: CapacityPolicy): CapacityDecision {
  const workloadReplicas = estimateWorkloadReplicas(snapshot, policy);
  const queueSloReplicas = estimateQueueSloReplicas(snapshot, policy);
  const rawDesired =
    policy.mode === "manual"
      ? (policy.manualReplicas ?? policy.minReplicas)
      : Math.max(workloadReplicas, queueSloReplicas, policy.minReplicas);
  const bounded = clamp(rawDesired, policy.minReplicas, policy.maxReplicas);
  const current = Math.max(0, snapshot.currentDesiredReplicas);
  const currentSimulation = simulateQueue(
    Math.max(1, current),
    snapshot.approvedMaxConcurrency,
    snapshot.running,
    snapshot.queue,
  );
  const candidateSimulation = simulateQueue(
    Math.max(1, bounded),
    snapshot.approvedMaxConcurrency,
    snapshot.running,
    snapshot.queue,
  );
  const selectedPlacement = placement(snapshot, policy, Math.max(0, bounded - current));
  const hourlyPrice = selectedPlacement
    ? selectedPlacement.estimatedCostMinor / Math.max(policy.backlogDrainSeconds / 3600, 1)
    : 0;
  const costMinor = Math.max(0, selectedPlacement?.estimatedCostMinor ?? 0);
  const benefitMinor =
    Math.max(0, (currentSimulation.p95WaitSeconds - candidateSimulation.p95WaitSeconds) / 60) *
    (policy.waitValueMinorPerMinute + policy.sloPenaltyMinorPerMinute);
  const netBenefitMinor = Math.floor(benefitMinor - costMinor);
  const hardSlo = currentSimulation.p95WaitSeconds > policy.queueTargetSeconds;
  const admissionControl =
    candidateSimulation.maximumWaitSeconds > policy.maxQueueEtaSeconds ||
    (snapshot.queue.length > 0 && bounded >= policy.maxReplicas);
  let desired = bounded;
  let suppressedBy: CapacityDecision["suppressedBy"];
  if (snapshot.rolloutInProgress && desired < current) {
    desired = current;
    suppressedBy = "rollout";
  } else if (selectedPlacement === undefined && desired > current) {
    desired = current;
    suppressedBy = "inventory";
  } else if (snapshot.budgetRemainingMinor < costMinor && desired > current) {
    desired = current;
    suppressedBy = "budget";
  } else if (
    !hardSlo &&
    netBenefitMinor < policy.minNetBenefitMinor &&
    desired > current &&
    policy.mode === "automatic"
  ) {
    desired = current;
    suppressedBy = "cooldown";
  }
  const scaleUpLimit = hardSlo ? policy.emergencyScaleUpStep : policy.scaleUpStep;
  if (desired > current) desired = Math.min(desired, current + Math.max(1, scaleUpLimit));
  const removable = Math.min(
    Math.floor((current * policy.scaleDownStepPercent) / 100),
    Math.max(0, current - policy.minReplicas),
  );
  const drainReplicaIds =
    desired < current && !snapshot.rolloutInProgress
      ? snapshot.replicas
          .filter(
            (replica) =>
              replica.regionId &&
              !replica.rolloutOwned &&
              !replica.draining &&
              replica.runningSlots === 0 &&
              replica.reservedSlots === 0,
          )
          .filter(
            (replica) =>
              !replica.idleSince ||
              snapshot.now.getTime() - replica.idleSince.getTime() >= policy.idleWindowSeconds * 1000,
          )
          .filter(
            (replica) =>
              !replica.readyAt || snapshot.now.getTime() - replica.readyAt.getTime() >= policy.minHoldSeconds * 1000,
          )
          .filter(
            (replica) =>
              !replica.lastScaleActionAt ||
              snapshot.now.getTime() - replica.lastScaleActionAt.getTime() >= policy.scaleDownCooldownSeconds * 1000,
          )
          .sort((left, right) => left.replicaId.localeCompare(right.replicaId))
          .slice(0, removable)
          .map((replica) => replica.replicaId)
      : [];
  const queueEtaSeconds = candidateSimulation.maximumWaitSeconds + (selectedPlacement?.estimatedCompletionSeconds ?? 0);
  return {
    desiredReplicas: desired,
    workloadReplicas,
    queueSloReplicas,
    affordableReplicas: snapshot.budgetRemainingMinor >= costMinor ? bounded : current,
    queueEtaSeconds,
    costMinor: Math.ceil(hourlyPrice * 0 + costMinor),
    benefitMinor: Math.floor(benefitMinor),
    netBenefitMinor,
    ...(selectedPlacement ? { placement: selectedPlacement } : {}),
    ...(suppressedBy ? { suppressedBy } : {}),
    admissionControl,
    drainReplicaIds,
  };
}
