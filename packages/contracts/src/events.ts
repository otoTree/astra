import { z } from "zod";

export const eventEnvelopeSchema = z
  .object({
    event_id: z.string().min(1),
    event_type: z.string().min(1),
    event_version: z.literal(1),
    producer: z.string().min(1),
    aggregate_type: z.string().min(1),
    aggregate_id: z.string().min(1),
    aggregate_version: z.number().int().nonnegative(),
    organization_id: z.string().min(1).optional(),
    project_id: z.string().min(1).optional(),
    occurred_at: z.string().datetime({ offset: true }),
    trace_id: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
