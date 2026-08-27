import { ProviderError, type ProviderErrorCode } from "@astra/provider-core";

const authenticationCodes = new Set(["A003", "C001", "C002", "C004", "C005", "C006", "C007"]);
const rateLimitCodes = new Set(["C008", "C009"]);

export const mapGongjiError = (providerCode: string, httpStatus: number, retryAfterSeconds?: number): ProviderError => {
  let code: ProviderErrorCode = "provider_unavailable";
  let retryable = true;
  if (httpStatus === 401 || httpStatus === 403 || authenticationCodes.has(providerCode)) {
    code = "authentication_failed";
    retryable = false;
  } else if (httpStatus === 429 || rateLimitCodes.has(providerCode)) {
    code = "rate_limited";
  } else if (httpStatus === 404) {
    code = "resource_not_found";
    retryable = false;
  } else if (httpStatus === 409 || providerCode === "C010") {
    code = "operation_conflict";
    retryable = false;
  } else if (httpStatus >= 400 && httpStatus < 500) {
    code = "invalid_provider_response";
    retryable = false;
  }
  return new ProviderError(code, retryable, retryAfterSeconds);
};

export const retryAfterSeconds = (headers: Headers): number | undefined => {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isInteger(seconds) && seconds >= 0) return seconds;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
};
