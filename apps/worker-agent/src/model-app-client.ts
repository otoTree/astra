import {
  capabilitiesSchema,
  executionViewSchema,
  type Capabilities,
  type InferenceRequest,
  type ExecutionView,
} from "@astra/contracts";

export class ModelAppClient {
  constructor(private readonly baseUrl: string) {}

  async live(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/health/live`);
    return response.ok;
  }

  async capabilities(): Promise<Capabilities> {
    const response = await fetch(`${this.baseUrl}/v1/capabilities`);
    if (!response.ok) throw new Error(`model_app_capabilities:${response.status}`);
    return capabilitiesSchema.parse(await response.json());
  }

  async accept(request: InferenceRequest): Promise<{ execution_id: string; status: string }> {
    const response = await fetch(`${this.baseUrl}/v1/inferences`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`model_app_accept:${response.status}`);
    return (await response.json()) as { execution_id: string; status: string };
  }

  async status(executionId: string): Promise<ExecutionView> {
    const response = await fetch(`${this.baseUrl}/v1/inferences/${encodeURIComponent(executionId)}`);
    if (!response.ok) throw new Error(`model_app_status:${response.status}`);
    return executionViewSchema.parse(await response.json());
  }

  async cancel(executionId: string, reason = "task_canceled"): Promise<ExecutionView> {
    const response = await fetch(`${this.baseUrl}/v1/inferences/${encodeURIComponent(executionId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason, grace_period_seconds: 30 }),
    });
    if (!response.ok) throw new Error(`model_app_cancel:${response.status}`);
    return executionViewSchema.parse(await response.json());
  }
}
