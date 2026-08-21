import type { TaskStatus } from "@astra/contracts";

export type QueueClass = "online" | "batch";
export type SlotState = "running" | "reserved" | "unknown" | "draining";

export type SchedulingCandidate = Readonly<{
  taskId: string;
  projectId: string;
  expectedGpuSeconds: number;
  queueClass: QueueClass;
  projectWeight: number;
  status: TaskStatus;
}>;

export type SchedulingDecision = Readonly<{
  decisionId: string;
  taskId: string;
  releaseId: string;
  replicaId: string;
  reason: string;
  policyVersion: string;
}>;

export type CapacityPlan = Readonly<{
  poolId: string;
  desiredReplicas: number;
  workloadReplicas: number;
  queueSloReplicas: number;
  suppressedBy?: "budget" | "inventory" | "rollout";
}>;
