import { describe, expect, test } from "bun:test";
import { parseEnvironmentText, rolloutStrategyFromForm } from "./release-form.ts";

describe("simplified release form", () => {
  test("parses one variable per line and preserves equals signs", () => {
    expect(parseEnvironmentText('H3_MODE=stable\nNO_PROXY=127.0.0.1,localhost\nCOMMAND=["a=b"]')).toEqual({
      H3_MODE: "stable",
      NO_PROXY: "127.0.0.1,localhost",
      COMMAND: '["a=b"]',
    });
  });

  test("rejects platform-owned and secret-like variables", () => {
    expect(() => parseEnvironmentText("WORKER_RELEASE_ID=release_1")).toThrow("由 Astra 管理");
    expect(() => parseEnvironmentText("HF_TOKEN=value")).toThrow("平台凭证管理");
    expect(() => parseEnvironmentText("BROKEN_LINE")).toThrow("KEY=VALUE");
  });

  test("builds the rollout strategy without JSON input", () => {
    const form = new FormData();
    for (const [name, value] of Object.entries({
      max_surge: "1",
      max_unavailable: "0",
      batch_size: "1",
      readiness_timeout_seconds: "1800",
      readiness_stability_seconds: "60",
      progress_deadline_seconds: "7200",
      maximum_failure_rate_basis_points: "500",
      maximum_duration_regression_basis_points: "2500",
      maximum_extra_cost_minor: "600",
      currency: "CNY",
      rollback_retention_seconds: "604800",
    })) {
      form.set(name, value);
    }
    form.set("pause_on_failure", "on");
    expect(rolloutStrategyFromForm(form)).toMatchObject({ max_surge: 1, pause_on_failure: true, currency: "CNY" });
  });
});
