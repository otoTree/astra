export type RetryDisposition = "scheduled" | "exhausted" | "not_retryable" | "asset_ttl" | "budget" | "canceled";

export type RetryPolicy = Readonly<{
  maxAttempts: number;
  initialBackoffSeconds: number;
  maximumBackoffSeconds: number;
  retryableCodes: readonly string[];
}>;

export type RetryEvaluation = Readonly<{ disposition: RetryDisposition; retryAt?: Date }>;

export function evaluateRetryPolicy(
  input: Readonly<{
    errorCode: string;
    retryable: boolean;
    attemptNumber: number;
    policy: RetryPolicy;
    now: Date;
    expectedServiceSeconds: number;
    taskExpiresAt?: Date;
    assetExpiresAt?: Date;
    budgetAvailable: boolean;
  }>,
): RetryEvaluation {
  if (input.errorCode === "canceled") return { disposition: "canceled" };
  if (!input.retryable || !input.policy.retryableCodes.includes(input.errorCode)) {
    return { disposition: "not_retryable" };
  }
  if (input.attemptNumber >= input.policy.maxAttempts) return { disposition: "exhausted" };
  const backoffSeconds = Math.min(
    input.policy.maximumBackoffSeconds,
    input.policy.initialBackoffSeconds * 2 ** Math.max(0, input.attemptNumber - 1),
  );
  const retryAt = new Date(input.now.getTime() + backoffSeconds * 1000);
  const requiredUntil = new Date(retryAt.getTime() + input.expectedServiceSeconds * 1000);
  if (
    (input.taskExpiresAt && input.taskExpiresAt <= requiredUntil) ||
    (input.assetExpiresAt && input.assetExpiresAt <= requiredUntil)
  ) {
    return { disposition: "asset_ttl" };
  }
  if (!input.budgetAvailable) return { disposition: "budget" };
  return { disposition: "scheduled", retryAt };
}
