import { z } from "zod";

export const adminRoleSchema = z.enum(["viewer", "operator", "model_releaser", "security_auditor", "admin"]);

export const versionedMutationSchema = z
  .object({
    expected_version: z.number().int().nonnegative(),
    reason: z.string().min(8).max(1000),
  })
  .strict();

export const releaseCreateSchema = z
  .object({
    model_id: z.string().min(1),
    source_image: z.string().min(1),
    workflow_hash: z.string().regex(/^[0-9a-f]{64}$/),
    manifest: z.record(z.string(), z.unknown()),
    reason: z.string().min(8).max(1000),
  })
  .strict();

export const policyValidationSchema = z
  .object({
    policy_type: z.enum(["capacity", "budget", "region", "retry"]),
    pool_id: z.string().min(1),
    configuration: z.record(z.string(), z.unknown()),
  })
  .strict();

export const rolloutCreateSchema = z
  .object({
    release_id: z.string().min(1),
    pool_id: z.string().min(1),
    preview_id: z.string().min(1),
    expected_pool_version: z.number().int().nonnegative(),
    reason: z.string().min(8).max(1000),
  })
  .strict();
