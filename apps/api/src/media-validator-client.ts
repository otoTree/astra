import { mediaValidationResponseSchema, type MediaMetadata, type MediaValidationRequest } from "@astra/contracts";

export interface MediaValidator {
  validate(request: MediaValidationRequest): Promise<MediaMetadata>;
}

export class MediaValidatorError extends Error {
  constructor(
    readonly kind: "rejected" | "unavailable",
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(kind === "rejected" ? "media_validation_failed" : "media_validator_unavailable");
    this.name = "MediaValidatorError";
  }
}

export class MediaValidatorClient implements MediaValidator {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly timeoutMilliseconds = 10 * 60 * 1000,
  ) {}

  async validate(request: MediaValidationRequest): Promise<MediaMetadata> {
    let response: Response;
    try {
      response = await fetch(new URL("/internal/v1/media/validate", this.endpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch {
      throw new MediaValidatorError("unavailable", true, 503);
    }
    if (!response.ok) {
      if (response.status === 422) throw new MediaValidatorError("rejected", false, response.status);
      throw new MediaValidatorError("unavailable", response.status === 429 || response.status >= 500, response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MediaValidatorError("unavailable", true, 502);
    }
    const parsed = mediaValidationResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.file_id !== request.file_id) {
      throw new MediaValidatorError("unavailable", true, 502);
    }
    return parsed.data.media;
  }
}
