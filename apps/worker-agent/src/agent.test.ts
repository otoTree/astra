import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CompleteAttempt,
  type CompleteOutputs,
  capabilitiesSchema,
  type DrainedWorker,
  type FailAttempt,
  type InferenceRequest,
  type LeasedAttempt,
  type ModelExecutionView,
  type ModelSmokeRequest,
  type PrepareOutputs,
  type WorkerHeartbeat,
  type WorkerLeaseRequest,
  type WorkerRegistration,
} from "@astra/contracts";
import { type ModelAppPort, WorkerAgent, type WorkerControlPort } from "./agent.ts";
import { WorkerStateStore } from "./state-store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const capabilities = capabilitiesSchema.parse({
  contract_version: "1.0",
  app: { name: "agent-contract-app", version: "1.0.0", build: "test" },
  model_release: "release_agent_contract",
  modalities: ["image"],
  operations: ["generation"],
  max_concurrency: 1,
  capabilities: {
    aspect_ratios: ["16:9"],
    resolutions: ["0.2mp"],
    resolution_matrix: { "16:9/0.2mp": { width: 608, height: 352 } },
    durations: [],
    fps: [],
    input_types: ["image", "video", "audio"],
    input_roles: ["reference_image"],
    audio_modes: ["none"],
    supports_cancel: true,
    supports_progress: true,
    supports_resume: false,
  },
  artifacts: {
    output_artifacts: [{ role: "result", content_types: ["image/png"] }],
    max_outputs: 1,
    sidecar_manifest_allowed: false,
    post_processing: "model_app_only",
  },
});

class ControlledModel implements ModelAppPort {
  statusValue: ModelExecutionView = { execution_id: "execution_agent_contract", status: "running", progress: 25 };
  cancelCalls = 0;

  async live(): Promise<boolean> {
    return true;
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async capabilities() {
    return capabilities;
  }

  async accept(_request: InferenceRequest): Promise<ModelExecutionView> {
    return this.statusValue;
  }

  async status(_executionId: string): Promise<ModelExecutionView> {
    return this.statusValue;
  }

  async cancel(executionId: string): Promise<ModelExecutionView> {
    this.cancelCalls += 1;
    this.statusValue = { execution_id: executionId, status: "canceled", progress: null };
    return this.statusValue;
  }

  async smoke(input: ModelSmokeRequest) {
    return {
      validation_id: input.validation_id,
      model_release: input.model_release,
      status: "passed" as const,
      evidence_sha256: "a".repeat(64),
      duration_ms: 1,
      checks: { readiness: true, capabilities: true, execution: true, output_contract: true },
    };
  }
}

class RecordingControl implements WorkerControlPort {
  registerCalls = 0;
  leaseCalls = 0;
  heartbeatCalls = 0;
  failInputs: FailAttempt[] = [];
  drainedInputs: DrainedWorker[] = [];
  desiredState: "run" | "cancel" | "drain" | "shutdown" = "run";
  cancelOnHeartbeat = false;
  afterHeartbeat?: (count: number) => void;

  constructor(private readonly leased: LeasedAttempt) {}

  async register(_input: WorkerRegistration, _bootstrapToken: string) {
    this.registerCalls += 1;
    return {
      worker_id: "worker_agent_contract",
      worker_token: "worker_token_agent_contract_at_least_32_chars",
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
      heartbeat_interval_seconds: 1,
      lease_duration_seconds: 30,
      orphan_grace_period_seconds: 180,
      rollout_validation_required: false,
    };
  }

  async lease(_session: Readonly<{ workerId: string; token: string }>, _input: WorkerLeaseRequest) {
    this.leaseCalls += 1;
    return this.leaseCalls === 1 ? this.leased : undefined;
  }

  async heartbeat(_session: Readonly<{ workerId: string; token: string }>, input: WorkerHeartbeat) {
    this.heartbeatCalls += 1;
    this.afterHeartbeat?.(this.heartbeatCalls);
    return {
      accepted_sequence: input.sequence,
      leases: input.executions.map((execution) => ({
        attempt_id: execution.attempt_id,
        lease_id: execution.lease_id,
        lease_version: execution.lease_version + 1,
        lease_expires_at: Math.floor(Date.now() / 1000) + 30,
        cancel_requested: this.cancelOnHeartbeat,
      })),
      desired_state: this.desiredState,
    };
  }

  async prepareOutputs(
    _session: Readonly<{ workerId: string; token: string }>,
    _attemptId: string,
    _input: PrepareOutputs,
  ): Promise<never> {
    throw new Error("unexpected_output_prepare");
  }

  async completeOutputs(
    _session: Readonly<{ workerId: string; token: string }>,
    _attemptId: string,
    _input: CompleteOutputs,
  ): Promise<never> {
    throw new Error("unexpected_output_complete");
  }

