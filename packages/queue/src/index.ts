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
