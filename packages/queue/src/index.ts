import type { TaskStatus } from "@astra/contracts";
import type { ProjectContext } from "@astra/auth";
import { createCluster, type RedisClusterType } from "redis";

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

export type DeterministicTaskCandidate = Readonly<{
  taskId: string;
  projectId: string;
  releaseId: string;
  taskVersion: number;
  lane: QueueClass;
  createdAt: string;
}>;

export type DispatchableReplica = Readonly<{
  replicaId: string;
  replicaVersion: number;
  poolId: string;
  releaseId: string;
  workerId: string;
  regionId: string;
  gpuSku: string;
  maximumConcurrency: number;
  occupiedSlots: readonly number[];
  policyVersion: string;
}>;

export type DeterministicAssignment = Readonly<{
  task: DeterministicTaskCandidate;
  replica: DispatchableReplica;
  slotIndex: number;
  reason: "online_priority" | "batch_priority";
}>;

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Pure phase-6 planner. Persistence performs CAS again and remains authoritative. */
export function planDeterministicAssignments(
  tasks: readonly DeterministicTaskCandidate[],
  replicas: readonly DispatchableReplica[],
): readonly DeterministicAssignment[] {
  const orderedTasks = [...tasks].sort(
    (left, right) =>
      (left.lane === right.lane ? 0 : left.lane === "online" ? -1 : 1) ||
      compareText(left.createdAt, right.createdAt) ||
      compareText(left.taskId, right.taskId),
  );
  const orderedReplicas = [...replicas].sort(
    (left, right) =>
      compareText(left.releaseId, right.releaseId) ||
      compareText(left.regionId, right.regionId) ||
      compareText(left.poolId, right.poolId) ||
      compareText(left.replicaId, right.replicaId),
  );
  const occupied = new Map(
    orderedReplicas.map((replica) => [replica.replicaId, new Set(replica.occupiedSlots)] as const),
  );
  const assignments: DeterministicAssignment[] = [];

  for (const task of orderedTasks) {
    const replica = orderedReplicas.find((candidate) => {
      if (candidate.releaseId !== task.releaseId) return false;
      const slots = occupied.get(candidate.replicaId);
      return slots !== undefined && slots.size < candidate.maximumConcurrency;
    });
    if (!replica) continue;
    const slots = occupied.get(replica.replicaId);
    if (!slots) continue;
    let slotIndex = 0;
    while (slots.has(slotIndex) && slotIndex < replica.maximumConcurrency) slotIndex += 1;
    if (slotIndex >= replica.maximumConcurrency) continue;
    slots.add(slotIndex);
    assignments.push({
      task,
      replica,
      slotIndex,
      reason: task.lane === "online" ? "online_priority" : "batch_priority",
    });
  }
  return assignments;
}

export type CapacityPlan = Readonly<{
  poolId: string;
  desiredReplicas: number;
  workloadReplicas: number;
  queueSloReplicas: number;
  suppressedBy?: "budget" | "inventory" | "rollout";
}>;

export type RateLimitCategory = "request" | "task";

export type RateLimitDecision = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
}>;

export interface PublicApiRateLimiter {
  consume(context: ProjectContext, category: RateLimitCategory, operationKey: string): Promise<RateLimitDecision>;
  ready(): Promise<boolean>;
}

export class RateLimiterUnavailableError extends Error {
  constructor() {
    super("rate_limiter_unavailable");
  }
}

const tokenBucketScript = `
local rate_per_minute = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local current = redis.call('TIME')
local now_ms = current[1] * 1000 + math.floor(current[2] / 1000)
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updated_at_ms')
local tokens = tonumber(values[1])
local updated_at_ms = tonumber(values[2])
if tokens == nil or updated_at_ms == nil then
  tokens = capacity
  updated_at_ms = now_ms
end
local refill_per_ms = rate_per_minute / 60000
tokens = math.min(capacity, tokens + math.max(0, now_ms - updated_at_ms) * refill_per_ms)
local allowed = 0
local retry_after_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after_ms = math.ceil((1 - tokens) / refill_per_ms)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updated_at_ms', tostring(now_ms))
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / refill_per_ms) * 2))
return {allowed, math.max(0, retry_after_ms)}
`;

export class RedisPublicApiRateLimiter implements PublicApiRateLimiter {
  private readonly client: RedisClusterType;
  private connection: Promise<void> | undefined;
  private connectedState = false;

  constructor(rootUrl: string) {
    this.client = createCluster({ rootNodes: [{ url: rootUrl }] });
    this.client.on("error", () => undefined);
  }

  private async connected(): Promise<void> {
    if (this.connectedState) return;
    this.connection ??= this.client.connect().then(() => {
      this.connectedState = true;
    });
    try {
      await this.connection;
    } catch {
      this.connection = undefined;
      throw new RateLimiterUnavailableError();
    }
  }

