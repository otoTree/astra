import {
  capabilitiesSchema,
  modelSmokeRequestSchema,
  modelSmokeResponseSchema,
  modelExecutionViewSchema,
  type Capabilities,
  type InferenceRequest,
  type ModelExecutionView,
  type ModelSmokeRequest,
  type ModelSmokeResponse,
} from "@astra/contracts";

export class ModelAppClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMilliseconds = 30_000,
  ) {}

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMilliseconds);
  }

  async live(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/health/live`, { signal: this.signal() });
    return response.ok;
  }

  async ready(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/health/ready`, { signal: this.signal() });
    return response.ok;
  }

  async capabilities(): Promise<Capabilities> {
    const response = await fetch(`${this.baseUrl}/v1/capabilities`, { signal: this.signal() });
    if (!response.ok) throw new Error(`model_app_capabilities:${response.status}`);
    return capabilitiesSchema.parse(await response.json());
  }

  async smoke(input: ModelSmokeRequest): Promise<ModelSmokeResponse> {
    const body = modelSmokeRequestSchema.parse(input);
    const response = await fetch(`${this.baseUrl}/v1/validation/smoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: this.signal(),
    });
    if (!response.ok) throw new Error(`model_app_smoke:${response.status}`);
    return modelSmokeResponseSchema.parse(await response.json());
  }

  async accept(request: InferenceRequest): Promise<ModelExecutionView> {
    const response = await fetch(`${this.baseUrl}/v1/inferences`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: this.signal(),
    });
    if (!response.ok) throw new Error(`model_app_accept:${response.status}`);
    return modelExecutionViewSchema.parse(await response.json());
  }

  async status(executionId: string): Promise<ModelExecutionView> {
    const response = await fetch(`${this.baseUrl}/v1/inferences/${encodeURIComponent(executionId)}`, {
      signal: this.signal(),
    });
    if (!response.ok) throw new Error(`model_app_status:${response.status}`);
    return modelExecutionViewSchema.parse(await response.json());
  }

  async cancel(executionId: string, reason = "task_canceled"): Promise<ModelExecutionView> {
    const response = await fetch(`${this.baseUrl}/v1/inferences/${encodeURIComponent(executionId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason, grace_period_seconds: 30 }),
      signal: this.signal(),
    });
    if (!response.ok) throw new Error(`model_app_cancel:${response.status}`);
    return modelExecutionViewSchema.parse(await response.json());
  }
}
