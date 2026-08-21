import { describe, expect, test } from "bun:test";
import { evaluateRetryPolicy } from "./retry-policy.ts";

const now = new Date("2026-08-22T10:00:00.000Z");
const policy = {
  maxAttempts: 3,
  initialBackoffSeconds: 5,
  maximumBackoffSeconds: 60,
  retryableCodes: ["worker_lost", "provider_timeout"],
};

describe("retry policy", () => {
  test("uses deterministic exponential backoff only for declared retryable errors", () => {
    expect(
      evaluateRetryPolicy({
        errorCode: "worker_lost",
        retryable: true,
        attemptNumber: 2,
        policy,
        now,
        expectedServiceSeconds: 840,
        budgetAvailable: true,
      }),
    ).toEqual({ disposition: "scheduled", retryAt: new Date("2026-08-22T10:00:10.000Z") });
    expect(
      evaluateRetryPolicy({
        errorCode: "invalid_output",
        retryable: true,
        attemptNumber: 1,
        policy,
        now,
        expectedServiceSeconds: 1,
        budgetAvailable: true,
      }).disposition,
    ).toBe("not_retryable");
  });

  test("stops at the attempt, asset TTL and budget boundaries", () => {
    expect(
      evaluateRetryPolicy({
        errorCode: "worker_lost",
        retryable: true,
        attemptNumber: 3,
        policy,
        now,
        expectedServiceSeconds: 1,
        budgetAvailable: true,
      }).disposition,
    ).toBe("exhausted");
    expect(
      evaluateRetryPolicy({
        errorCode: "worker_lost",
        retryable: true,
        attemptNumber: 1,
        policy,
        now,
        expectedServiceSeconds: 840,
        assetExpiresAt: new Date("2026-08-22T10:10:00.000Z"),
        budgetAvailable: true,
      }).disposition,
    ).toBe("asset_ttl");
    expect(
      evaluateRetryPolicy({
        errorCode: "worker_lost",
        retryable: true,
        attemptNumber: 1,
        policy,
        now,
        expectedServiceSeconds: 1,
        budgetAvailable: false,
      }).disposition,
    ).toBe("budget");
  });
});