  async consume(
    context: ProjectContext,
    category: RateLimitCategory,
    _operationKey: string,
  ): Promise<RateLimitDecision> {
    await this.connected();
    const rate =
      category === "request" ? context.ratePolicy.requestRatePerMinute : context.ratePolicy.taskRatePerMinute;
    const burst = category === "request" ? context.ratePolicy.requestBurst : context.ratePolicy.taskBurst;
    const key = `astra:rate:{${context.projectId}}:${context.apiKeyId}:${category}`;
    try {
      const raw = await this.client.eval(tokenBucketScript, {
        keys: [key],
        arguments: [String(rate), String(burst)],
      });
      if (!Array.isArray(raw) || raw.length !== 2) throw new RateLimiterUnavailableError();
      return {
        allowed: Number(raw[0]) === 1,
        retryAfterSeconds: Math.max(1, Math.ceil(Number(raw[1]) / 1000)),
      };
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) throw error;
      throw new RateLimiterUnavailableError();
    }
  }

  async ready(): Promise<boolean> {
    try {
      await this.connected();
      const masters = await this.client.getMasters();
      const master = masters[0];
      if (!master?.client) return false;
      await master.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.connectedState) await this.client.close();
    this.connectedState = false;
    this.connection = undefined;
  }
}

export type RedisCandidate = Readonly<{
  taskId: string;
  projectId: string;
  releaseId: string;
  lane: QueueClass;
  taskVersion: number;
  createdAt: string;
}>;

export class RedisCandidateIndex {
  private readonly client: RedisClusterType;
  private connection: Promise<void> | undefined;
  private connectedState = false;

  constructor(
    rootUrl: string,
    private readonly namespace = "astra",
  ) {
    if (!/^[a-zA-Z0-9:_-]+$/.test(namespace)) throw new Error("invalid_redis_namespace");
    this.client = createCluster({ rootNodes: [{ url: rootUrl }] });
    this.client.on("error", () => undefined);
  }

  private async connected(): Promise<void> {
    if (this.connectedState) return;
    this.connection ??= this.client.connect().then(() => {
      this.connectedState = true;
    });
    try {
      await this.connection;
    } catch {
      this.connection = undefined;
      throw new Error("redis_candidate_index_unavailable");
    }
  }

  private candidateKey(generation: string, releaseId: string): string {
    return `${this.namespace}:candidates:{${releaseId}}:${generation}`;
  }

  private queueKey(generation: string, releaseId: string, lane: QueueClass): string {
    return `${this.namespace}:queue:{${releaseId}}:${generation}:${lane}`;
  }

  async put(generation: string, candidate: RedisCandidate): Promise<void> {
    await this.connected();
    const score = new Date(candidate.createdAt).getTime();
    if (!Number.isFinite(score)) throw new Error("invalid_candidate_created_at");
    try {
      await this.client.sAdd(`${this.namespace}:queue:releases:${generation}`, candidate.releaseId);
      await this.client
        .multi()
        .hSet(this.candidateKey(generation, candidate.releaseId), candidate.taskId, JSON.stringify(candidate))
        .zAdd(this.queueKey(generation, candidate.releaseId, candidate.lane), {
          score,
          value: candidate.taskId,
        })
        .exec();
    } catch {
      throw new Error("redis_candidate_index_unavailable");
    }
  }

  async remove(generation: string, taskId: string, releaseId: string): Promise<void> {
    await this.connected();
    try {
      await this.client
        .multi()
        .hDel(this.candidateKey(generation, releaseId), taskId)
        .zRem(this.queueKey(generation, releaseId, "online"), taskId)
        .zRem(this.queueKey(generation, releaseId, "batch"), taskId)
        .exec();
    } catch {
      throw new Error("redis_candidate_index_unavailable");
    }
  }

  async switchGeneration(generation: string): Promise<void> {
    await this.connected();
    try {
      await this.client.set(`${this.namespace}:queue:active_generation`, generation);
    } catch {
      throw new Error("redis_candidate_index_unavailable");
    }
  }

  async activeGeneration(): Promise<string | undefined> {
    await this.connected();
    try {
      return (await this.client.get(`${this.namespace}:queue:active_generation`)) ?? undefined;
    } catch {
      throw new Error("redis_candidate_index_unavailable");
    }
  }

  async count(generation: string): Promise<number> {
    await this.connected();
    try {
      const releases = await this.client.sMembers(`${this.namespace}:queue:releases:${generation}`);
      const counts = await Promise.all(
        releases.map((releaseId) => this.client.hLen(this.candidateKey(generation, releaseId))),
      );
      return counts.reduce((total, value) => total + value, 0);
    } catch {
      throw new Error("redis_candidate_index_unavailable");
    }
  }

  async candidate(generation: string, releaseId: string, taskId: string): Promise<RedisCandidate | undefined> {
    await this.connected();
    try {
      const raw = await this.client.hGet(this.candidateKey(generation, releaseId), taskId);
      return raw ? (JSON.parse(raw) as RedisCandidate) : undefined;
    } catch {
      throw new Error("redis_candidate_index_unavailable");
    }
  }

  async deleteGeneration(generation: string): Promise<void> {
    await this.connected();
    try {
      const releasesKey = `${this.namespace}:queue:releases:${generation}`;
      const releases = await this.client.sMembers(releasesKey);
      for (const releaseId of releases) {
        await this.client
          .multi()
          .del([
            this.candidateKey(generation, releaseId),
            this.queueKey(generation, releaseId, "online"),
            this.queueKey(generation, releaseId, "batch"),
          ])
          .exec();
      }
      await this.client.del(releasesKey);
      if ((await this.activeGeneration()) === generation) {
        await this.client.del(`${this.namespace}:queue:active_generation`);
      }
    } catch {
      throw new Error("redis_candidate_index_unavailable");
    }
  }

  async ready(): Promise<boolean> {
    try {
      await this.connected();
      const masters = await this.client.getMasters();
      if (!masters[0]?.client) return false;
      await masters[0].client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.connectedState) await this.client.close();
    this.connectedState = false;
    this.connection = undefined;
  }
}
