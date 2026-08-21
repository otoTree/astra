import { z } from "zod";

export const errorEnvelopeSchema = z.object({
  error: z.object({
    type: z.string(),
    code: z.string(),
    message: z.string(),
    param: z.string().optional(),
    retryable: z.boolean(),
    request_id: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function errorResponse(
  requestId: string,
  status: number,
  code: string,
  message: string,
  retryable = false,
  param?: string,
  headers?: HeadersInit,
): Response {
  const type =
    status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status === 409
            ? "conflict_error"
            : status === 429
              ? "rate_limit_error"
              : status >= 500
                ? "server_error"
                : "invalid_request_error";
  const body: ErrorEnvelope = {
    error: {
      type,
      code,
      message,
      retryable,
      request_id: requestId,
      ...(param === undefined ? {} : { param }),
    },
  };
  return Response.json(body, {
    status,
    headers: { "X-Request-Id": requestId, ...Object.fromEntries(new Headers(headers)) },
  });
}