  async complete(
    _session: Readonly<{ workerId: string; token: string }>,
    _attemptId: string,
    _input: CompleteAttempt,
  ): Promise<never> {
    throw new Error("unexpected_attempt_complete");
  }

  async fail(_session: Readonly<{ workerId: string; token: string }>, _attemptId: string, input: FailAttempt) {
    this.failInputs.push(input);
    return {};
  }

  async drained(_session: Readonly<{ workerId: string; token: string }>, input: DrainedWorker) {
    this.drainedInputs.push(input);
    return {};
  }

  async reportRolloutValidation(): Promise<never> {
    throw new Error("unexpected_rollout_validation");
  }
}

const waitFor = async (predicate: () => boolean, timeoutMilliseconds = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("agent_contract_timeout");
    await Bun.sleep(10);
  }
};

async function context() {
  const root = await mkdtemp(join(tmpdir(), "astra-agent-contract-"));
  directories.push(root);
  const lease: LeasedAttempt = {
    attempt_id: "attempt_agent_contract",
    lease_id: "lease_agent_contract",
    lease_version: 1,
    lease_expires_at: Math.floor(Date.now() / 1000) + 30,
    execution_key: "execution_agent_contract",
    inference: {
      execution_id: "execution_agent_contract",
      task_id: "task_agent_contract",
      type: "image",
      operation: "generation",
      model_release: "release_agent_contract",
      request: { size: "608x352" },
      inputs: [],
      output_dir: join(root, "tasks", "attempt_agent_contract", "outputs"),
      deadline_at: Math.floor(Date.now() / 1000) + 60,
    },
    input_downloads: [],
  };
  const control = new RecordingControl(lease);
  const model = new ControlledModel();
  const state = new WorkerStateStore(join(root, ".agent", "session.json"));
  const agent = new WorkerAgent(
    control,
    model,
    state,
    {
      bootstrapToken: "bootstrap_agent_contract",
      provider: "reference",
      region: "region_contract",
      providerInstanceId: "instance_agent_contract",
      replicaId: "replica_agent_contract",
      poolId: "pool_agent_contract",
      releaseId: "release_agent_contract",
      instanceFingerprint: "fingerprint_agent_contract",
      gpuSku: "contract-gpu",
      gpuCount: 1,
      gpuMemoryBytes: 1024,
      workRoot: root,
      idlePollMilliseconds: 5,
    },
    { info() {}, warn() {}, error() {} },
  );
  return { root, control, model, state, agent };
}

describe("Worker Agent control contract", () => {
  test("restores a persisted session and reports a recovered execution failure", async () => {
    const testContext = await context();
    await testContext.state.save({
      worker_id: "worker_agent_contract",
      token: "persisted_worker_token_agent_contract_123456",
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
      sequence: 7,
    });
    testContext.model.statusValue = {
      execution_id: "execution_agent_contract",
      status: "failed",
      error: { code: "model_contract_failure", message: "contract failure", retryable: false },
    };
    await testContext.agent.initialize();
    const abort = new AbortController();
    const running = testContext.agent.run(abort.signal);
    await waitFor(() => testContext.control.failInputs.length === 1);
    abort.abort();
    await running;
    expect(testContext.control.registerCalls).toBe(0);
    expect(testContext.control.failInputs[0]?.error.code).toBe("model_execution_failed");
  });

  test("propagates a control-plane cancellation to the Model App exactly once", async () => {
    const testContext = await context();
    testContext.control.cancelOnHeartbeat = true;
    await testContext.agent.initialize();
    const abort = new AbortController();
    const running = testContext.agent.run(abort.signal);
    await waitFor(() => testContext.control.failInputs[0]?.error.code === "canceled", 4000);
    abort.abort();
    await running;
    expect(testContext.model.cancelCalls).toBe(1);
    expect(testContext.control.failInputs[0]?.error.retryable).toBe(false);
  });

  test("drains only after the active execution reaches a terminal state", async () => {
    const testContext = await context();
    testContext.control.afterHeartbeat = (count) => {
      if (count < 2) return;
      testContext.control.desiredState = "drain";
      testContext.model.statusValue = {
        execution_id: "execution_agent_contract",
        status: "failed",
        error: { code: "model_contract_failure", message: "contract terminal", retryable: false },
      };
    };
    await testContext.agent.initialize();
    await testContext.agent.run(new AbortController().signal);
    expect(testContext.control.failInputs).toHaveLength(1);
    expect(testContext.control.drainedInputs).toHaveLength(1);
    expect(testContext.control.drainedInputs[0]?.active_attempt_ids).toEqual([]);
    expect(testContext.model.cancelCalls).toBe(0);
  });
});
