import { createHash } from "node:crypto";
import {
  ProviderError,
  type ProviderImageWarmup,
  type ProviderOperationContext,
  type ProviderReplica,
  type ProviderResourceOperator,
} from "@astra/provider-core";

const stableId = (prefix: string, operationId: string): string =>
  `${prefix}_${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;

export class ReferenceProviderOperator implements ProviderResourceOperator {
  readonly replicas = new Map<string, ProviderReplica>();
  readonly warmups = new Map<string, ProviderImageWarmup>();
  private readonly operations = new Map<string, Readonly<{ hash: string; resourceId: string }>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private ensureDeadline(context: ProviderOperationContext): void {
    if (this.now() >= context.deadlineAt) throw new ProviderError("operation_timeout", true);
  }

  private operationResource(operationId: string, input: unknown, prefix: string): string {
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = this.operations.get(operationId);
    if (existing) {
      if (existing.hash !== hash) throw new ProviderError("operation_conflict", false);
      return existing.resourceId;
    }
    const resourceId = stableId(prefix, operationId);
    this.operations.set(operationId, { hash, resourceId });
    return resourceId;
  }

  async prewarmImage(
    input: Readonly<{ imageDigest: string; imageReference?: string; region: string; gpuSku: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderImageWarmup> {
    this.ensureDeadline(context);
    const id = this.operationResource(context.operationId, input, "warmup");
    const existing = this.warmups.get(id);
    if (existing) return existing;
    const value: ProviderImageWarmup = {
      id,
      imageDigest: input.imageDigest,
      region: input.region,
      gpuSku: input.gpuSku,
      state: "ready",
    };
    this.warmups.set(id, value);
    return value;
  }

  async provisionReplica(
    input: Readonly<{ imageDigest: string; imageReference?: string; region: string; gpuSku: string }>,
    context: ProviderOperationContext,
  ): Promise<ProviderReplica> {
    this.ensureDeadline(context);
    const id = this.operationResource(context.operationId, input, "instance");
    const existing = this.replicas.get(id);
    if (existing) return existing;
    const value: ProviderReplica = {
      id,
      provider: "reference",
      imageDigest: input.imageDigest,
      region: input.region,
      gpuSku: input.gpuSku,
      state: "ready",
    };
    this.replicas.set(id, value);
    return value;
  }

  async drainReplica(replicaId: string, context: ProviderOperationContext): Promise<void> {
    this.ensureDeadline(context);
    const existing = this.replicas.get(replicaId);
    if (!existing) throw new ProviderError("resource_not_found", false);
    this.replicas.set(replicaId, { ...existing, state: "draining" });
  }

  async terminateReplica(replicaId: string, context: ProviderOperationContext): Promise<void> {
    this.ensureDeadline(context);
    const existing = this.replicas.get(replicaId);
    if (!existing) return;
    this.replicas.set(replicaId, { ...existing, state: "terminated" });
  }

  async observeReplica(
    replicaId: string,
    context: ProviderOperationContext,
  ): Promise<Readonly<{ id: string; state: ProviderReplica["state"] }>> {
    this.ensureDeadline(context);
    const existing = this.replicas.get(replicaId);
    if (!existing) throw new ProviderError("resource_not_found", false);
    return { id: existing.id, state: existing.state };
  }
}
