import type { ProviderOperationClaim, ProviderOperationRepository } from "@astra/database";
import { ProviderError, type ProviderResourceOperator } from "@astra/provider-core";

export type ProviderOperationCycle = Readonly<{
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  staleLeases: number;
  reactivated: number;
}>;

export class ProviderOperationReconciler {
  constructor(
    private readonly repository: ProviderOperationRepository,
    private readonly operators: Readonly<Record<string, ProviderResourceOperator>>,
    private readonly provider: string,
    private readonly owner: string,
    private readonly leaseSeconds: number,
    private readonly operationTimeoutSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(limit: number): Promise<ProviderOperationCycle> {
    const reactivated = await this.repository.reactivateSuppressed(this.provider, limit);
    const claims = await this.repository.claim(this.owner, this.provider, limit, this.leaseSeconds);
    const result = { claimed: claims.length, succeeded: 0, retrying: 0, failed: 0, staleLeases: 0, reactivated };
    for (const claim of claims) {
      const outcome = await this.execute(claim);
      result[outcome] += 1;
    }
    return result;
  }

  private async execute(claim: ProviderOperationClaim): Promise<"succeeded" | "retrying" | "failed" | "staleLeases"> {
    const operator = this.operators[claim.provider];
    if (!operator) {
      const outcome = await this.repository.fail(claim, { code: "provider_driver_unavailable", retryable: false });
      return outcome === "stale_lease" ? "staleLeases" : outcome;
    }
    const context = {
      operationId: claim.operationKey,
      requestId: claim.id,
      deadlineAt: new Date(this.now().getTime() + this.operationTimeoutSeconds * 1000),
    };
    try {
      if (claim.operationType === "prewarm") {
        const value = await operator.prewarmImage(
          {
            imageDigest: claim.payload.image_digest as string,
            ...(claim.payload.image_reference ? { imageReference: claim.payload.image_reference } : {}),
            region: claim.payload.region as string,
            gpuSku: claim.payload.gpu_sku as string,
            ...(claim.payload.environment ? { environment: claim.payload.environment } : {}),
          },
          context,
        );
        const persisted = await this.repository.succeed(claim, {
          providerResourceId: value.id,
          providerState: value.state,
          response: { resource_id: value.id, state: value.state },
        });
        return persisted ? "succeeded" : "staleLeases";
      }
      if (claim.operationType === "provision") {
        const value = await operator.provisionReplica(
          {
            imageDigest: claim.payload.image_digest as string,
            ...(claim.payload.image_reference ? { imageReference: claim.payload.image_reference } : {}),
            region: claim.payload.region as string,
            gpuSku: claim.payload.gpu_sku as string,
          },
          context,
        );
        const persisted = await this.repository.succeed(claim, {
          providerResourceId: value.id,
          providerState: value.state,
          response: { resource_id: value.id, state: value.state },
        });
        return persisted ? "succeeded" : "staleLeases";
      }
      const providerResourceId = claim.payload.provider_resource_id as string;
      if (claim.operationType === "drain") {
        await operator.drainReplica(providerResourceId, context);
        const observed = await operator.observeReplica(providerResourceId, context);
        const persisted = await this.repository.succeed(claim, {
          providerResourceId,
          providerState: observed.state,
          response: { resource_id: providerResourceId, state: observed.state },
        });
        return persisted ? "succeeded" : "staleLeases";
      }
      await operator.terminateReplica(providerResourceId, context);
      const observed = await operator.observeReplica(providerResourceId, context);
      const persisted = await this.repository.succeed(claim, {
        providerResourceId,
        providerState: observed.state,
        response: { resource_id: providerResourceId, state: observed.state },
      });
      return persisted ? "succeeded" : "staleLeases";
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : new ProviderError("provider_unavailable", true);
      const outcome = await this.repository.fail(claim, {
        code: providerError.code,
        retryable: providerError.retryable,
        ...(providerError.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: providerError.retryAfterSeconds }
          : {}),
      });
      return outcome === "stale_lease" ? "staleLeases" : outcome;
    }
  }
}
